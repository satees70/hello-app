-- ============================================================================
-- AVINA Portal — database changes log
-- ----------------------------------------------------------------------------
-- A running record of the schema changes (columns, tables, functions) applied
-- in Supabase, so they're tracked in the repo instead of scattered "Untitled
-- query" snippets. Newest sections at the bottom. Everything here is already
-- applied to the live database — this file is the documented record, and lets
-- you recreate the current state on a fresh database if ever needed.
--
-- Add a new section here whenever a DB change is made.
-- ============================================================================

-- ============================================================================
-- BOM main ingredient + packing-line letter + food-loss alerts (inspection)
-- ============================================================================
alter table public.bom_components add column if not exists main_ingredient boolean not null default false;
alter table public.packing_lines add column if not exists line_code text;

create table if not exists public.food_loss_alerts (
  id uuid primary key default gen_random_uuid(),
  production_batch_id uuid, factory_code text, batch_no text, item_code text, pct numeric,
  status text not null default 'Pending',
  created_by uuid, created_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
grant select, insert on public.food_loss_alerts to authenticated;
grant all on public.food_loss_alerts to service_role;
alter table public.food_loss_alerts enable row level security;
drop policy if exists fla_read on public.food_loss_alerts;
create policy fla_read on public.food_loss_alerts for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or created_by = auth.uid());
drop policy if exists fla_insert on public.food_loss_alerts;
create policy fla_insert on public.food_loss_alerts for insert with check (created_by = auth.uid());

create or replace function public.ack_food_loss(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can acknowledge food-loss alerts'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.food_loss_alerts set status = 'Acknowledged', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.ack_food_loss(uuid) to authenticated;

-- ============================================================================
-- Auth · username login + warehouse-only material-requests view
-- ============================================================================
alter table public.profiles add column if not exists username text;
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username)) where username is not null;
alter table public.profiles add column if not exists warehouse_user boolean not null default false;
-- Fine-grained capability toggles (e.g. so_edit, move_received_qty, request_*) — empty = all allowed
alter table public.profiles add column if not exists capabilities jsonb not null default '{}'::jsonb;
-- Per-location permission overrides: { "AVINA101": { sales:{view,edit,delete}, ... } }; empty = use the default grid
alter table public.profiles add column if not exists location_perms jsonb not null default '{}'::jsonb;


-- ============================================================================
-- Factory labels · printer attaches a photo & sends; sending receives into stock
-- ============================================================================
alter table public.material_request_items add column if not exists label_photo_path text;
alter table public.material_request_items add column if not exists label_sent_at timestamptz;
alter table public.material_request_items add column if not exists label_received_at timestamptz;

