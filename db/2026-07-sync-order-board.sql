-- 2026-07 · Push confirmed sales lines that are missing from the Order Board
-- ----------------------------------------------------------------------------
-- Confirming a sales document (confirm_document_factory) creates a production
-- batch for each line at that moment. If lines are ADDED to the document after
-- it was confirmed, they never get a batch, so the Order Board shows fewer items
-- than the SO (e.g. SO has 4 items, board shows only the 2 that existed at
-- confirm time). Re-confirming isn't possible once a factory is confirmed.
--
-- This adds an ADDITIVE, idempotent repair: for a document, create a Planned
-- batch for every line whose factory is already confirmed but which has NO
-- production batch yet. It NEVER touches or duplicates existing batches (it only
-- creates for lines with none), and it mirrors exactly how batches are built
-- elsewhere (see approve_repack_order): status 'Planned', a production_batch_items
-- row carrying the SO number so the line traces back on the board.
--
-- Run this in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function public.sync_confirmed_to_production(p_import_id uuid)
  returns integer
  language plpgsql security definer set search_path = public as $$
declare r record; v_b uuid; v_count int := 0;
begin
  if not has_perm('sales', 'edit') then
    raise exception 'Not allowed';
  end if;

  for r in
    select l.*
      from public.sales_order_lines l
      join public.document_confirmations dc
        on dc.import_id = l.import_id and dc.factory_code = l.factory_code
     where l.import_id = p_import_id
       and coalesce(l.factory_code, '') <> ''
       and coalesce(l.quantity, 0) > 0
       -- only lines that are NOT already on the board (no matching batch)
       and not exists (
         select 1
           from public.production_batch_items bi
           join public.production_batches b on b.id = bi.batch_id
          where bi.so_number = l.so_number
            and b.item_code = l.item_code
            and b.factory_code = l.factory_code
       )
  loop
    insert into public.production_batches
      (batch_no, item_code, description, delivery_date, factory_code, total_quantity, status, run_mode)
    values
      ('PB-' || lpad(nextval('public.production_batch_seq')::text, 5, '0'),
       r.item_code, r.description, r.delivery_date, r.factory_code, r.quantity, 'Planned', 'auto')
    returning id into v_b;

    insert into public.production_batch_items
      (batch_id, so_number, customer_name, quantity, factory_code)
    values
      (v_b, r.so_number, r.customer_name, r.quantity, r.factory_code);

    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;
grant execute on function public.sync_confirmed_to_production(uuid) to authenticated;
