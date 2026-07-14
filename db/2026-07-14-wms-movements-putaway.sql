-- WMS Module 3a: movement ledger + directed putaway (and a logged stock-adjust).
-- Run in the Supabase SQL editor. Adds ONE table (wms_stock_moves) + 2 functions.
-- Every warehouse stock change flows through a function that also records a move —
-- the audit trail and the future "results out" channel to SQL Account.

-- 1) The movement log. Direction is implied by from/to: putaway has only a "to" bin,
--    a pick has only a "from" bin, a transfer has both.
create table if not exists public.wms_stock_moves (
  id                 uuid primary key default gen_random_uuid(),
  warehouse_code     text not null default '8BT',
  move_type          text not null,   -- 'putaway' | 'pick' | 'adjust' | 'transfer'
  item_id            uuid references public.items(id),
  item_code          text not null,
  description        text,
  from_location_id   uuid references public.wms_locations(id),
  from_location_code text,
  to_location_id     uuid references public.wms_locations(id),
  to_location_code   text,
  batch_no           text not null default '',
  exp_date           date,
  quantity           numeric not null,     -- always positive
  reference          text,                 -- GRN / order no / reason
  moved_by           uuid,
  moved_by_name      text,
  created_at         timestamptz not null default now()
);
create index if not exists wms_moves_item on public.wms_stock_moves(item_id, created_at desc);
create index if not exists wms_moves_when on public.wms_stock_moves(created_at desc);
create index if not exists wms_moves_type on public.wms_stock_moves(move_type);

grant select, insert, update, delete on public.wms_stock_moves to authenticated, anon, service_role;
alter table public.wms_stock_moves enable row level security;
drop policy if exists wms_moves_read on public.wms_stock_moves;
create policy wms_moves_read on public.wms_stock_moves for select using (has_perm('warehouse','view'));
drop policy if exists wms_moves_write on public.wms_stock_moves;
create policy wms_moves_write on public.wms_stock_moves for all using (has_perm('warehouse','edit')) with check (has_perm('warehouse','edit'));

-- 2) Directed putaway: ADD p_qty of an item into a bin (consolidates with existing
--    stock of the same item+batch in that bin) and log a 'putaway' move.
create or replace function public.wms_putaway(
  p_item_code text, p_location_id uuid, p_qty numeric,
  p_batch text default '', p_exp_date date default null, p_reference text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_loc_code text; v_name text;
  v_batch text := coalesce(p_batch, '');
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select code into v_loc_code from wms_locations where id = p_location_id;
  if v_loc_code is null then raise exception 'That bin is not in the Location Map'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_item_id, p_item_code, v_desc, p_location_id, v_loc_code, v_batch, p_exp_date, p_qty, v_uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
  do update set quantity = wms_stock.quantity + excluded.quantity,
                exp_date = coalesce(excluded.exp_date, wms_stock.exp_date),
                updated_at = now();

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'putaway', v_item_id, p_item_code, v_desc,
    p_location_id, v_loc_code, v_batch, p_exp_date, p_qty, p_reference, auth.uid(), v_name);
end $$;
grant execute on function public.wms_putaway(text, uuid, numeric, text, date, text) to authenticated, anon, service_role;

-- 3) Logged adjust/correction: SET the on-hand of an item+batch in a bin to an exact
--    number (0 = remove) and log an 'adjust' move for the difference.
create or replace function public.wms_adjust_stock(
  p_item_code text, p_location_id uuid, p_batch text, p_exp_date date, p_new_qty numeric, p_reference text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_loc_code text; v_name text;
  v_batch text := coalesce(p_batch, ''); v_old numeric; v_delta numeric;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Quantity cannot be negative'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select code into v_loc_code from wms_locations where id = p_location_id;
  if v_loc_code is null then raise exception 'That bin is not in the Location Map'; end if;
  select quantity into v_old from wms_stock
    where warehouse_code = '8BT' and item_code = p_item_code and location_id = p_location_id and batch_no = v_batch;
  v_old := coalesce(v_old, 0);
  v_delta := p_new_qty - v_old;
  select full_name into v_name from profiles where id = auth.uid();

  if p_new_qty = 0 then
    delete from wms_stock
      where warehouse_code = '8BT' and item_code = p_item_code and location_id = p_location_id and batch_no = v_batch;
  else
    insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', v_item_id, p_item_code, v_desc, p_location_id, v_loc_code, v_batch, p_exp_date, p_new_qty, v_uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = excluded.quantity, exp_date = excluded.exp_date, description = excluded.description, updated_at = now();
  end if;

  if v_delta <> 0 then
    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'adjust', v_item_id, p_item_code, v_desc,
      case when v_delta < 0 then p_location_id end, case when v_delta < 0 then v_loc_code end,
      case when v_delta > 0 then p_location_id end, case when v_delta > 0 then v_loc_code end,
      v_batch, p_exp_date, abs(v_delta), p_reference, auth.uid(), v_name);
  end if;
end $$;
grant execute on function public.wms_adjust_stock(text, uuid, text, date, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