-- Printer SENDS the printed labels (needs a saved print qty + a photo). No stock yet.
create or replace function public.send_labels(p_item_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare it record;
begin
  if array_length(p_item_ids, 1) is null then raise exception 'No labels selected'; end if;
  for it in
    select mri.*, mr.factory_code as fac
    from public.material_request_items mri
    join public.material_requests mr on mr.id = mri.request_id
    where mri.id = any (p_item_ids)
  loop
    if my_factory_code() <> 'HEAD_OFFICE' and not (it.fac = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
    if it.label_sent_at is not null then continue; end if;
    if it.label_photo_path is null then raise exception 'Attach a photo for % before sending', it.item_code; end if;
    if coalesce(it.label_print_qty, 0) <= 0 then raise exception 'Enter a print quantity for % before sending', it.item_code; end if;
    update public.material_request_items set label_sent_at = now() where id = it.id;
  end loop;
end $$;
grant execute on function public.send_labels(uuid[]) to authenticated;

-- Requesting location RECEIVES the labels: books them into stock and completes the line.
create or replace function public.receive_labels(p_item_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare it record; v_item_id uuid; v_qty numeric;
begin
  if array_length(p_item_ids, 1) is null then raise exception 'No labels selected'; end if;
  for it in
    select mri.*, mr.factory_code as fac
    from public.material_request_items mri
    join public.material_requests mr on mr.id = mri.request_id
    where mri.id = any (p_item_ids)
  loop
    if my_factory_code() <> 'HEAD_OFFICE' and not (it.fac = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
    if it.label_received_at is not null then continue; end if;                       -- already received
    if it.label_sent_at is null then raise exception 'Label % has not been sent yet', it.item_code; end if;
    v_qty := coalesce(it.label_print_qty, 0);
    if v_qty <= 0 then raise exception 'No print quantity for %', it.item_code; end if;
    v_item_id := coalesce(it.item_id, (select id from public.items where code = it.item_code limit 1));
    if v_item_id is null then raise exception 'Item % is not in the Items master', it.item_code; end if;
    insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, request_item_id)
    values (v_item_id, it.item_code, it.description, it.fac, nullif(it.label_batch_no, ''), nullif(it.label_exp_date::text, '')::date, v_qty, v_qty, it.id);
    update public.material_request_items set received_qty = received_qty + v_qty, label_received_at = now() where id = it.id;
    insert into public.item_stock (item_id, factory_code, quantity, updated_at)
    values (v_item_id, it.fac, v_qty, now())
    on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + v_qty, updated_at = now();
    update public.material_requests set status =
      case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = it.request_id) then 'Fulfilled'
           when (select bool_or(received_qty > 0) from public.material_request_items where request_id = it.request_id) then 'Partially Received'
           else 'Open' end
    where id = it.request_id;
  end loop;
end $$;
grant execute on function public.receive_labels(uuid[]) to authenticated;

-- ============================================================================
-- Goods Received · per-line partial receiving bookkeeping
-- (was written by the app since commit 2b78342 but not recorded here — without
--  these columns the "mark line received" update fails and receiving appears broken)
-- ============================================================================
alter table public.delivery_order_lines add column if not exists received_qty numeric;
alter table public.delivery_order_lines add column if not exists stock_lot_id uuid;
-- The warehouse DO prints the pick-run number and SO number it fulfils — capture them to link back
alter table public.delivery_orders add column if not exists so_number text;
alter table public.delivery_orders add column if not exists pick_run_no text;


-- ============================================================================
-- Sales Orders · staff can request to delete a whole document; HO approves
-- ============================================================================
create table if not exists public.doc_delete_requests (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references public.sales_imports(id) on delete set null,
  file_name text, file_path text, factory_code text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
grant select, insert on public.doc_delete_requests to authenticated;
grant all on public.doc_delete_requests to service_role;
alter table public.doc_delete_requests enable row level security;
drop policy if exists ddr_read on public.doc_delete_requests;
create policy ddr_read on public.doc_delete_requests for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists ddr_insert on public.doc_delete_requests;
create policy ddr_insert on public.doc_delete_requests for insert with check (requested_by = auth.uid());

-- HO approves: deletes the sales import (cascades lines/change-requests) and returns
-- the storage path so the caller can remove the PDF. The request row stays as an
-- audit record (import_id becomes null via the FK's on-delete-set-null).
create or replace function public.approve_doc_delete(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text; v_import uuid; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve document deletions'; end if;
  select file_path, import_id into v_path, v_import from public.doc_delete_requests where id = p_id and status = 'Pending';
  if not found then raise exception 'Request not found or already reviewed'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.doc_delete_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
  if v_import is not null then delete from public.sales_imports where id = v_import; end if;
  return v_path;
end $$;
grant execute on function public.approve_doc_delete(uuid) to authenticated;

create or replace function public.reject_doc_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject document deletions'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.doc_delete_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_doc_delete(uuid) to authenticated;


-- ============================================================================
-- Delivery Orders · ONE consolidated DO holding finished goods + raw returns
-- ============================================================================
alter table public.material_returns add column if not exists dispatch_id uuid references public.dispatch_orders(id) on delete set null;
alter table public.material_returns add column if not exists lot_id uuid;   -- the stock lot the return drew from (for exact later edits)

-- p_batch_ids: completed production batches to send (finished goods)
-- p_returns:   jsonb array of { lot_id, qty, reason } raw-material batches to return
-- Everything must be one factory. DO number: DO<factory digits>-<YYMM>/<NNNN>.
create or replace function public.create_delivery_order(p_batch_ids uuid[], p_returns jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_fac text; v_dig text; v_no text; v_id uuid; v_name text; v_seq int;
        b record; r jsonb; v_lot public.stock_lots; v_item public.items; v_qty numeric;
        v_has_batches boolean; v_has_returns boolean;
begin
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed to create delivery orders'; end if;
  v_has_batches := p_batch_ids is not null and array_length(p_batch_ids, 1) is not null;
  v_has_returns := p_returns is not null and jsonb_array_length(p_returns) > 0;
  if not v_has_batches and not v_has_returns then raise exception 'Add at least one item to the delivery order'; end if;

  -- Work out the factory and make sure everything belongs to it.
  if v_has_batches then select factory_code into v_fac from public.production_batches where id = p_batch_ids[1]; end if;
  if v_fac is null and v_has_returns then select factory_code into v_fac from public.stock_lots where id = (p_returns->0->>'lot_id')::uuid; end if;
  if v_fac is null then raise exception 'Could not work out the factory for this delivery order'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and exists (select 1 from public.profiles where id = auth.uid() and v_fac = any (readonly_factories))
    then raise exception 'You have view-only access at this factory'; end if;
  if v_has_batches and exists (select 1 from public.production_batches where id = any (p_batch_ids) and factory_code <> v_fac)
    then raise exception 'All finished goods must be from the same factory'; end if;

  v_dig := coalesce(nullif(regexp_replace(v_fac, '[^0-9]', '', 'g'), ''), v_fac);
  select count(*) + 1 into v_seq from public.dispatch_orders where factory_code = v_fac and to_char(created_at, 'YYMM') = to_char(now(), 'YYMM');
  v_no := 'DO' || v_dig || '-' || to_char(now(), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.dispatch_orders (do_number, factory_code, created_by, created_by_name)
  values (v_no, v_fac, auth.uid(), v_name) returning id into v_id;

  -- Finished goods: a DO line per batch; the batch leaves the production area.
  if v_has_batches then
    for b in select * from public.production_batches where id = any (p_batch_ids) and dispatched_at is null loop
      insert into public.dispatch_order_lines (dispatch_id, batch_id, item_code, description, quantity)
      values (v_id, b.id, b.item_code, b.description, b.produced_qty);
      update public.production_batches set dispatched_at = now() where id = b.id;
    end loop;
  end if;

  -- Raw returns: reduce the specific batch's stock now, recorded against this DO.
  if v_has_returns then
    for r in select value from jsonb_array_elements(p_returns) as e(value) loop
      select * into v_lot from public.stock_lots where id = (r->>'lot_id')::uuid and factory_code = v_fac;
      if not found then raise exception 'A returned material batch was not found at this factory'; end if;
      v_qty := (r->>'qty')::numeric;
      if v_qty is null or v_qty <= 0 then raise exception 'Return quantity must be greater than zero'; end if;
      if v_qty > v_lot.qty_remaining then raise exception 'Not enough in batch % — only % left', coalesce(v_lot.batch_no, '(no batch)'), v_lot.qty_remaining; end if;
      select * into v_item from public.items where code = v_lot.item_code limit 1;
      update public.stock_lots set qty_remaining = qty_remaining - v_qty where id = v_lot.id;
      if found and v_item.id is not null then
        update public.item_stock set quantity = quantity - v_qty, updated_at = now() where item_id = v_item.id and factory_code = v_fac;
      end if;
      insert into public.material_returns (factory_code, item_code, description, batch_no, quantity, reason, dispatch_id, lot_id, created_by, created_by_name)
      values (v_fac, v_lot.item_code, v_item.description, v_lot.batch_no, v_qty, nullif(r->>'reason', ''), v_id, v_lot.id, auth.uid(), v_name);
    end loop;
  end if;

  return v_no;
end $$;
grant execute on function public.create_delivery_order(uuid[], jsonb) to authenticated;


-- ============================================================================
-- Material requests · move received qty from one request to another (HO approval)
-- (same material; e.g. when received stock was booked against the wrong request)
-- ============================================================================
create table if not exists public.mr_qty_move_requests (
  id uuid primary key default gen_random_uuid(),
  from_item_id uuid references public.material_request_items(id) on delete cascade,
  to_item_id uuid references public.material_request_items(id) on delete cascade,
  factory_code text, item_code text, qty numeric, reason text, from_label text, to_label text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
grant select, insert on public.mr_qty_move_requests to authenticated;
grant all on public.mr_qty_move_requests to service_role;
alter table public.mr_qty_move_requests enable row level security;
drop policy if exists mqm_read on public.mr_qty_move_requests;
create policy mqm_read on public.mr_qty_move_requests for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists mqm_insert on public.mr_qty_move_requests;
create policy mqm_insert on public.mr_qty_move_requests for insert with check (requested_by = auth.uid() and has_perm('material_requests', 'edit'));

create or replace function public.recompute_mr_status(p_request_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.material_requests set status =
    case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = p_request_id) then 'Fulfilled'
         when (select bool_or(received_qty > 0) from public.material_request_items where request_id = p_request_id) then 'Partially Received'
         else 'Open' end
  where id = p_request_id and released_at is not null;   -- don't touch unreleased drafts
end $$;

create or replace function public.approve_mr_qty_move(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_req public.mr_qty_move_requests; v_from public.material_request_items; v_to public.material_request_items; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve quantity moves'; end if;
  select * into v_req from public.mr_qty_move_requests where id = p_id and status = 'Pending';
  if not found then raise exception 'Request not found or already reviewed'; end if;
  select * into v_from from public.material_request_items where id = v_req.from_item_id;
  select * into v_to from public.material_request_items where id = v_req.to_item_id;
  if not found or v_from.id is null then raise exception 'A request line no longer exists'; end if;
  if v_req.qty > v_from.received_qty then raise exception 'Cannot move % — only % received on the source', v_req.qty, v_from.received_qty; end if;
  update public.material_request_items set received_qty = received_qty - v_req.qty where id = v_from.id;
  update public.material_request_items set received_qty = received_qty + v_req.qty where id = v_to.id;
  perform public.recompute_mr_status(v_from.request_id);
  perform public.recompute_mr_status(v_to.request_id);
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_qty_move_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_mr_qty_move(uuid) to authenticated;

create or replace function public.reject_mr_qty_move(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject quantity moves'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_qty_move_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_mr_qty_move(uuid) to authenticated;


-- ============================================================================
-- Pick run SO number · lock after set; record who/when; change needs HO approval
-- ============================================================================
alter table public.material_requests add column if not exists warehouse_so_no text;   -- the SO number the warehouse records against a pick run
alter table public.material_requests add column if not exists so_set_by uuid;
alter table public.material_requests add column if not exists so_set_by_name text;
alter table public.material_requests add column if not exists so_set_at timestamptz;

create table if not exists public.so_change_requests (
  id uuid primary key default gen_random_uuid(),
  pick_run_no text, factory_code text, old_so text, new_so text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
grant select, insert on public.so_change_requests to authenticated;
grant all on public.so_change_requests to service_role;
alter table public.so_change_requests enable row level security;
drop policy if exists socr_read on public.so_change_requests;
create policy socr_read on public.so_change_requests for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists socr_insert on public.so_change_requests;
create policy socr_insert on public.so_change_requests for insert with check (requested_by = auth.uid() and has_perm('material_requests', 'edit'));

create or replace function public.approve_so_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_req public.so_change_requests; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve SO changes'; end if;
  select * into v_req from public.so_change_requests where id = p_id and status = 'Pending';
  if not found then raise exception 'Request not found or already reviewed'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_requests set warehouse_so_no = v_req.new_so, so_set_by = auth.uid(), so_set_by_name = v_name, so_set_at = now()
    where pick_run_no = v_req.pick_run_no and factory_code = v_req.factory_code;
  update public.so_change_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_so_change(uuid) to authenticated;

create or replace function public.reject_so_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject SO changes'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.so_change_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_so_change(uuid) to authenticated;


-- ============================================================================
-- Items master · staff request field edits (single or bulk); Head Office approves
-- ============================================================================
create table if not exists public.item_change_requests (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.items(id) on delete cascade,
  item_code text, field text, old_value text, new_value text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
grant select, insert on public.item_change_requests to authenticated;
grant all on public.item_change_requests to service_role;
alter table public.item_change_requests enable row level security;
drop policy if exists icr_read on public.item_change_requests;
create policy icr_read on public.item_change_requests for select using (true);   -- items are company-wide
drop policy if exists icr_insert on public.item_change_requests;
create policy icr_insert on public.item_change_requests for insert with check (requested_by = auth.uid() and has_perm('items', 'edit'));

-- Code is never changed here (it's referenced across documents). Only these fields.
create or replace function public.approve_item_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_req public.item_change_requests; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve item changes'; end if;
  select * into v_req from public.item_change_requests where id = p_id and status = 'Pending';
  if not found then raise exception 'Request not found or already reviewed'; end if;
  if v_req.field = any (array['description', 'unit', 'type', 'stock_group']) then
    execute format('update public.items set %I = $1 where id = $2', v_req.field) using nullif(v_req.new_value, ''), v_req.item_id;
  elsif v_req.field = 'supplied_by_factory' then
    update public.items set supplied_by_factory = (lower(coalesce(v_req.new_value, '')) in ('true', 't', 'yes', '1')) where id = v_req.item_id;
  elsif v_req.field = any (array['kg_per_bag', 'pcs_per_roll']) then
    execute format('update public.items set %I = $1 where id = $2', v_req.field) using nullif(v_req.new_value, '')::numeric, v_req.item_id;
  else
    raise exception 'Field % cannot be edited', v_req.field;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.item_change_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_item_change(uuid) to authenticated;

create or replace function public.reject_item_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject item changes'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.item_change_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_item_change(uuid) to authenticated;


-- ============================================================================
-- Material returns · edit quantity/reason with Head Office approval
-- (approving adjusts the lot's stock by the quantity difference)
-- ============================================================================
create table if not exists public.return_edit_requests (
  id uuid primary key default gen_random_uuid(),
  return_id uuid references public.material_returns(id) on delete cascade,
  factory_code text, item_code text, batch_no text,
  old_qty numeric, new_qty numeric, old_reason text, new_reason text,
  reason text,                       -- why the edit is requested
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
grant select, insert on public.return_edit_requests to authenticated;
grant all on public.return_edit_requests to service_role;
alter table public.return_edit_requests enable row level security;
drop policy if exists rer_read on public.return_edit_requests;
create policy rer_read on public.return_edit_requests for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists rer_insert on public.return_edit_requests;
create policy rer_insert on public.return_edit_requests for insert with check (requested_by = auth.uid());

create or replace function public.approve_return_edit(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_req public.return_edit_requests; v_ret public.material_returns; v_lot public.stock_lots; v_item public.items; v_delta numeric; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve return edits'; end if;
  select * into v_req from public.return_edit_requests where id = p_id and status = 'Pending';
  if not found then raise exception 'Request not found or already reviewed'; end if;
  select * into v_ret from public.material_returns where id = v_req.return_id;
  if not found then raise exception 'The material return no longer exists'; end if;
  v_delta := coalesce(v_req.new_qty, v_ret.quantity) - v_ret.quantity;   -- extra to reduce from stock (can be negative)
  if v_delta <> 0 then
    select * into v_lot from public.stock_lots where id = v_ret.lot_id;
    if not found then
      select * into v_lot from public.stock_lots where item_code = v_ret.item_code and factory_code = v_ret.factory_code
        and coalesce(batch_no, '') = coalesce(v_ret.batch_no, '') order by exp_date asc nulls last, received_at asc limit 1;
    end if;
    if not found then raise exception 'Cannot find the stock batch to adjust'; end if;
    if v_delta > v_lot.qty_remaining then raise exception 'Not enough stock to increase the return — only % left in that batch', v_lot.qty_remaining; end if;
    update public.stock_lots set qty_remaining = qty_remaining - v_delta where id = v_lot.id;
    select * into v_item from public.items where code = v_ret.item_code limit 1;
    if found then update public.item_stock set quantity = quantity - v_delta, updated_at = now() where item_id = v_item.id and factory_code = v_ret.factory_code; end if;
  end if;
  update public.material_returns set quantity = coalesce(v_req.new_qty, quantity), reason = v_req.new_reason where id = v_ret.id;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.return_edit_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_return_edit(uuid) to authenticated;

create or replace function public.reject_return_edit(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject return edits'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.return_edit_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_return_edit(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Pick-run release & cut-off (Material Requests → Combined picking)
-- ============================================================================

-- Requests wait until "released" to the warehouse as a fixed, numbered pick run.
alter table material_requests add column if not exists released_at timestamptz;
alter table material_requests add column if not exists pick_run_no text;
create sequence if not exists pick_run_seq;  -- legacy global counter, now unused

-- Release a factory's waiting requests as ONE pick run, numbered PER LOCATION,
-- PER MONTH: PR<digits of factory>-<YYMM>/<NNNN> (e.g. PR101-2606/0001). The
-- running number resets each month. Uses Malaysia time so the month flips local.
create or replace function public.release_pick_run(p_factory text)
returns text language plpgsql security definer set search_path = public as $$
declare v_no text; v_seq int; v_fac text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' and my_factory_code() <> p_factory then
    raise exception 'Not allowed to release for this factory';
  end if;
  if not exists (select 1 from material_requests where factory_code = p_factory and released_at is null) then
    raise exception 'Nothing waiting to release';
  end if;
  v_fac := coalesce(nullif(regexp_replace(p_factory, '[^0-9]', '', 'g'), ''), p_factory);
  select coalesce(max((split_part(pick_run_no, '/', 2))::int), 0) + 1 into v_seq
    from material_requests
   where factory_code = p_factory
     and pick_run_no like 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/%';
  v_no := 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  update material_requests set released_at = now(), pick_run_no = v_no
   where factory_code = p_factory and released_at is null;
  return v_no;
end $$;
grant execute on function public.release_pick_run(text) to authenticated;


-- ============================================================================
-- 2026-06 · Factory-supplied items (labels) & product expiry date
-- ============================================================================

-- Items made/supplied by the factory itself (e.g. printed labels) route to a
-- separate "factory" list instead of the warehouse pick list.
alter table items add column if not exists supplied_by_factory boolean not null default false;

-- Product (packing) expiry date — entered at production, printed on labels.
-- Raw materials never carry an expiry; only the packed product does.
alter table production_batches add column if not exists exp_date date;


-- ============================================================================
-- 2026-06 · Delivery Order bag/carton → KG conversion
-- ============================================================================

-- Optional per-item override for "KG per bag/carton" when the item code doesn't
-- show the pack size (e.g. a typo). Normally read from the code (e.g. 3KG/BAG).
alter table items add column if not exists kg_per_bag numeric;


-- ============================================================================
-- 2026-06 · Receiving moves stock, with batch + expiry lot tracking (FEFO)
-- ============================================================================

-- Each received delivery is recorded as a lot, kept separately for first-expiry-
-- first-out. qty_remaining is for future consumption (not yet decremented).
create table if not exists public.stock_lots (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  item_code text not null,
  description text,
  factory_code text not null,
  batch_no text,
  exp_date date,
  qty_received numeric not null,
  qty_remaining numeric not null,
  request_item_id uuid references public.material_request_items(id) on delete set null,
  unplanned boolean not null default false,   -- received without a matching order
  do_number text,                             -- source Delivery Order number
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists stock_lots_fefo on public.stock_lots (item_id, factory_code, exp_date nulls last);

grant select, insert, update, delete on public.stock_lots to authenticated, anon, service_role;
alter table public.stock_lots enable row level security;

drop policy if exists stock_lots_read on public.stock_lots;
create policy stock_lots_read on public.stock_lots for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists stock_lots_write on public.stock_lots;
create policy stock_lots_write on public.stock_lots for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code());

-- IMPORTANT ORDER in the receive functions: update the request line + status
-- BEFORE bumping item_stock. Bumping item_stock fires the auto-refresh trigger,
-- which rebuilds OPEN requests' lines (wiping received_qty); moving the request
-- out of 'Open' first makes that trigger skip it.

-- Receive a delivery against ONE request line.
create or replace function public.receive_material_lot(p_item_id uuid, p_qty numeric, p_batch_no text, p_exp_date date, p_do_number text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_it public.material_request_items; v_req public.material_requests; v_item_id uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  select * into v_it from public.material_request_items where id = p_item_id;
  if not found then raise exception 'Request line not found'; end if;
  select * into v_req from public.material_requests where id = v_it.request_id;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_req.factory_code = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  v_item_id := coalesce(v_it.item_id, (select id from public.items where code = v_it.item_code limit 1));
  if v_item_id is null then raise exception 'Item % is not in the Items master — add it there first', v_it.item_code; end if;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, request_item_id, do_number)
  values (v_item_id, v_it.item_code, v_it.description, v_req.factory_code, nullif(p_batch_no,''), p_exp_date, p_qty, p_qty, p_item_id, nullif(p_do_number,''));
  update public.material_request_items set received_qty = received_qty + p_qty where id = p_item_id;
  update public.material_requests set status =
    case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_req.id) then 'Fulfilled'
         when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_req.id) then 'Partially Received'
         else 'Open' end
  where id = v_req.id;
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (v_item_id, v_req.factory_code, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + p_qty, updated_at = now();
end $$;
grant execute on function public.receive_material_lot(uuid, numeric, text, date, text) to authenticated;

-- Receive a COMBINED warehouse delivery: one physical lot, split across the
-- lines (oldest first); leftover/over-delivery goes onto the last line.
create or replace function public.receive_combined_lot(p_item_ids uuid[], p_qty numeric, p_batch_no text, p_exp_date date, p_do_number text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_first public.material_request_items; v_factory text; v_remaining numeric := p_qty; v_alloc numeric; c record; v_reqid uuid; v_item_id uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  if array_length(p_item_ids,1) is null then raise exception 'No request lines given'; end if;
  select * into v_first from public.material_request_items where id = p_item_ids[1];
  select factory_code into v_factory from public.material_requests where id = v_first.request_id;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_factory = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  v_item_id := coalesce(v_first.item_id, (select id from public.items where code = v_first.item_code limit 1));
  if v_item_id is null then raise exception 'Item % is not in the Items master — add it there first', v_first.item_code; end if;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, do_number)
  values (v_item_id, v_first.item_code, v_first.description, v_factory, nullif(p_batch_no,''), p_exp_date, p_qty, p_qty, nullif(p_do_number,''));
  for c in select mri.id, mri.requested_qty, mri.received_qty from public.material_request_items mri join public.material_requests mr on mr.id = mri.request_id where mri.id = any(p_item_ids) order by mr.created_at asc, mri.id asc
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, greatest(c.requested_qty - c.received_qty, 0));
    if v_alloc > 0 then update public.material_request_items set received_qty = received_qty + v_alloc where id = c.id; v_remaining := v_remaining - v_alloc; end if;
  end loop;
  -- Surplus beyond what the open requests asked for is NOT forced onto the last
  -- request; it simply stays in stock (the lot + item_stock hold the full qty), so
  -- the next FIFO request for this material can draw it next time.
  for v_reqid in select distinct request_id from public.material_request_items where id = any(p_item_ids) loop
    update public.material_requests set status =
      case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
           when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
           else 'Open' end
    where id = v_reqid;
  end loop;
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (v_item_id, v_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + p_qty, updated_at = now();
end $$;
grant execute on function public.receive_combined_lot(uuid[], numeric, text, date, text) to authenticated;

-- Receive a KNOWN item into stock with NO order (extra/unrequested delivery),
-- flagged unplanned. Unknown codes raise 'Unknown item' (frontend skips + warns).
create or replace function public.receive_stock_direct(p_item_code text, p_factory text, p_qty numeric, p_batch_no text, p_exp_date date, p_do_number text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_item public.items;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (p_factory = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  select * into v_item from public.items where code = p_item_code limit 1;
  if not found then raise exception 'Unknown item %', p_item_code; end if;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, request_item_id, unplanned, do_number)
  values (v_item.id, v_item.code, v_item.description, p_factory, nullif(p_batch_no,''), p_exp_date, p_qty, p_qty, null, true, nullif(p_do_number,''));
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (v_item.id, p_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + p_qty, updated_at = now();
end $$;
grant execute on function public.receive_stock_direct(text, text, numeric, text, date, text) to authenticated;


-- ============================================================================
-- 2026-06 · Delivery Orders as stored documents (like Sales Orders)
-- ============================================================================

-- PDF storage bucket for delivery orders + access for logged-in users.
insert into storage.buckets (id, name) values ('delivery-orders', 'delivery-orders') on conflict (id) do nothing;
drop policy if exists delivery_orders_obj_all on storage.objects;
create policy delivery_orders_obj_all on storage.objects for all to authenticated
  using (bucket_id = 'delivery-orders') with check (bucket_id = 'delivery-orders');

-- Document header (one row per uploaded DO).
create table if not exists public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_path text not null,
  do_number text,
  do_date text,
  factory_code text not null,
  status text not null default 'Processing',   -- Processing → Review → Received (or Error)
  uploaded_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.delivery_orders to authenticated, anon, service_role;
alter table public.delivery_orders enable row level security;
drop policy if exists do_read on public.delivery_orders;
create policy do_read on public.delivery_orders for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));
drop policy if exists do_write on public.delivery_orders;
create policy do_write on public.delivery_orders for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()))
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));

-- Extracted lines for each DO.
create table if not exists public.delivery_order_lines (
  id uuid primary key default gen_random_uuid(),
  do_id uuid not null references public.delivery_orders(id) on delete cascade,
  item_code text not null,
  description text,
  quantity numeric,
  unit text,
  batch_no text,
  created_at timestamptz not null default now()
);
create index if not exists delivery_order_lines_do on public.delivery_order_lines(do_id);
grant select, insert, update, delete on public.delivery_order_lines to authenticated, anon, service_role;
alter table public.delivery_order_lines enable row level security;
drop policy if exists dol_read on public.delivery_order_lines;
create policy dol_read on public.delivery_order_lines for select
  using (exists (select 1 from public.delivery_orders d where d.id = do_id and (my_factory_code() = 'HEAD_OFFICE' or d.factory_code = any (my_factory_codes()))));
drop policy if exists dol_write on public.delivery_order_lines;
create policy dol_write on public.delivery_order_lines for all
  using (exists (select 1 from public.delivery_orders d where d.id = do_id and (my_factory_code() = 'HEAD_OFFICE' or d.factory_code = any (my_factory_codes()))))
  with check (exists (select 1 from public.delivery_orders d where d.id = do_id and (my_factory_code() = 'HEAD_OFFICE' or d.factory_code = any (my_factory_codes()))));


-- ============================================================================
-- 2026-06 · Delivery Order: QC tick, per-line photo, partial receiving
-- ============================================================================
alter table delivery_order_lines add column if not exists qc_checked boolean not null default false;
alter table delivery_order_lines add column if not exists photo_path text;   -- one photo per line in the delivery-orders bucket
alter table delivery_order_lines add column if not exists received_at timestamptz; -- set when that line is received (partial receiving)


-- ============================================================================
-- 2026-06 · Production recording + raw-material consumption (FEFO)
-- ============================================================================
-- Record actual produced qty on a batch (balance vs planned = backorder), and
-- consume the BOM's raw materials from this factory's stock earliest-expiry /
-- oldest-received first, logging exactly which lots were consumed.
alter table public.production_batches add column if not exists produced_qty numeric not null default 0;

create table if not exists public.production_consumption (
  id uuid primary key default gen_random_uuid(),
  production_batch_id uuid not null references public.production_batches(id) on delete cascade,
  lot_id uuid references public.stock_lots(id) on delete set null,
  item_id uuid, item_code text, description text, batch_no text, exp_date date,
  factory_code text, qty_consumed numeric not null, run_qty numeric,
  consumed_at timestamptz not null default now()
);
create index if not exists production_consumption_batch on public.production_consumption(production_batch_id);
grant select, insert, update, delete on public.production_consumption to authenticated, anon, service_role;
alter table public.production_consumption enable row level security;
drop policy if exists pc_read on public.production_consumption;
create policy pc_read on public.production_consumption for select
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists pc_write on public.production_consumption;
create policy pc_write on public.production_consumption for all
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());

-- record_production(batch, qty): explode BOM, consume stock_lots FEFO (exp asc
-- nulls last, then received_at asc), decrement item_stock, log to
-- production_consumption, bump produced_qty, set status; returns jsonb
-- {consumed[], shortfalls[]}. (Full body in the SQL Editor snippet / git commit.)


-- ============================================================================
-- 2026-06 · Packing & Finished Good Inspection Record (P07-F01)
-- ============================================================================
-- Digital QC inspection form tied to a production batch; all fields stored as
-- jsonb (form a header/process/sealing/metal-detector/yield/sign-offs + form b
-- hourly log). UI: /inspection?batch=<id>, opened from a production batch.
create table if not exists public.inspection_records (
  id uuid primary key default gen_random_uuid(),
  production_batch_id uuid references public.production_batches(id) on delete set null,
  factory_code text not null,
  data jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inspection_records_batch on public.inspection_records(production_batch_id);
grant select, insert, update, delete on public.inspection_records to authenticated, anon, service_role;
alter table public.inspection_records enable row level security;
drop policy if exists ir_read on public.inspection_records;
create policy ir_read on public.inspection_records for select
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists ir_write on public.inspection_records;
create policy ir_write on public.inspection_records for all
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());


-- ============================================================================
-- 2026-06 · Order Board pack planning (which line packs each order & when)
-- ============================================================================
alter table production_batches add column if not exists pack_line text;
alter table production_batches add column if not exists pack_date date;


-- ============================================================================
-- 2026-06 · Per-section user permissions (view / edit / delete)
-- ============================================================================
-- Each user gets a permission grid stored as jsonb on their profile, shaped
--   { "sales": {"view":true,"edit":true,"delete":false}, "production": {...}, ... }
-- Sections: sales, production, receiving, stock, items, bom, traceability, users.
-- SAFETY: an EMPTY object ({}) means "not configured yet" → legacy full access,
-- so existing users keep working until Head Office sets their grid. Admins always
-- have full access regardless. Enforcement helper (has_perm) + RLS come in step 2.
alter table profiles add column if not exists permissions jsonb not null default '{}'::jsonb;


-- ============================================================================
-- 2026-06 · Office-only access (IP allow-list per factory)
-- ============================================================================
-- Factory staff can only use the app from an office network (an allowed IP);
-- Head Office + Admins are exempt (checked in the client, not here). Allowed IPs
-- are managed by Head Office on /admin/allowed-networks. A master switch lets the
-- whole thing be turned on/off safely (default OFF so nobody is locked out until
-- it's configured and switched on).

create table if not exists public.allowed_networks (
  id uuid primary key default gen_random_uuid(),
  label text,                                   -- e.g. "AVINA102 office"
  ip text not null,                             -- public IP as shown by whatismyipaddress
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.allowed_networks to authenticated, anon, service_role;
alter table public.allowed_networks enable row level security;
drop policy if exists an_read on public.allowed_networks;
create policy an_read on public.allowed_networks for select using (true);
drop policy if exists an_write on public.allowed_networks;
create policy an_write on public.allowed_networks for all
  using (my_factory_code() = 'HEAD_OFFICE') with check (my_factory_code() = 'HEAD_OFFICE');

-- Single-row app settings (id is always 1). Master switch for the IP guard.
create table if not exists public.app_config (
  id int primary key default 1,
  network_guard_enabled boolean not null default false,
  constraint app_config_single check (id = 1)
);
insert into public.app_config (id) values (1) on conflict do nothing;
grant select, insert, update, delete on public.app_config to authenticated, anon, service_role;
alter table public.app_config enable row level security;
drop policy if exists ac_read on public.app_config;
create policy ac_read on public.app_config for select using (true);
drop policy if exists ac_write on public.app_config;
create policy ac_write on public.app_config for all
  using (my_factory_code() = 'HEAD_OFFICE') with check (my_factory_code() = 'HEAD_OFFICE');


-- ============================================================================
-- 2026-06 · Grinding & Mixing Record (P07-F10) — restricted process screen
-- ============================================================================
-- A grinding/mixing log (controlled form P07-F10 Ver.02). Each record can list
-- several raw materials (a mixture) in `materials` jsonb [{item, qty}]. Visible
-- only to users explicitly granted the 'grinding' permission section (restricted
-- by default). Factory-scoped (multi-factory aware via my_factory_codes()).
create table if not exists public.grinding_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  month_year text,
  record_date date,
  product text,
  product_batch_no text,
  materials jsonb not null default '[]'::jsonb,   -- [{ item, qty }]
  machine text,
  crusher_before text,                            -- crusher condition before production
  crusher_after text,                             -- crusher condition after production
  qty_rework numeric,
  qty_rejection numeric,
  correction_action text,
  prepared_by text,
  verified_by text,
  remark text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists grinding_records_factory on public.grinding_records(factory_code, record_date);
grant select, insert, update, delete on public.grinding_records to authenticated, anon, service_role;
alter table public.grinding_records enable row level security;
drop policy if exists gr_read on public.grinding_records;
create policy gr_read on public.grinding_records for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));
drop policy if exists gr_write on public.grinding_records;
create policy gr_write on public.grinding_records for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()))
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));


-- ============================================================================
-- 2026-06 · Grinding recipe locked away from QC (DB-enforced field separation)
-- ============================================================================
-- The raw-material mixture (formula) must be hidden from QC, who still do the
-- inspection. So the mixture moves to its own table, gated by a NEW permission
-- 'grinding_recipe' enforced in the database via has_perm(). QC gets 'grinding'
-- (inspection) only; operators get both.

-- Permission check mirroring lib/permissions.ts can(): admins full; restricted
-- sections need an explicit grant; otherwise unconfigured = full (legacy).
create or replace function public.has_perm(p_module text, p_action text)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (select role, permissions from profiles where id = auth.uid())
  select case
    when (select role from me) = 'admin' then true
    when (select permissions from me) is null or (select permissions from me) = '{}'::jsonb
      then p_module not in ('grinding', 'grinding_recipe')   -- restricted → need explicit grant
    else coalesce((((select permissions from me) -> p_module) ->> p_action)::boolean, false)
  end
$$;
grant execute on function public.has_perm(text, text) to authenticated, anon, service_role;

-- The locked recipe/mixture (one row per raw material in a grinding record).
create table if not exists public.grinding_materials (
  id uuid primary key default gen_random_uuid(),
  grinding_record_id uuid not null references public.grinding_records(id) on delete cascade,
  factory_code text not null,
  item text,
  qty text,
  created_at timestamptz not null default now()
);
create index if not exists grinding_materials_record on public.grinding_materials(grinding_record_id);
grant select, insert, update, delete on public.grinding_materials to authenticated, anon, service_role;
alter table public.grinding_materials enable row level security;
-- Read/write the mixture ONLY with the grinding_recipe permission (+ own factory).
drop policy if exists gm_read on public.grinding_materials;
create policy gm_read on public.grinding_materials for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'view'));
drop policy if exists gm_write on public.grinding_materials;
create policy gm_write on public.grinding_materials for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'));

-- Move any existing inline mixture (jsonb) into the locked table, then it's unused.
insert into public.grinding_materials (grinding_record_id, factory_code, item, qty)
select gr.id, gr.factory_code, m->>'item', m->>'qty'
from public.grinding_records gr, jsonb_array_elements(gr.materials) m
where jsonb_typeof(gr.materials) = 'array' and gr.materials <> '[]'::jsonb;

-- Tighten the grinding RECORD (inspection) to the 'grinding' permission too.
drop policy if exists gr_read on public.grinding_records;
create policy gr_read on public.grinding_records for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'view'));
drop policy if exists gr_write on public.grinding_records;
create policy gr_write on public.grinding_records for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'edit'));


-- ============================================================================
-- 2026-06 · Grinding recipes (preset formula) + lot-multiplier production
-- ============================================================================
-- Mixer presets a formula per product; operators just pick product + #lots and
-- the secure produce_grinding() multiplies the per-lot quantities. Operators see
-- only the product name (recipe HEADER read by 'grinding'); the COMPONENTS
-- (quantities) are read only with 'grinding_recipe' (the mixer / QC blocked).

create table if not exists public.grinding_recipes (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  product text not null,
  recipe_type text not null default 'mixing',   -- 'direct' | 'mixing'
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.grinding_recipes to authenticated, anon, service_role;
alter table public.grinding_recipes enable row level security;
-- Header (product name) visible to grinding operators so they can pick it.
drop policy if exists grec_read on public.grinding_recipes;
create policy grec_read on public.grinding_recipes for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'view'));
-- Only the mixer (recipe permission) creates/edits recipes.
drop policy if exists grec_write on public.grinding_recipes;
create policy grec_write on public.grinding_recipes for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'));

