-- 2026-07 · EASWARI — Driver app setup: photo bucket + (optional) test data
-- ----------------------------------------------------------------------------
-- Run in the Supabase SQL Editor. Safe to re-run (idempotent).
-- ============================================================================

-- 1) Storage bucket for delivery proof photos (private; we read via signed URLs,
--    same pattern as the existing 'delivery-orders' bucket).
insert into storage.buckets (id, name, public)
values ('delivery-photos', 'delivery-photos', false)
on conflict (id) do nothing;

-- Permissive storage access for the placeholder-auth phase (locked down with
-- real Supabase Auth before launch — same approach as the new tables' RLS).
drop policy if exists delphotos_all on storage.objects;
create policy delphotos_all on storage.objects
  for all using (bucket_id = 'delivery-photos') with check (bucket_id = 'delivery-photos');

-- 2) OPTIONAL test data so /driver/today has stops to show right now.
--    Creates one "Test Driver" and three stops for TODAY. Delete later with:
--      delete from public.deliveries where customer in
--        ('AVINA Warehouse','Tesco Distribution, Klang','Mill Gate Stop');
--      delete from public.drivers where name = 'Test Driver';
insert into public.drivers (name, phone, active)
select 'Test Driver', '0123456789', true
where not exists (select 1 from public.drivers where name = 'Test Driver');

-- Use Kuala Lumpur's "today" (not UTC current_date) so it matches the driver app.
insert into public.deliveries (driver_id, customer, address, scheduled_date, sequence, status, gate_device_id)
select dr.id, v.customer, v.address, (now() at time zone 'Asia/Kuala_Lumpur')::date, v.seq, 'pending', v.gate
from public.drivers dr
cross join (values
  ('AVINA Warehouse',        'Lot 12, Jalan Industri, Shah Alam', 1, null::text),
  ('Tesco Distribution, Klang','KM5, Federal Highway, Klang',      2, null::text),
  ('Mill Gate Stop',         'SRRI Easwari Mill, Main Gate',       3, 'tuya-gate-001')
) as v(customer, address, seq, gate)
where dr.name = 'Test Driver'
  and not exists (
    select 1 from public.deliveries de
    where de.driver_id = dr.id
      and de.scheduled_date = (now() at time zone 'Asia/Kuala_Lumpur')::date
  );
