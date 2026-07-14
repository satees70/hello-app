-- WMS: per-item reorder level for low-stock alerts. Run in Supabase. Idempotent.
-- Read-only reports use existing data; this is the only stored config they add.
create table if not exists public.wms_item_settings (
  item_id uuid references public.items(id),
  item_code text primary key,
  reorder_level numeric,
  notes text,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.wms_item_settings to authenticated, anon, service_role;
alter table public.wms_item_settings enable row level security;
drop policy if exists wms_item_settings_read on public.wms_item_settings;
create policy wms_item_settings_read on public.wms_item_settings for select using (has_perm('warehouse','view'));
drop policy if exists wms_item_settings_write on public.wms_item_settings;
create policy wms_item_settings_write on public.wms_item_settings for all using (has_perm('warehouse','edit')) with check (has_perm('warehouse','edit'));
notify pgrst, 'reload schema';
