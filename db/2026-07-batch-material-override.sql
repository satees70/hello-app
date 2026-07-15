-- Per-batch material substitution: swap a recipe material for a different item on THIS batch
-- only (e.g. the recipe calls for HM1530 but it's out, so pack with a different HM you have in
-- stock). It does NOT change the global recipe (bom_components) — only how this one batch's
-- material breakdown and shortfall are worked out on the Packing Schedule.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists public.production_batch_material_overrides (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.production_batches(id) on delete cascade,
  orig_item_id uuid not null,      -- the BOM component being replaced
  new_item_id uuid not null,       -- the substitute item
  new_item_code text,
  note text,
  created_by uuid, created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, orig_item_id)
);
grant select on public.production_batch_material_overrides to authenticated, anon, service_role;
grant insert, update, delete on public.production_batch_material_overrides to service_role;
alter table public.production_batch_material_overrides enable row level security;
drop policy if exists pbmo_read on public.production_batch_material_overrides;
create policy pbmo_read on public.production_batch_material_overrides for select using (has_perm('packing','view'));

-- Set (or clear, when p_new_item_code is blank) the substitute for one material on a batch.
create or replace function public.set_batch_material_override(p_batch_id uuid, p_orig_item_id uuid, p_new_item_code text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_fac text; v_new_id uuid; v_name text;
begin
  if not has_perm('packing','edit') then raise exception 'Not allowed to change materials'; end if;
  select factory_code into v_fac from public.production_batches where id = p_batch_id;
  if v_fac is null then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  if coalesce(p_new_item_code,'') = '' then
    delete from public.production_batch_material_overrides where batch_id = p_batch_id and orig_item_id = p_orig_item_id;
    return;
  end if;
  select id into v_new_id from public.items where code = p_new_item_code limit 1;
  if v_new_id is null then raise exception 'Item % is not in the Items master — add it there first', p_new_item_code; end if;
  insert into public.production_batch_material_overrides (batch_id, orig_item_id, new_item_id, new_item_code, note, created_by, created_by_name)
  values (p_batch_id, p_orig_item_id, v_new_id, p_new_item_code, nullif(p_note,''), auth.uid(), v_name)
  on conflict (batch_id, orig_item_id) do update
    set new_item_id = excluded.new_item_id, new_item_code = excluded.new_item_code, note = excluded.note,
        created_by = excluded.created_by, created_by_name = excluded.created_by_name, updated_at = now();
end $$;
grant execute on function public.set_batch_material_override(uuid, uuid, text, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