-- The secret quantities (per lot). Readable only with the recipe permission.
create table if not exists public.grinding_recipe_components (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.grinding_recipes(id) on delete cascade,
  factory_code text not null,
  item text not null,
  qty_per_lot numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists grec_comp_recipe on public.grinding_recipe_components(recipe_id);
grant select, insert, update, delete on public.grinding_recipe_components to authenticated, anon, service_role;
alter table public.grinding_recipe_components enable row level security;
drop policy if exists grc_read on public.grinding_recipe_components;
create policy grc_read on public.grinding_recipe_components for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'view'));
drop policy if exists grc_write on public.grinding_recipe_components;
create policy grc_write on public.grinding_recipe_components for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'));

-- Link production records to a recipe + lots.
alter table public.grinding_records add column if not exists recipe_id uuid references public.grinding_recipes(id);
alter table public.grinding_records add column if not exists lots numeric;
alter table public.grinding_records add column if not exists recipe_type text;

-- Operator produces N lots of a recipe; computes the (hidden) mixture as definer
-- so the operator never needs to read the formula.
create or replace function public.produce_grinding(p_recipe_id uuid, p_lots numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_rec public.grinding_recipes; v_id uuid; c record;
begin
  if not has_perm('grinding', 'edit') then raise exception 'Not allowed to record grinding'; end if;
  if p_lots is null or p_lots <= 0 then raise exception 'Number of lots must be greater than zero'; end if;
  select * into v_rec from public.grinding_recipes where id = p_recipe_id;
  if not found then raise exception 'Recipe not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_rec.factory_code = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  insert into public.grinding_records (factory_code, product, recipe_id, lots, recipe_type, record_date, month_year, created_by)
  values (v_rec.factory_code, v_rec.product, p_recipe_id, p_lots, v_rec.recipe_type,
          (now() at time zone 'Asia/Kuala_Lumpur')::date,
          to_char(now() at time zone 'Asia/Kuala_Lumpur', 'MM/YYYY'), auth.uid())
  returning id into v_id;
  for c in select item, qty_per_lot from public.grinding_recipe_components where recipe_id = p_recipe_id loop
    insert into public.grinding_materials (grinding_record_id, factory_code, item, qty)
    values (v_id, v_rec.factory_code, c.item, (c.qty_per_lot * p_lots)::text);
  end loop;
  return v_id;
end $$;
grant execute on function public.produce_grinding(uuid, numeric) to authenticated;


-- ============================================================================
-- 2026-06 · Grinding mixing details: per-material batch + added tick, mix times
-- ============================================================================
-- When the mixer prepares a produced batch, they record each raw material's
-- batch number and tick it as added; the record gets mix start/end times.
alter table public.grinding_materials add column if not exists batch_no text;
alter table public.grinding_materials add column if not exists added boolean not null default false;
alter table public.grinding_records add column if not exists mix_start text;   -- HH:MM
alter table public.grinding_records add column if not exists mix_end text;     -- HH:MM


-- ============================================================================
-- 2026-06 · Process inspection forms: Drying/Roasting (P07-F05), Moisture
--           (P07-F08), OPRP (P07-F03). Factory-scoped record logs.
-- ============================================================================
-- Helper note: all three are simple factory-scoped logs (same RLS shape as
-- stock_lots), shown under the Production permission. Rendered by the shared
-- ProcessLog component from a fields config per page.

create table if not exists public.drying_roasting_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null, month_year text, record_date date,
  product text, rm_batch_no text, product_batch_no text, qty_in numeric, qty_out numeric, machine text,
  oven_temp text, oven_achieve_temp text, oven_time_start text, oven_time_finish text,
  roast_temp text, roast_achieve_temp text, roast_time_start text, roast_time_finish text,
  moisture_before text, moisture_after text, done_by text, verified_by text, remark text,
  created_by uuid, created_at timestamptz not null default now()
);

