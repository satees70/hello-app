-- Let production/packing staff CORRECT the live system on-hand for a material at a factory
-- (e.g. a packaging item the system shows short but is actually available), directly from the
-- Packing Schedule material list. Sets the absolute quantity and ALLOWS a negative value — the
-- owner asked to be able to save even when it goes below zero.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.set_item_stock(p_item_id uuid, p_factory text, p_qty numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('packing','edit') then raise exception 'Not allowed to edit stock'; end if;
  if p_item_id is null or coalesce(p_factory,'') = '' then raise exception 'Item and factory are required'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (p_factory = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  if p_qty is null then raise exception 'Enter a stock quantity'; end if;
  -- Absolute set (not add), negative allowed on purpose.
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (p_item_id, p_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = excluded.quantity, updated_at = now();
end $$;
grant execute on function public.set_item_stock(uuid, text, numeric) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