create table if not exists public.moisture_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null, month_year text, record_date date,
  product text, batch_no text, sample_from text, product_desc text, sample_prep text,
  weight_g numeric, time_min numeric, moisture_pct text, remarks text, checked_by text, verified_by text,
  created_by uuid, created_at timestamptz not null default now()
);

create table if not exists public.oprp_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null, month_year text, record_date date,
  product text, batch_no_old text, batch_no_new text, taken_qty numeric, out_qty numeric,
  time_in text, time_out text, machine text, machine_before text, machine_after text,
  sieve_size text, sieve_before text, sieve_after text, weight_residue numeric, weight_waste numeric,
  handpick_result text, visual_result text, needle_condition text, seal_integrity text,
  done_by text, verified_by text, remark text,
  created_by uuid, created_at timestamptz not null default now()
);

-- Same factory-scoped RLS for all three (HO or one of the user's factories).
do $$
declare t text;
begin
  foreach t in array array['drying_roasting_records', 'moisture_records', 'oprp_records'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated, anon, service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (my_factory_code() = ''HEAD_OFFICE'' or factory_code = any (my_factory_codes()))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (my_factory_code() = ''HEAD_OFFICE'' or factory_code = any (my_factory_codes())) with check (my_factory_code() = ''HEAD_OFFICE'' or factory_code = any (my_factory_codes()))', t || '_write', t);
  end loop;
end $$;


-- ============================================================================
-- 2026-06 · Timer cancellation requests (accidental Start/Stop → HO approval)
-- ============================================================================
-- A user can request to cancel a timer they pressed by mistake; it appears in
-- Pending Changes; Head Office approves → the specific timer fields are cleared.
create table if not exists public.correction_requests (
  id uuid primary key default gen_random_uuid(),
  factory_code text,
  table_name text not null,
  record_id uuid not null,
  timer_key text not null,           -- which timer: grinding_mix / drying_oven / drying_roast / oprp_process / inspection_production
  label text,
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.correction_requests to authenticated, anon, service_role;
grant update, delete on public.correction_requests to service_role;
alter table public.correction_requests enable row level security;
drop policy if exists cr_read on public.correction_requests;
create policy cr_read on public.correction_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists cr_insert on public.correction_requests;
create policy cr_insert on public.correction_requests for insert with check (requested_by = auth.uid());

-- Approve: HO only; clears the specific timer fields for the known timer_key.
create or replace function public.approve_correction(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.correction_requests; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.correction_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  case r.timer_key
    when 'grinding_mix' then update public.grinding_records set mix_timer = null, mix_start = null, mix_end = null where id = r.record_id;
    when 'drying_oven' then update public.drying_roasting_records set oven_time_start = null, oven_time_finish = null where id = r.record_id;
    when 'drying_roast' then update public.drying_roasting_records set roast_time_start = null, roast_time_finish = null where id = r.record_id;
    when 'oprp_process' then update public.oprp_records set time_in = null, time_out = null where id = r.record_id;
    when 'inspection_production' then update public.inspection_records set data = (data - 'timer' - 'prod_start' - 'prod_end') where id = r.record_id;
    else raise exception 'Unknown timer key %', r.timer_key;
  end case;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.correction_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_correction(uuid) to authenticated;

create or replace function public.reject_correction(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.correction_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_correction(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Drying/Roasting moves stock: same item, new batch (e.g. 260606AH)
-- ============================================================================
-- Roasting is an extra process: consume qty_in of the old batch and create a new
-- batch (same item) with qty_out (the weight loss is the difference). One-shot
-- per record (stock_applied guard). Product field holds "CODE — DESCRIPTION".
alter table public.drying_roasting_records add column if not exists stock_applied boolean not null default false;

create or replace function public.process_drying_stock(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.drying_roasting_records; v_code text; v_item public.items; v_need numeric; v_take numeric; v_avail numeric; c record;
begin
  if not has_perm('production', 'edit') then raise exception 'Not allowed to record production'; end if;
  select * into r from public.drying_roasting_records where id = p_id;
  if not found then raise exception 'Record not found'; end if;
  if r.stock_applied then raise exception 'Stock has already been moved for this record'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (r.factory_code = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  if r.qty_in is null or r.qty_in <= 0 then raise exception 'Enter Qty in (kg)'; end if;
  if r.qty_out is null or r.qty_out <= 0 then raise exception 'Enter Qty out (kg)'; end if;
  if coalesce(r.rm_batch_no, '') = '' then raise exception 'Enter the batch before oven'; end if;
  if coalesce(r.product_batch_no, '') = '' then raise exception 'Enter the new batch after oven'; end if;
  v_code := trim(split_part(coalesce(r.product, ''), '—', 1));
  select * into v_item from public.items where code = v_code limit 1;
  if not found then raise exception 'Item % not found in Items master', v_code; end if;
  select coalesce(sum(qty_remaining), 0) into v_avail from public.stock_lots
    where item_id = v_item.id and factory_code = r.factory_code and batch_no = r.rm_batch_no;
  if v_avail < r.qty_in then raise exception 'Not enough stock of batch % (have %, need %)', r.rm_batch_no, v_avail, r.qty_in; end if;
  v_need := r.qty_in;
  for c in select id, qty_remaining from public.stock_lots
           where item_id = v_item.id and factory_code = r.factory_code and batch_no = r.rm_batch_no and qty_remaining > 0
           order by exp_date asc nulls last, received_at asc loop
    exit when v_need <= 0;
    v_take := least(v_need, c.qty_remaining);
    update public.stock_lots set qty_remaining = qty_remaining - v_take where id = c.id;
    v_need := v_need - v_take;
  end loop;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining)
  values (v_item.id, v_item.code, v_item.description, r.factory_code, r.product_batch_no, null, r.qty_out, r.qty_out);
  update public.item_stock set quantity = quantity - r.qty_in + r.qty_out, updated_at = now()
    where item_id = v_item.id and factory_code = r.factory_code;
  if not found then
    insert into public.item_stock (item_id, factory_code, quantity, updated_at) values (v_item.id, r.factory_code, r.qty_out - r.qty_in, now());
  end if;
  update public.drying_roasting_records set stock_applied = true where id = p_id;
end $$;
grant execute on function public.process_drying_stock(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Goods Received line edit/delete with Head Office approval
-- ============================================================================
-- Each received line records what it booked, so an approved delete can reverse
-- exactly that stock. Edits/deletes go through do_change_requests (like sales).
alter table public.delivery_order_lines add column if not exists stock_lot_id uuid;
alter table public.delivery_order_lines add column if not exists received_qty numeric;

create table if not exists public.do_change_requests (
  id uuid primary key default gen_random_uuid(),
  do_id uuid references public.delivery_orders(id) on delete cascade,
  line_id uuid references public.delivery_order_lines(id) on delete set null,
  factory_code text,
  request_type text not null,                 -- 'edit' | 'delete'
  field text, old_value text, new_value text,
  line_label text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.do_change_requests to authenticated, anon, service_role;
grant update, delete on public.do_change_requests to service_role;
alter table public.do_change_requests enable row level security;
drop policy if exists docr_read on public.do_change_requests;
create policy docr_read on public.do_change_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists docr_insert on public.do_change_requests;
create policy docr_insert on public.do_change_requests for insert with check (requested_by = auth.uid());

create or replace function public.approve_do_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.do_change_requests; v_l public.delivery_order_lines; v_lot public.stock_lots; v_name text; v_reqid uuid;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.do_change_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  select * into v_l from public.delivery_order_lines where id = r.line_id;

  if r.request_type = 'edit' then
    if not found then raise exception 'That line no longer exists'; end if;
    if r.field not in ('item_code','description','quantity','unit','batch_no') then raise exception 'Field % cannot be edited', r.field; end if;
    if v_l.received_at is not null and r.field in ('item_code','quantity','unit','batch_no') then
      raise exception 'Line already received — delete it and receive again to change %', r.field;
    end if;
    if r.field = 'quantity' then
      update public.delivery_order_lines set quantity = nullif(r.new_value,'')::numeric where id = r.line_id;
    else
      execute format('update public.delivery_order_lines set %I = $1 where id = $2', r.field) using nullif(r.new_value,''), r.line_id;
    end if;

  elsif r.request_type = 'correct_qty' then
    -- Fix the quantity that was received into stock; re-book the difference.
    if not found then raise exception 'That line no longer exists'; end if;
    if v_l.received_at is null then raise exception 'Line is not received yet — just receive it with the right quantity'; end if;
    if v_l.stock_lot_id is null then raise exception 'This receipt predates the feature — correct its stock manually'; end if;
    select * into v_lot from public.stock_lots where id = v_l.stock_lot_id;
    if not found then raise exception 'The stock lot for this line no longer exists'; end if;
    declare v_new numeric := nullif(r.new_value,'')::numeric; v_old numeric := coalesce(v_l.received_qty, 0); v_delta numeric;
    begin
      if v_new is null or v_new < 0 then raise exception 'Enter a valid corrected quantity'; end if;
      v_delta := v_new - v_old;
      if v_delta < 0 and v_lot.qty_remaining < (-v_delta) then
        raise exception 'Cannot reduce below what is left — % already used from this batch', (v_old - v_lot.qty_remaining);
      end if;
      update public.stock_lots set qty_remaining = qty_remaining + v_delta, qty_received = qty_received + v_delta where id = v_lot.id;
      update public.item_stock set quantity = quantity + v_delta, updated_at = now() where item_id = v_lot.item_id and factory_code = v_lot.factory_code;
      update public.delivery_order_lines set received_qty = v_new where id = r.line_id;
      if v_lot.request_item_id is not null then
        update public.material_request_items set received_qty = greatest(received_qty + v_delta, 0) where id = v_lot.request_item_id;
        select request_id into v_reqid from public.material_request_items where id = v_lot.request_item_id;
        update public.material_requests set status =
          case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
               when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
               else 'Open' end
        where id = v_reqid;
      end if;
    end;

  elsif r.request_type = 'delete' then
    if found and v_l.received_at is not null then
      if v_l.stock_lot_id is null then raise exception 'This receipt predates the feature — reverse its stock manually, then delete'; end if;
      select * into v_lot from public.stock_lots where id = v_l.stock_lot_id;
      if found then
        if v_lot.qty_remaining < coalesce(v_l.received_qty, 0) then
          raise exception 'This batch has already been partly used in production — cannot reverse automatically. Fix stock manually.';
        end if;
        update public.stock_lots set qty_remaining = qty_remaining - coalesce(v_l.received_qty, 0) where id = v_lot.id;
        update public.item_stock set quantity = quantity - coalesce(v_l.received_qty, 0), updated_at = now()
          where item_id = v_lot.item_id and factory_code = v_lot.factory_code;
        if v_lot.request_item_id is not null then
          update public.material_request_items set received_qty = greatest(received_qty - coalesce(v_l.received_qty, 0), 0) where id = v_lot.request_item_id;
          select request_id into v_reqid from public.material_request_items where id = v_lot.request_item_id;
          update public.material_requests set status =
            case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
                 when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
                 else 'Open' end
          where id = v_reqid;
        end if;
      end if;
    end if;
    delete from public.delivery_order_lines where id = r.line_id;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.do_change_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_do_change(uuid) to authenticated;

create or replace function public.reject_do_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.do_change_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_do_change(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · BOM alternate component by run mode (auto = roll, manual = pc)
-- ============================================================================
-- A recipe component can be "any" (always), "auto" (only auto-machine runs) or
-- "manual" (only manual runs). Each production batch has a run_mode; the material
-- calculation includes the 'any' components + the one matching the batch mode.
alter table public.bom_components add column if not exists use_mode text not null default 'any';   -- any | auto | manual
alter table public.production_batches add column if not exists run_mode text not null default 'auto'; -- auto | manual

-- Re-create the three material-calc functions with the mode filter added.
create or replace function public.raise_material_request(p_batch_id uuid)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_batch public.production_batches; v_parent uuid; v_req uuid; v_no text; v_count int := 0; c record; v_short numeric; v_reqd numeric;
begin
  select * into v_batch from public.production_batches where id = p_batch_id;
  if not found then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_batch.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if v_batch.material_request_id is not null then raise exception 'A material request already exists for this batch'; end if;
  select id into v_parent from public.items where code = v_batch.item_code limit 1;
  if v_parent is null then raise exception 'Item % not found in Items Master', v_batch.item_code; end if;
  if not exists (select 1 from public.bom_components where parent_item_id = v_parent) then
    raise exception 'No BOM defined for %', v_batch.item_code; end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status)
  values (v_no, p_batch_id, v_batch.factory_code, 'Open') returning id into v_req;
  for c in
    select bc.component_item_id as item_id, it.code, it.description, it.unit, bc.apply_allowance,
           bc.quantity * v_batch.total_quantity as required_qty, coalesce(s.quantity, 0) as stock_qty
    from public.bom_components bc join public.items it on it.id = bc.component_item_id
    left join public.item_stock s on s.item_id = bc.component_item_id and s.factory_code = v_batch.factory_code
    where bc.parent_item_id = v_parent
      and (bc.use_mode = 'any' or bc.use_mode = coalesce(v_batch.run_mode, 'auto'))
  loop
    v_short := c.required_qty - c.stock_qty;
    if v_short > 0 then
      v_reqd := case when c.apply_allowance then ceil(v_short * 1.1) else v_short end;
      insert into public.material_request_items
        (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
      values (v_req, c.item_id, c.code, c.description, c.unit, c.required_qty, c.stock_qty, v_short, v_reqd, 0, v_batch.factory_code);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'No shortfall — enough stock on hand for all materials'; end if;
  update public.production_batches set status = case when status = 'Planned' then 'Requested' else status end, material_request_id = v_req where id = p_batch_id;
  return v_req;
end; $function$;

create or replace function public.refresh_one_open_request(p_request_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_req public.material_requests; v_batch public.production_batches; v_parent uuid; v_count int := 0; c record; v_short numeric; v_reqd numeric; v_total numeric;
begin
  select * into v_req from public.material_requests where id = p_request_id;
  if not found or v_req.status <> 'Open' then return; end if;
  select * into v_batch from public.production_batches where id = v_req.batch_id;
  if not found then return; end if;
  -- combined total: sum of EVERY batch that shares this request (not just the linked one)
  select coalesce(sum(total_quantity), 0) into v_total from public.production_batches where material_request_id = p_request_id;
  if v_total = 0 then v_total := v_batch.total_quantity; end if;
  select id into v_parent from public.items where code = v_batch.item_code limit 1;
  delete from public.material_request_items where request_id = p_request_id;
  if v_parent is not null then
    for c in
      select bc.component_item_id as item_id, it.code, it.description, it.unit, bc.apply_allowance,
             bc.quantity * v_total as required_qty, coalesce(s.quantity,0) as stock_qty
      from public.bom_components bc join public.items it on it.id = bc.component_item_id
      left join public.item_stock s on s.item_id = bc.component_item_id and s.factory_code = v_batch.factory_code
      where bc.parent_item_id = v_parent
        and (bc.use_mode = 'any' or bc.use_mode = coalesce(v_batch.run_mode, 'auto'))
    loop
      v_short := c.required_qty - c.stock_qty;
      if v_short > 0 then
        v_reqd := case when c.apply_allowance then ceil(v_short * 1.1) else v_short end;
        insert into public.material_request_items
          (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
        values (p_request_id, c.item_id, c.code, c.description, c.unit, c.required_qty, c.stock_qty, v_short, v_reqd, 0, v_batch.factory_code);
        v_count := v_count + 1;
      end if;
    end loop;
  end if;
  if v_count = 0 then delete from public.material_requests where id = p_request_id; end if;
end; $function$;

create or replace function public.raise_combined_material_request(p_batch_ids uuid[])
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_item text; v_factory text; v_mode text; v_total numeric; v_parent uuid; v_req uuid; v_no text; v_count int := 0; c record; v_short numeric; v_reqd numeric;
begin
  select item_code, factory_code, run_mode into v_item, v_factory, v_mode from public.production_batches where id = p_batch_ids[1];
  if v_item is null then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_factory <> all(my_factory_codes()) then raise exception 'Not allowed for this factory'; end if;
  if exists (select 1 from public.production_batches where id = any(p_batch_ids)
             and (item_code <> v_item or factory_code <> v_factory or status <> 'Planned' or material_request_id is not null
                  or coalesce(run_mode,'auto') <> coalesce(v_mode,'auto'))) then
    raise exception 'All batches must be the same item, factory, run mode, Planned, and not yet requested';
  end if;
  select coalesce(sum(total_quantity), 0) into v_total from public.production_batches where id = any(p_batch_ids);
  select id into v_parent from public.items where code = v_item limit 1;
  if v_parent is null then raise exception 'Item % not found in Items Master', v_item; end if;
  if not exists (select 1 from public.bom_components where parent_item_id = v_parent) then
    raise exception 'No BOM defined for %', v_item; end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status)
  values (v_no, p_batch_ids[1], v_factory, 'Open') returning id into v_req;
  for c in
    select bc.component_item_id as item_id, it.code, it.description, it.unit, bc.apply_allowance,
           bc.quantity * v_total as required_qty, coalesce(s.quantity, 0) as stock_qty
    from public.bom_components bc join public.items it on it.id = bc.component_item_id
    left join public.item_stock s on s.item_id = bc.component_item_id and s.factory_code = v_factory
    where bc.parent_item_id = v_parent
      and (bc.use_mode = 'any' or bc.use_mode = coalesce(v_mode, 'auto'))
  loop
    v_short := c.required_qty - c.stock_qty;
    if v_short > 0 then
      v_reqd := case when c.apply_allowance then ceil(v_short * 1.1) else v_short end;
      insert into public.material_request_items
        (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
      values (v_req, c.item_id, c.code, c.description, c.unit, c.required_qty, c.stock_qty, v_short, v_reqd, 0, v_factory);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'No shortfall — enough stock on hand for all materials'; end if;
  update public.production_batches set status = 'Requested', material_request_id = v_req where id = any(p_batch_ids);
  return v_req;
end; $function$;


-- ============================================================================
-- 2026-06 · Roll items: pieces-per-roll conversion (stock in pc, show/pick rolls)
-- ============================================================================
-- An item with pcs_per_roll set is stocked/used in PIECES (recipe in pc), but
-- received in rolls (roll x pcs_per_roll = pc) and shown / requested in rolls.
alter table public.items add column if not exists pcs_per_roll numeric;


-- ============================================================================
-- 2026-06 · Split a customer/order line out of a merged batch (HO approval)
-- ============================================================================
-- A batch can merge several order lines (same item/date/factory). A request can
-- pull one line into its own batch; HO approves. Only un-started (Planned, no
-- material request) batches with >1 line can be split.
create table if not exists public.split_requests (
  id uuid primary key default gen_random_uuid(),
  batch_item_id uuid, batch_id uuid, factory_code text,
  label text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.split_requests to authenticated, anon, service_role;
grant update, delete on public.split_requests to service_role;
alter table public.split_requests enable row level security;
drop policy if exists sr_read on public.split_requests;
create policy sr_read on public.split_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists sr_insert on public.split_requests;
create policy sr_insert on public.split_requests for insert with check (requested_by = auth.uid());

-- kind = 'split' (pull one order into its own batch) or 'uncombine' (run a
-- grouped batch on its own for material picking).
alter table public.split_requests add column if not exists kind text not null default 'split';
alter table public.production_batches add column if not exists no_combine boolean not null default false;

create or replace function public.approve_split(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.split_requests; v_it public.production_batch_items; v_old public.production_batches; v_new uuid; v_name text; v_cnt int;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.split_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  if r.kind = 'uncombine' then
    update public.production_batches set no_combine = true where id = r.batch_id;
    update public.split_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
    return;
  end if;
  select * into v_it from public.production_batch_items where id = r.batch_item_id;
  if not found then raise exception 'That order line is no longer in a batch'; end if;
  select * into v_old from public.production_batches where id = v_it.batch_id;
  if not found then raise exception 'Batch not found'; end if;
  if v_old.status <> 'Planned' or v_old.material_request_id is not null then
    raise exception 'Batch already started or materials requested — cannot split';
  end if;
  select count(*) into v_cnt from public.production_batch_items where batch_id = v_old.id;
  if v_cnt < 2 then raise exception 'Nothing to split — only one order in this batch'; end if;
  insert into public.production_batches (batch_no, item_code, description, delivery_date, factory_code, total_quantity, status, run_mode)
  values ('PB-' || lpad(nextval('public.production_batch_seq')::text, 5, '0'),
          v_old.item_code, v_old.description, v_old.delivery_date, v_old.factory_code, v_it.quantity, 'Planned', coalesce(v_old.run_mode, 'auto'))
  returning id into v_new;
  update public.production_batch_items set batch_id = v_new where id = r.batch_item_id;
  update public.production_batches set total_quantity = coalesce((select sum(quantity) from public.production_batch_items where batch_id = v_old.id), 0) where id = v_old.id;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.split_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_split(uuid) to authenticated;

create or replace function public.reject_split(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.split_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_split(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Packing lines master (per factory) — dropdown on the Order Board
-- ============================================================================
create table if not exists public.packing_lines (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (factory_code, name)
);
grant select, insert, update, delete on public.packing_lines to authenticated, service_role;
alter table public.packing_lines enable row level security;
drop policy if exists pl_all on public.packing_lines;
create policy pl_all on public.packing_lines for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()))
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));


-- ============================================================================
-- 2026-06 · Manual stock adjustments (no document) — HOD approval
-- ============================================================================
-- Staff key an IN/OUT adjustment; it stays Pending until Head Office approves.
-- Approving an IN creates a stock lot; an OUT deducts FEFO (earliest expiry).
create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  item_id uuid, item_code text not null, description text,
  direction text not null check (direction in ('in','out')),
  quantity numeric not null check (quantity > 0),
  batch_no text, exp_date date, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.stock_adjustments to authenticated, anon, service_role;
grant update, delete on public.stock_adjustments to service_role;
alter table public.stock_adjustments enable row level security;
drop policy if exists sa_read on public.stock_adjustments;
create policy sa_read on public.stock_adjustments for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists sa_insert on public.stock_adjustments;
create policy sa_insert on public.stock_adjustments for insert with check (requested_by = auth.uid());

create or replace function public.approve_stock_adjustment(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.stock_adjustments; v_name text; v_item_id uuid; v_desc text; v_need numeric; r record;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into a from public.stock_adjustments where id = p_id;
  if not found or a.status <> 'Pending' then raise exception 'Not a pending adjustment'; end if;
  v_item_id := a.item_id; v_desc := a.description;
  if v_item_id is null then select id, description into v_item_id, v_desc from public.items where code = a.item_code limit 1; end if;
  if a.direction = 'in' then
    insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, received_at, unplanned)
    values (v_item_id, a.item_code, coalesce(a.description, v_desc), a.factory_code, a.batch_no, a.exp_date, a.quantity, a.quantity, now(), true);
    insert into public.item_stock (item_id, factory_code, quantity, updated_at)
    values (v_item_id, a.factory_code, a.quantity, now())
    on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + a.quantity, updated_at = now();
  else
    v_need := a.quantity;
    for r in select id, qty_remaining from public.stock_lots
             where item_code = a.item_code and factory_code = a.factory_code and qty_remaining > 0
             order by exp_date asc nulls last, received_at asc loop
      exit when v_need <= 0;
      if r.qty_remaining <= v_need then
        update public.stock_lots set qty_remaining = 0 where id = r.id; v_need := v_need - r.qty_remaining;
      else
        update public.stock_lots set qty_remaining = qty_remaining - v_need where id = r.id; v_need := 0;
      end if;
    end loop;
    if v_need > 0 then raise exception 'Not enough stock to remove — short by %', v_need; end if;
    insert into public.item_stock (item_id, factory_code, quantity, updated_at)
    values (v_item_id, a.factory_code, -a.quantity, now())
    on conflict (item_id, factory_code) do update set quantity = item_stock.quantity - a.quantity, updated_at = now();
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.stock_adjustments set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_stock_adjustment(uuid) to authenticated;

create or replace function public.reject_stock_adjustment(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.stock_adjustments set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_stock_adjustment(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Run-mode change requests (HOD approval) from the Packing Schedule
-- ============================================================================
-- Run mode is decided when raising materials. Changing it later (it changes the
-- BOM: roll vs piece) needs HO approval; approving recalculates any OPEN request.
create table if not exists public.run_mode_requests (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid, factory_code text, batch_no text, item_code text,
  from_mode text, to_mode text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.run_mode_requests to authenticated, anon, service_role;
grant update, delete on public.run_mode_requests to service_role;
alter table public.run_mode_requests enable row level security;
drop policy if exists rm_read on public.run_mode_requests;
create policy rm_read on public.run_mode_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists rm_insert on public.run_mode_requests;
create policy rm_insert on public.run_mode_requests for insert with check (requested_by = auth.uid());

create or replace function public.approve_run_mode(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.run_mode_requests; v_name text; mr record;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.run_mode_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  update public.production_batches set run_mode = r.to_mode where id = r.batch_id;
  -- recalculate any still-open material request for this batch (uses the new mode)
  for mr in select id from public.material_requests where batch_id = r.batch_id and status = 'Open' loop
    perform public.refresh_one_open_request(mr.id);
  end loop;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.run_mode_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_run_mode(uuid) to authenticated;

create or replace function public.reject_run_mode(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.run_mode_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_run_mode(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Cancel an OPEN material request (frees the batches to re-raise)
-- ============================================================================
create or replace function public.cancel_material_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_req public.material_requests;
begin
  select * into v_req from public.material_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_req.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if v_req.status <> 'Open' then
    raise exception 'Only an Open request can be cancelled (some material has already been received)'; end if;
  -- free every batch this request was raised for (only if production has not started)
  update public.production_batches set material_request_id = null, status = 'Planned'
    where material_request_id = p_id and coalesce(produced_qty, 0) = 0;
  delete from public.material_request_items where request_id = p_id;
  delete from public.material_requests where id = p_id;
end $$;
grant execute on function public.cancel_material_request(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Cancel a RELEASED material request — needs HO approval
-- ============================================================================
create table if not exists public.mr_cancel_requests (
  id uuid primary key default gen_random_uuid(),
  material_request_id uuid, request_no text, factory_code text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.mr_cancel_requests to authenticated, anon, service_role;
grant update, delete on public.mr_cancel_requests to service_role;
alter table public.mr_cancel_requests enable row level security;
drop policy if exists mrc_read on public.mr_cancel_requests;
create policy mrc_read on public.mr_cancel_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists mrc_insert on public.mr_cancel_requests;
create policy mrc_insert on public.mr_cancel_requests for insert with check (requested_by = auth.uid());

create or replace function public.approve_mr_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mr_cancel_requests; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.mr_cancel_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  perform public.cancel_material_request(r.material_request_id);  -- frees batches, deletes request (raises if already received)
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_cancel_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_mr_cancel(uuid) to authenticated;

create or replace function public.reject_mr_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_cancel_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_mr_cancel(uuid) to authenticated;


-- 2026-06 · Partial label printing — how many labels to print this run
alter table public.material_request_items add column if not exists label_print_qty numeric;


-- 2026-06 · Re-map unmapped sales order lines from the current Location Map
-- (case/space-insensitive; runs server-side so RLS doesn't block the update)
create or replace function public.remap_unmapped_lines(p_import_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update public.sales_order_lines sol
    set factory_code = lm.factory_code
  from public.location_map lm
  where sol.import_id = p_import_id
    and coalesce(sol.factory_code, '') = ''
    and btrim(upper(lm.location_code)) = btrim(upper(coalesce(sol.location_code, '')))
    and coalesce(lm.factory_code, '') <> '';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
grant execute on function public.remap_unmapped_lines(uuid) to authenticated;


-- 2026-06 · BOM editable by anyone with the 'bom' edit permission (was HEAD_OFFICE only)
alter table public.bom_components enable row level security;
drop policy if exists bom_components_edit on public.bom_components;
create policy bom_components_edit on public.bom_components for all to authenticated
  using (public.has_perm('bom','edit'))
  with check (public.has_perm('bom','edit'));


-- 2026-06 · Per-factory view-only — a user can see records for these factories but
-- not edit/delete them (enforced in the app via can(module, action, factory_code)).
alter table public.profiles add column if not exists readonly_factories text[] not null default '{}';


-- ============================================================================
-- 2026-06 · Delivery Orders (finished goods factory → warehouse) + raw returns
-- ============================================================================
alter table public.production_batches add column if not exists dispatched_at timestamptz;
create sequence if not exists public.dispatch_seq start 1;

create table if not exists public.dispatch_orders (
  id uuid primary key default gen_random_uuid(),
  do_number text, factory_code text, status text not null default 'Sent',
  created_by uuid, created_by_name text, created_at timestamptz not null default now()
);
create table if not exists public.dispatch_order_lines (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid references public.dispatch_orders(id) on delete cascade,
  batch_id uuid, item_code text, description text, quantity numeric
);
create table if not exists public.material_returns (
  id uuid primary key default gen_random_uuid(),
  factory_code text, item_code text, description text, quantity numeric, reason text,
  created_by uuid, created_by_name text, created_at timestamptz not null default now()
);
grant select on public.dispatch_orders, public.dispatch_order_lines, public.material_returns to authenticated, anon, service_role;
grant insert, update, delete on public.dispatch_orders, public.dispatch_order_lines, public.material_returns to service_role;
alter table public.dispatch_orders enable row level security;
alter table public.dispatch_order_lines enable row level security;
alter table public.material_returns enable row level security;
drop policy if exists do_read on public.dispatch_orders;
create policy do_read on public.dispatch_orders for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));
drop policy if exists dol_read on public.dispatch_order_lines;
create policy dol_read on public.dispatch_order_lines for select using (true);
drop policy if exists mret_read on public.material_returns;
create policy mret_read on public.material_returns for select using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));

-- Create a delivery order from completed batches, marking them dispatched
create or replace function public.create_dispatch_order(p_batch_ids uuid[]) returns text
language plpgsql security definer set search_path = public as $$
declare v_fac text; v_no text; v_id uuid; v_name text; v_seq int; b record;
begin
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed to create delivery orders'; end if;
  if array_length(p_batch_ids, 1) is null then raise exception 'Select at least one batch'; end if;
  select factory_code into v_fac from public.production_batches where id = p_batch_ids[1];
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  -- Per-factory, per-month running number, e.g. factory 101 in Jun 2026 -> DO101-2606/0001
  select count(*) + 1 into v_seq from public.dispatch_orders
    where factory_code = v_fac and to_char(created_at, 'YYMM') = to_char(now(), 'YYMM');
  v_no := 'DO' || v_fac || '-' || to_char(now(), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.dispatch_orders (do_number, factory_code, created_by, created_by_name)
  values (v_no, v_fac, auth.uid(), v_name) returning id into v_id;
  for b in select * from public.production_batches where id = any (p_batch_ids) and dispatched_at is null loop
    insert into public.dispatch_order_lines (dispatch_id, batch_id, item_code, description, quantity)
    values (v_id, b.id, b.item_code, b.description, b.produced_qty);
    update public.production_batches set dispatched_at = now() where id = b.id;
  end loop;
  return v_no;
end $$;
grant execute on function public.create_dispatch_order(uuid[]) to authenticated;

-- Return raw material to the warehouse — reduces a specific batch's stock immediately
alter table public.material_returns add column if not exists batch_no text;
drop function if exists public.return_material(text, text, numeric, text);
create or replace function public.return_material(p_factory text, p_item_code text, p_lot_id uuid, p_qty numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_item public.items; v_lot public.stock_lots; v_name text;
begin
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed to return materials'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (p_factory = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity greater than zero'; end if;
  select * into v_item from public.items where code = p_item_code limit 1;
  if not found then raise exception 'Item % not found', p_item_code; end if;
  select * into v_lot from public.stock_lots where id = p_lot_id and item_code = p_item_code and factory_code = p_factory;
  if not found then raise exception 'Batch not found for this material at this factory'; end if;
  if p_qty > v_lot.qty_remaining then raise exception 'Not enough in batch % — only % left', coalesce(v_lot.batch_no, '(no batch)'), v_lot.qty_remaining; end if;
  update public.stock_lots set qty_remaining = qty_remaining - p_qty where id = p_lot_id;
  update public.item_stock set quantity = quantity - p_qty, updated_at = now() where item_id = v_item.id and factory_code = p_factory;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.material_returns (factory_code, item_code, description, batch_no, quantity, reason, created_by, created_by_name)
  values (p_factory, p_item_code, v_item.description, v_lot.batch_no, p_qty, p_reason, auth.uid(), v_name);
end $$;
grant execute on function public.return_material(text, text, uuid, numeric, text) to authenticated;


-- ----------------------------------------------------------------------------
-- One-off data fixes applied (kept for the record):
--   • Backfilled the first released run to PR101-2606/0001.
--   • Set kg_per_bag overrides for 9 items whose codes don't show the pack size:
--       D041-4.5/CTN=4.5, BK1009-11.34/CTN=11.34, D958-2325-22.68/CTN=22.68,
--       D958-3032-22.68/CTN=22.68, S251-25G/BAG=25, S251-30G/BAG=30,
--       BK1013-1OKG/CTN=10, BK1089-30lbs/CTN=13.61, D029-3.8KGX5/BAG=17.5
--
-- NOTE: Objects created BEFORE this log (raise_material_request,
-- raise_combined_material_request, refresh_one_open_request,
-- refresh_open_material_requests, confirm_document_factory, approve/reject
-- change requests, my_factory_code(), item_stock, material_requests,
-- material_request_items, etc.) predate this file and live only in Supabase.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- 2026-06 · Manual material requests
-- Let staff raise a material request for an item by hand (not derived from a
-- production batch's BOM) — used while the system is new. Manual requests
-- collect in "Waiting to release" like any other and release as one pick run.
-- ============================================================================
alter table public.material_requests alter column batch_id drop not null;
alter table public.material_requests add column if not exists manual boolean not null default false;

create or replace function public.raise_manual_material_request(p_factory text, p_items jsonb)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_req uuid; v_no text; r jsonb; v_item public.items; v_qty numeric; v_count int := 0;
begin
  if my_factory_code() <> 'HEAD_OFFICE' and p_factory <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if not has_perm('material_requests', 'edit') then raise exception 'Not allowed'; end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status, manual)
  values (v_no, null, p_factory, 'Open', true) returning id into v_req;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce((r->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into v_item from public.items where code = r->>'code' limit 1;
    insert into public.material_request_items
      (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
    values (v_req, v_item.id, coalesce(v_item.code, r->>'code'), coalesce(v_item.description, r->>'description'),
            coalesce(v_item.unit, r->>'unit'), v_qty, 0, v_qty, v_qty, 0, p_factory);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'Add at least one item with a quantity'; end if;
  return v_req;
end; $function$;
grant execute on function public.raise_manual_material_request(text, jsonb) to authenticated;

-- ============================================================================
-- 2026-06 · Manual label requests
-- Raise a factory-printed label by hand (no batch). Like a manual material
-- request but released immediately with its own pick run, so it lands straight
-- in the Labels pipeline at "material received" (ready to print).
-- ============================================================================
create or replace function public.raise_manual_label_request(p_factory text, p_items jsonb)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_req uuid; v_no text; v_run text; v_seq int; v_fac text; r jsonb; v_item public.items; v_qty numeric; v_count int := 0;
begin
  if my_factory_code() <> 'HEAD_OFFICE' and p_factory <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if not has_perm('material_requests', 'edit') then raise exception 'Not allowed'; end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  v_fac := coalesce(nullif(regexp_replace(p_factory, '[^0-9]', '', 'g'), ''), p_factory);
  select coalesce(max((split_part(pick_run_no, '/', 2))::int), 0) + 1 into v_seq
    from public.material_requests
   where factory_code = p_factory
     and pick_run_no like 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/%';
  v_run := 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status, manual, released_at, pick_run_no)
  values (v_no, null, p_factory, 'Open', true, now(), v_run) returning id into v_req;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce((r->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into v_item from public.items where code = r->>'code' limit 1;
    insert into public.material_request_items
      (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
    values (v_req, v_item.id, coalesce(v_item.code, r->>'code'), coalesce(v_item.description, r->>'description'),
            coalesce(v_item.unit, r->>'unit'), v_qty, 0, v_qty, v_qty, 0, p_factory);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'Add at least one label'; end if;
  return v_req;
end; $function$;
grant execute on function public.raise_manual_label_request(text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- Manual label requests also capture the product the label is for, plus the
-- label batch & expiry, at entry time.
-- ----------------------------------------------------------------------------
alter table public.material_request_items add column if not exists label_for_product text;

create or replace function public.raise_manual_label_request(p_factory text, p_items jsonb)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_req uuid; v_no text; v_run text; v_seq int; v_fac text; r jsonb; v_item public.items; v_qty numeric; v_count int := 0;
begin
  if my_factory_code() <> 'HEAD_OFFICE' and p_factory <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if not has_perm('material_requests', 'edit') then raise exception 'Not allowed'; end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  v_fac := coalesce(nullif(regexp_replace(p_factory, '[^0-9]', '', 'g'), ''), p_factory);
  select coalesce(max((split_part(pick_run_no, '/', 2))::int), 0) + 1 into v_seq
    from public.material_requests
   where factory_code = p_factory
     and pick_run_no like 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/%';
  v_run := 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status, manual, released_at, pick_run_no)
  values (v_no, null, p_factory, 'Open', true, now(), v_run) returning id into v_req;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce((r->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into v_item from public.items where code = r->>'code' limit 1;
    insert into public.material_request_items
      (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code,
       label_for_product, label_batch_no, label_exp_date, label_print_qty)
    values (v_req, v_item.id, coalesce(v_item.code, r->>'code'), coalesce(v_item.description, r->>'description'),
            coalesce(v_item.unit, r->>'unit'), v_qty, 0, v_qty, v_qty, 0, p_factory,
            nullif(r->>'for_product', ''), nullif(r->>'batch', ''), nullif(r->>'exp', '')::date, v_qty);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'Add at least one label'; end if;
  return v_req;
end; $function$;
grant execute on function public.raise_manual_label_request(text, jsonb) to authenticated;

-- ============================================================================
-- 2026-06 · Urgent orders + warehouse discussion
-- ============================================================================
-- Mark a sales document urgent; the flag flows to its production batches so the
-- highlight follows the order through the whole journey.
alter table public.sales_imports add column if not exists urgent boolean not null default false;
alter table public.production_batches add column if not exists urgent boolean not null default false;

create or replace function public.set_order_urgent(p_import_id uuid, p_urgent boolean) returns void
 language plpgsql security definer set search_path to 'public' as $function$
begin
  update public.sales_imports set urgent = p_urgent where id = p_import_id;
  update public.production_batches set urgent = p_urgent
   where id in (
     select pbi.batch_id from public.production_batch_items pbi
     where pbi.so_number in (
       select distinct so_number from public.sales_order_lines
        where import_id = p_import_id and so_number is not null));
end; $function$;
grant execute on function public.set_order_urgent(uuid, boolean) to authenticated;

-- Simple discussion board (e.g. warehouse <-> office). One row per message.
create table if not exists public.discussions (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'warehouse',
  author_id uuid,
  author_name text,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists discussions_channel on public.discussions (channel, created_at);
grant select, insert on public.discussions to authenticated;
alter table public.discussions enable row level security;
drop policy if exists discussions_read on public.discussions;
create policy discussions_read on public.discussions for select to authenticated using (true);
drop policy if exists discussions_insert on public.discussions;
create policy discussions_insert on public.discussions for insert to authenticated with check (author_id = auth.uid());

-- ============================================================================
-- 2026-06 · Edit sales lines directly BEFORE the line's factory confirms.
-- After confirmation, edits must go through the change-request approval flow.
-- ============================================================================
create or replace function public.edit_unconfirmed_sales_line(
  p_line_id uuid, p_customer text, p_so_number text, p_item_code text, p_description text,
  p_quantity text, p_outstanding text, p_delivery_date text, p_location text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Line not found'; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and coalesce(v_line.factory_code, '') <> '' and v_line.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if coalesce(v_line.factory_code, '') <> '' and exists (
       select 1 from public.document_confirmations dc
        where dc.import_id = v_line.import_id and dc.factory_code = v_line.factory_code)
  then raise exception 'Already confirmed — changes need Head Office approval'; end if;

  update public.sales_order_lines set
    customer_name   = coalesce(p_customer, customer_name),
    so_number       = coalesce(p_so_number, so_number),
    item_code       = coalesce(p_item_code, item_code),
    description     = coalesce(p_description, description),
    quantity        = coalesce(p_quantity::numeric, quantity),
    outstanding_qty = coalesce(p_outstanding::numeric, outstanding_qty),
    delivery_date   = coalesce(nullif(p_delivery_date, ''), delivery_date),
    location_code   = coalesce(p_location, location_code)
  where id = p_line_id;

  if p_location is not null then  -- relink the factory when the location changes
    update public.sales_order_lines sol set factory_code = lm.factory_code
      from public.location_map lm
     where sol.id = p_line_id
       and btrim(upper(lm.location_code)) = btrim(upper(coalesce(sol.location_code, '')))
       and coalesce(lm.factory_code, '') <> '';
  end if;
end; $function$;
grant execute on function public.edit_unconfirmed_sales_line(uuid, text, text, text, text, text, text, text, text) to authenticated;

create or replace function public.delete_unconfirmed_sales_line(p_line_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then return; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and coalesce(v_line.factory_code, '') <> '' and v_line.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if coalesce(v_line.factory_code, '') <> '' and exists (
       select 1 from public.document_confirmations dc
        where dc.import_id = v_line.import_id and dc.factory_code = v_line.factory_code)
  then raise exception 'Already confirmed — deletion needs Head Office approval'; end if;
  delete from public.sales_order_lines where id = p_line_id;
end; $function$;
grant execute on function public.delete_unconfirmed_sales_line(uuid) to authenticated;

-- Discussion messages can be linked to a specific sales order number.
alter table public.discussions add column if not exists so_number text;
create index if not exists discussions_so on public.discussions (so_number);

-- Regular users may only change Location & Delivery Date directly; Head Office any field.
create or replace function public.edit_unconfirmed_sales_line(
  p_line_id uuid, p_customer text, p_so_number text, p_item_code text, p_description text,
  p_quantity text, p_outstanding text, p_delivery_date text, p_location text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Line not found'; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and coalesce(v_line.factory_code, '') <> '' and v_line.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if coalesce(v_line.factory_code, '') <> '' and exists (
       select 1 from public.document_confirmations dc
        where dc.import_id = v_line.import_id and dc.factory_code = v_line.factory_code)
  then raise exception 'Already confirmed — changes need Head Office approval'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and (p_customer is not null or p_so_number is not null
       or p_item_code is not null or p_description is not null or p_quantity is not null or p_outstanding is not null)
  then raise exception 'Only Location and Delivery Date can be changed'; end if;

  update public.sales_order_lines set
    customer_name   = coalesce(p_customer, customer_name),
    so_number       = coalesce(p_so_number, so_number),
    item_code       = coalesce(p_item_code, item_code),
    description     = coalesce(p_description, description),
    quantity        = coalesce(p_quantity::numeric, quantity),
    outstanding_qty = coalesce(p_outstanding::numeric, outstanding_qty),
    delivery_date   = coalesce(nullif(p_delivery_date, ''), delivery_date),
    location_code   = coalesce(p_location, location_code)
  where id = p_line_id;

  if p_location is not null then
    update public.sales_order_lines sol set factory_code = lm.factory_code
      from public.location_map lm
     where sol.id = p_line_id
       and btrim(upper(lm.location_code)) = btrim(upper(coalesce(sol.location_code, '')))
       and coalesce(lm.factory_code, '') <> '';
  end if;
end; $function$;

-- ============================================================================
-- 2026-06 · Location notifications + bell
-- Staff see updates tied to their assigned location(s). One row per event,
-- targeted at a factory_code; "unseen" = created after the user's seen stamp.
-- ============================================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  type text not null default 'info',
  title text not null,
  body text,
  link text,
  ref text,                       -- dedupe key so the same event isn't repeated
  created_at timestamptz not null default now()
);
create index if not exists notifications_fac on public.notifications (factory_code, created_at desc);
create unique index if not exists notifications_ref on public.notifications (ref);
grant select, insert on public.notifications to authenticated, anon, service_role;
alter table public.notifications enable row level security;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (true);
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert to authenticated with check (true);

alter table public.profiles add column if not exists notifications_seen_at timestamptz not null default now();

create or replace function public.mark_notifications_seen() returns void
 language plpgsql security definer set search_path to 'public' as $function$
begin update public.profiles set notifications_seen_at = now() where id = auth.uid(); end; $function$;
grant execute on function public.mark_notifications_seen() to authenticated;

-- New order for a location → one notification per (document, factory)
create or replace function public.tg_notify_sales_line() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if coalesce(NEW.factory_code, '') <> '' then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'order',
            'New order ' || coalesce(NEW.so_number, ''),
            'A sales order for your location was added.', '/sales-orders',
            'neworder:' || NEW.import_id::text || ':' || NEW.factory_code)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists notify_sales_line on public.sales_order_lines;
create trigger notify_sales_line after insert or update of factory_code on public.sales_order_lines
  for each row execute function public.tg_notify_sales_line();

-- Urgent flag → notify every affected location
create or replace function public.set_order_urgent(p_import_id uuid, p_urgent boolean) returns void
 language plpgsql security definer set search_path to 'public' as $function$
begin
  update public.sales_imports set urgent = p_urgent where id = p_import_id;
  update public.production_batches set urgent = p_urgent
   where id in (
     select pbi.batch_id from public.production_batch_items pbi
     where pbi.so_number in (
       select distinct so_number from public.sales_order_lines
        where import_id = p_import_id and so_number is not null));
  if p_urgent then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    select distinct sol.factory_code, 'urgent', '🔴 Urgent order',
           'An order for your location was marked urgent.', '/sales-orders',
           'urgent:' || p_import_id::text || ':' || sol.factory_code
    from public.sales_order_lines sol
    where sol.import_id = p_import_id and coalesce(sol.factory_code, '') <> ''
    on conflict (ref) do nothing;
  end if;
end; $function$;
grant execute on function public.set_order_urgent(uuid, boolean) to authenticated;

-- ============================================================================
-- 2026-06 · Notifications for the rest of the journey (keep everyone updated)
-- Each trigger targets the relevant factory_code; HO sees all.
-- ============================================================================

-- Material request raised, and pick run released to the warehouse
create or replace function public.tg_notify_material_request() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if TG_OP = 'INSERT' then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'mr', 'Material request raised ' || coalesce(NEW.request_no, ''),
            'A material request was created for your location.', '/material-requests', 'mrnew:' || NEW.id::text)
    on conflict (ref) do nothing;
  elsif TG_OP = 'UPDATE' and OLD.released_at is null and NEW.released_at is not null then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'mr', 'Pick run released ' || coalesce(NEW.pick_run_no, ''),
            'Materials were released to the warehouse to pick.', '/material-requests', 'mrrel:' || NEW.id::text)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists notify_material_request on public.material_requests;
create trigger notify_material_request after insert or update of released_at on public.material_requests
  for each row execute function public.tg_notify_material_request();

-- A location confirms its sales-order lines (pushed to production)
create or replace function public.tg_notify_confirmation() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  insert into public.notifications (factory_code, type, title, body, link, ref)
  values (NEW.factory_code, 'confirm', 'Order confirmed',
          'Lines for your location were confirmed to production.', '/production',
          'conf:' || NEW.import_id::text || ':' || NEW.factory_code)
  on conflict (ref) do nothing;
  return NEW;
end; $function$;
drop trigger if exists notify_confirmation on public.document_confirmations;
create trigger notify_confirmation after insert on public.document_confirmations
  for each row execute function public.tg_notify_confirmation();

-- Goods received against a delivery order (status change)
create or replace function public.tg_notify_grn() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.status is distinct from OLD.status and NEW.status in ('Received', 'Partially Received') then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'grn', NEW.status || ': ' || coalesce(NEW.do_number, NEW.file_name),
            'A delivery order for your location was ' || lower(NEW.status) || '.', '/incoming',
            'grn:' || NEW.id::text || ':' || NEW.status)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists notify_grn on public.delivery_orders;
create trigger notify_grn after update of status on public.delivery_orders
  for each row execute function public.tg_notify_grn();

-- Finished goods delivered to the warehouse (batch dispatched)
create or replace function public.tg_notify_dispatch() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if OLD.dispatched_at is null and NEW.dispatched_at is not null then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'dispatch', 'Delivered to warehouse ' || coalesce(NEW.batch_no, ''),
            coalesce(NEW.item_code, '') || ' was delivered to the warehouse.', '/dispatch',
            'dispatch:' || NEW.id::text)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists notify_dispatch on public.production_batches;
create trigger notify_dispatch after update of dispatched_at on public.production_batches
  for each row execute function public.tg_notify_dispatch();

-- Discussion message linked to an SO → notify that order's location(s)
create or replace function public.tg_notify_discussion() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.so_number is not null then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    select distinct sol.factory_code, 'discussion', 'New message · SO ' || NEW.so_number,
           coalesce(NEW.author_name, 'Someone') || ': ' || left(NEW.body, 80),
           '/discussion?so=' || NEW.so_number,
           'disc:' || NEW.id::text || ':' || sol.factory_code
    from public.sales_order_lines sol
    where sol.so_number = NEW.so_number and coalesce(sol.factory_code, '') <> ''
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists notify_discussion on public.discussions;
create trigger notify_discussion after insert on public.discussions
  for each row execute function public.tg_notify_discussion();

-- Drop the "material request raised" notification — keep only "pick run released".
create or replace function public.tg_notify_material_request() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if OLD.released_at is null and NEW.released_at is not null then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'mr', 'Pick run released ' || coalesce(NEW.pick_run_no, ''),
            'Materials were released to the warehouse to pick.', '/material-requests', 'mrrel:' || NEW.id::text)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists notify_material_request on public.material_requests;
create trigger notify_material_request after update of released_at on public.material_requests
  for each row execute function public.tg_notify_material_request();

-- ============================================================================
-- 2026-06 · Supplier purchase orders (manual procurement reference)
-- ============================================================================
create table if not exists public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  note text,
  status text not null default 'Open',     -- Open | Received
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  received_at timestamptz
);
create table if not exists public.supplier_order_items (
  id uuid primary key default gen_random_uuid(),
  supplier_order_id uuid not null references public.supplier_orders(id) on delete cascade,
  item_code text not null,
  description text,
  qty numeric not null
);
create index if not exists supplier_order_items_oid on public.supplier_order_items (supplier_order_id);
grant select, insert, update, delete on public.supplier_orders to authenticated;
grant select, insert, update, delete on public.supplier_order_items to authenticated;
alter table public.supplier_orders enable row level security;
alter table public.supplier_order_items enable row level security;
drop policy if exists supplier_orders_all on public.supplier_orders;
create policy supplier_orders_all on public.supplier_orders for all to authenticated
  using (true) with check (true);
drop policy if exists supplier_order_items_all on public.supplier_order_items;
create policy supplier_order_items_all on public.supplier_order_items for all to authenticated
  using (true) with check (true);

-- ============================================================================
-- 2026-06 · Tag users in discussion + personal notifications
-- ============================================================================
alter table public.discussions add column if not exists mention_ids uuid[] not null default '{}';
alter table public.notifications add column if not exists user_id uuid;   -- personal (mention) notification when set

-- List of users to @tag (id + name), readable by any signed-in user
create or replace function public.list_users() returns table(id uuid, full_name text)
 language sql security definer set search_path to 'public' as $$
  select id, coalesce(full_name, '(no name)') from public.profiles order by full_name;
$$;
grant execute on function public.list_users() to authenticated;

-- Discussion → notify the order's location(s) AND any tagged users personally
create or replace function public.tg_notify_discussion() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
declare v_link text; uid uuid;
begin
  v_link := '/discussion' || case when NEW.so_number is not null then '?so=' || NEW.so_number else '' end;
  if NEW.so_number is not null then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    select distinct sol.factory_code, 'discussion', 'New message · SO ' || NEW.so_number,
           coalesce(NEW.author_name, 'Someone') || ': ' || left(NEW.body, 80), v_link,
           'disc:' || NEW.id::text || ':' || sol.factory_code
    from public.sales_order_lines sol
    where sol.so_number = NEW.so_number and coalesce(sol.factory_code, '') <> ''
    on conflict (ref) do nothing;
  end if;
  -- personal mentions
  if NEW.mention_ids is not null then
    foreach uid in array NEW.mention_ids loop
      insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
      values ('', uid, 'mention', coalesce(NEW.author_name, 'Someone') || ' mentioned you',
              left(NEW.body, 100), v_link, 'mention:' || NEW.id::text || ':' || uid::text)
      on conflict (ref) do nothing;
    end loop;
  end if;
  return NEW;
end; $function$;

-- ============================================================================
-- 2026-06 · Group tagging in discussion (e.g. @AVINA102 → all users there)
-- ============================================================================
alter table public.discussions add column if not exists mention_factories text[] not null default '{}';

create or replace function public.tg_notify_discussion() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
declare v_link text; uid uuid; fac text;
begin
  v_link := '/discussion' || case when NEW.so_number is not null then '?so=' || NEW.so_number else '' end;
  if NEW.so_number is not null then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    select distinct sol.factory_code, 'discussion', 'New message · SO ' || NEW.so_number,
           coalesce(NEW.author_name, 'Someone') || ': ' || left(NEW.body, 80), v_link,
           'disc:' || NEW.id::text || ':' || sol.factory_code
    from public.sales_order_lines sol
    where sol.so_number = NEW.so_number and coalesce(sol.factory_code, '') <> ''
    on conflict (ref) do nothing;
  end if;
  -- personal mentions
  if NEW.mention_ids is not null then
    foreach uid in array NEW.mention_ids loop
      insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
      values ('', uid, 'mention', coalesce(NEW.author_name, 'Someone') || ' mentioned you',
              left(NEW.body, 100), v_link, 'mention:' || NEW.id::text || ':' || uid::text)
      on conflict (ref) do nothing;
    end loop;
  end if;
  -- group (location) mentions → everyone at that location
  if NEW.mention_factories is not null then
    foreach fac in array NEW.mention_factories loop
      insert into public.notifications (factory_code, type, title, body, link, ref)
      values (fac, 'mention', coalesce(NEW.author_name, 'Someone') || ' tagged @' || fac,
              left(NEW.body, 100), v_link, 'mentionfac:' || NEW.id::text || ':' || fac)
      on conflict (ref) do nothing;
    end loop;
  end if;
  return NEW;
end; $function$;

-- ============================================================================
-- 2026-06 · Web push to phones (PWA). A notification insert pings /api/push,
-- which sends the push to the target users' subscribed devices.
-- ============================================================================
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);
grant select, insert, update, delete on public.push_subscriptions to authenticated;
alter table public.push_subscriptions enable row level security;
drop policy if exists push_sub_own on public.push_subscriptions;
create policy push_sub_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Fire an HTTP call to the app when a notification is created (pg_net).
create extension if not exists pg_net;
create or replace function public.tg_push_notification() returns trigger
 language plpgsql security definer set search_path to 'public, net' as $function$
begin
  perform net.http_post(
    url := 'https://production.srrieaswari.com/api/push',
    body := jsonb_build_object('id', NEW.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', 'd87b037136410885efffd99c2b8d781a4d23dd08cac062d6')
  );
  return NEW;
end; $function$;
drop trigger if exists push_notification on public.notifications;
create trigger push_notification after insert on public.notifications
  for each row execute function public.tg_push_notification();

-- ============================================================================
-- 2026-06 · Relax combined material request — allow multiple batches of the
-- same item/factory even if the literal status column is stale. Block only on
-- different item/factory or a batch that's already been requested (matches the
-- single-batch rule). Run mode is forced uniform by the app before calling.
-- ============================================================================
create or replace function public.raise_combined_material_request(p_batch_ids uuid[])
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_item text; v_factory text; v_mode text; v_total numeric; v_parent uuid; v_req uuid; v_no text; v_count int := 0; c record; v_short numeric; v_reqd numeric;
begin
  select item_code, factory_code, run_mode into v_item, v_factory, v_mode from public.production_batches where id = p_batch_ids[1];
  if v_item is null then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_factory <> all(my_factory_codes()) then raise exception 'Not allowed for this factory'; end if;
  if exists (select 1 from public.production_batches where id = any(p_batch_ids)
             and (item_code <> v_item or factory_code <> v_factory or material_request_id is not null)) then
    raise exception 'All batches must be the same item & factory and not already requested';
  end if;
  select coalesce(sum(total_quantity), 0) into v_total from public.production_batches where id = any(p_batch_ids);
  select id into v_parent from public.items where code = v_item limit 1;
  if v_parent is null then raise exception 'Item % not found in Items Master', v_item; end if;
  if not exists (select 1 from public.bom_components where parent_item_id = v_parent) then
    raise exception 'No BOM defined for %', v_item; end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status)
  values (v_no, p_batch_ids[1], v_factory, 'Open') returning id into v_req;
  for c in
    select bc.component_item_id as item_id, it.code, it.description, it.unit, bc.apply_allowance,
           bc.quantity * v_total as required_qty, coalesce(s.quantity, 0) as stock_qty
    from public.bom_components bc join public.items it on it.id = bc.component_item_id
    left join public.item_stock s on s.item_id = bc.component_item_id and s.factory_code = v_factory
    where bc.parent_item_id = v_parent
      and (bc.use_mode = 'any' or bc.use_mode = coalesce(v_mode, 'auto'))
  loop
    v_short := c.required_qty - c.stock_qty;
    if v_short > 0 then
      v_reqd := case when c.apply_allowance then ceil(v_short * 1.1) else v_short end;
      insert into public.material_request_items
        (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
      values (v_req, c.item_id, c.code, c.description, c.unit, c.required_qty, c.stock_qty, v_short, v_reqd, 0, v_factory);
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'No shortfall — enough stock on hand for all materials'; end if;
  update public.production_batches set status = 'Requested', material_request_id = v_req where id = any(p_batch_ids);
  return v_req;
end; $function$;

-- Reply to a specific discussion message
alter table public.discussions add column if not exists reply_to uuid;

-- ============================================================================
-- 2026-06 · BOM may use the product itself as a component (e.g. repack from own
-- bulk). Drop any check constraint that forbids parent = component.
-- ============================================================================
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.bom_components'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%parent_item_id%'
      and pg_get_constraintdef(oid) ilike '%component_item_id%'
  loop
    execute format('alter table public.bom_components drop constraint %I', r.conname);
  end loop;
end $$;

-- ============================================================================
-- 2026-06 · Ad-hoc materials on a material request (this order only).
-- Add an extra material to an already-open request without touching the BOM
-- (e.g. same product code packed 1kg vs 5kg needs a different plastic).
-- ============================================================================
create or replace function public.add_request_item(p_batch_id uuid, p_code text, p_qty numeric)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_batch public.production_batches; v_req uuid; v_item public.items;
begin
  select * into v_batch from public.production_batches where id = p_batch_id;
  if not found then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_batch.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if not has_perm('order_board', 'edit') and not has_perm('material_requests', 'edit') then
    raise exception 'Not allowed'; end if;
  v_req := v_batch.material_request_id;
  if v_req is null then raise exception 'Raise the material request first, then add ad-hoc materials'; end if;
  if exists (select 1 from public.material_request_items where request_id = v_req and received_qty > 0) then
    raise exception 'This request is already being received — cannot add materials'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter a quantity greater than zero'; end if;
  select * into v_item from public.items where code = p_code limit 1;
  insert into public.material_request_items
    (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
  values (v_req, v_item.id, coalesce(v_item.code, p_code), coalesce(v_item.description, p_code),
          coalesce(v_item.unit, 'Unit'), p_qty, 0, p_qty, p_qty, 0, v_batch.factory_code);
end; $function$;
grant execute on function public.add_request_item(uuid, text, numeric) to authenticated;

-- ============================================================================
-- 2026-06 · Record who raised each material request (all raise paths)
-- ============================================================================
alter table public.material_requests add column if not exists created_by uuid;
alter table public.material_requests add column if not exists created_by_name text;

create or replace function public.tg_mr_creator() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
begin
  if NEW.created_by is null then NEW.created_by := auth.uid(); end if;
  if NEW.created_by_name is null and NEW.created_by is not null then
    select full_name into NEW.created_by_name from public.profiles where id = NEW.created_by;
  end if;
  return NEW;
end; $function$;
drop trigger if exists mr_creator on public.material_requests;
create trigger mr_creator before insert on public.material_requests
  for each row execute function public.tg_mr_creator();

-- ============================================================================
-- 2026-06 · Ad-hoc material request from the Order Board — raise a request for
-- a batch (or combined batches) with custom material lines (same code can need
-- different packaging per order). Links to the batch like the normal request.
-- ============================================================================
create or replace function public.raise_material_request_custom(p_batch_ids uuid[], p_items jsonb)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_item text; v_factory text; v_req uuid; v_no text; r jsonb; v_it public.items; v_qty numeric; v_count int := 0;
begin
  select item_code, factory_code into v_item, v_factory from public.production_batches where id = p_batch_ids[1];
  if v_item is null then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_factory <> all(my_factory_codes()) then raise exception 'Not allowed for this factory'; end if;
  if exists (select 1 from public.production_batches where id = any(p_batch_ids)
             and (item_code <> v_item or factory_code <> v_factory or material_request_id is not null)) then
    raise exception 'All batches must be the same item & factory and not already requested';
  end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status)
  values (v_no, p_batch_ids[1], v_factory, 'Open') returning id into v_req;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce((r->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into v_it from public.items where code = r->>'code' limit 1;
    insert into public.material_request_items
      (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
    values (v_req, v_it.id, coalesce(v_it.code, r->>'code'), coalesce(v_it.description, r->>'description'),
            coalesce(v_it.unit, r->>'unit'), v_qty, 0, v_qty, v_qty, 0, v_factory);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'Add at least one material with a quantity'; end if;
  update public.production_batches set status = 'Requested', material_request_id = v_req where id = any(p_batch_ids);
  return v_req;
end; $function$;
grant execute on function public.raise_material_request_custom(uuid[], jsonb) to authenticated;

-- ============================================================================
-- 2026-06 · Request extra materials to run stock (beyond the order). The extra
-- is recorded on the request so the next order can be told stock was requested.
-- ============================================================================
alter table public.material_requests add column if not exists extra_qty numeric not null default 0;
alter table public.material_requests add column if not exists note text;

create or replace function public.raise_material_request_ext(p_batch_ids uuid[], p_items jsonb, p_extra numeric, p_note text)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_item text; v_factory text; v_req uuid; v_no text; r jsonb; v_it public.items; v_qty numeric; v_count int := 0;
begin
  select item_code, factory_code into v_item, v_factory from public.production_batches where id = p_batch_ids[1];
  if v_item is null then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_factory <> all(my_factory_codes()) then raise exception 'Not allowed for this factory'; end if;
  if exists (select 1 from public.production_batches where id = any(p_batch_ids)
             and (item_code <> v_item or factory_code <> v_factory or material_request_id is not null)) then
    raise exception 'All batches must be the same item & factory and not already requested';
  end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status, extra_qty, note)
  values (v_no, p_batch_ids[1], v_factory, 'Open', coalesce(p_extra, 0), p_note) returning id into v_req;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce((r->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into v_it from public.items where code = r->>'code' limit 1;
    insert into public.material_request_items
      (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
    values (v_req, v_it.id, coalesce(v_it.code, r->>'code'), coalesce(v_it.description, r->>'description'),
            coalesce(v_it.unit, r->>'unit'), v_qty, 0, v_qty, v_qty, 0, v_factory);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'Add at least one material with a quantity'; end if;
  update public.production_batches set status = 'Requested', material_request_id = v_req where id = any(p_batch_ids);
  return v_req;
end; $function$;
grant execute on function public.raise_material_request_ext(uuid[], jsonb, numeric, text) to authenticated;

-- ============================================================================
-- 2026-06 · Per-user customer filter — limit a user's Sales Orders to one
-- customer (by name prefix), e.g. sem118 sees only "GCH..." customers.
-- Additive & safe: only affects users who have customer_filter set.
-- ============================================================================
alter table public.profiles add column if not exists customer_filter text;

create or replace function public.my_customer_filter() returns text
 language sql stable security definer set search_path to 'public' as $$
  select nullif(btrim(customer_filter), '') from public.profiles where id = auth.uid();
$$;
grant execute on function public.my_customer_filter() to authenticated;

-- Lines: filtered users are GRANTED their customer's lines and RESTRICTED from the rest
drop policy if exists sol_customer_grant on public.sales_order_lines;
create policy sol_customer_grant on public.sales_order_lines for select to authenticated
  using (public.my_customer_filter() is not null and coalesce(customer_name, '') ilike public.my_customer_filter() || '%');
drop policy if exists sol_customer_restrict on public.sales_order_lines;
create policy sol_customer_restrict on public.sales_order_lines as restrictive for select to authenticated
  using (public.my_customer_filter() is null or coalesce(customer_name, '') ilike public.my_customer_filter() || '%');

-- Documents: a filtered user only sees documents that contain a matching line
drop policy if exists si_customer_grant on public.sales_imports;
create policy si_customer_grant on public.sales_imports for select to authenticated
  using (public.my_customer_filter() is not null and exists (
    select 1 from public.sales_order_lines l where l.import_id = sales_imports.id
      and coalesce(l.customer_name, '') ilike public.my_customer_filter() || '%'));
drop policy if exists si_customer_restrict on public.sales_imports;
create policy si_customer_restrict on public.sales_imports as restrictive for select to authenticated
  using (public.my_customer_filter() is null or exists (
    select 1 from public.sales_order_lines l where l.import_id = sales_imports.id
      and coalesce(l.customer_name, '') ilike public.my_customer_filter() || '%'));

-- Apply to sem118 (Aisyah)
update public.profiles set customer_filter = 'GCH' where username = 'sem118';

-- 2026-06 · GCH added as a selectable location/site (non-production, like SUPPLIER)
insert into public.factories (code, name) values ('GCH', 'GCH') on conflict (code) do nothing;

-- Fix: a filtered user must still be able to UPLOAD a document. The new
-- sales_imports row has no lines yet, so the "has a matching line" SELECT check
-- failed on INSERT...RETURNING. Allow rows the user uploaded too.
drop policy if exists si_customer_grant on public.sales_imports;
create policy si_customer_grant on public.sales_imports for select to authenticated
  using (public.my_customer_filter() is not null and (uploaded_by = auth.uid() or exists (
    select 1 from public.sales_order_lines l where l.import_id = sales_imports.id
      and coalesce(l.customer_name, '') ilike public.my_customer_filter() || '%')));
drop policy if exists si_customer_restrict on public.sales_imports;
create policy si_customer_restrict on public.sales_imports as restrictive for select to authenticated
  using (public.my_customer_filter() is null or uploaded_by = auth.uid() or exists (
    select 1 from public.sales_order_lines l where l.import_id = sales_imports.id
      and coalesce(l.customer_name, '') ilike public.my_customer_filter() || '%'));

-- Label details (batch/expiry/qty) are saved once and locked; record who/when.
alter table public.material_request_items add column if not exists label_printed_by uuid;
alter table public.material_request_items add column if not exists label_printed_by_name text;
alter table public.material_request_items add column if not exists label_printed_at timestamptz;

-- ============================================================================
-- 2026-06 · "Stock code" override on items. When a bag/pack SKU's code differs
-- from the loose/recipe code (e.g. E035-25KG/BAG should stock as S035), set
-- stock_code on the pack item; Goods Received then books into that code and
-- matches that material request.
-- ============================================================================
alter table public.items add column if not exists stock_code text;
