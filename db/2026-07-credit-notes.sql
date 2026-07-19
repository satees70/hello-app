-- Customer Credit Notes (CN) — reference copies of CNs raised in SQL Account.
--
-- Costing stays in SQL Account. Here you only UPLOAD the CN's PDF and tag it (CN no, customer,
-- date, linked SO) so it can be found and viewed — there is no manual CN creation and no amounts.
-- A PDF is always required (you can't save a CN without the document), so nothing is "created"
-- here, only referenced.
--
-- The PDF itself is stored in the existing 'delivery-orders' storage bucket under a 'credit-notes/'
-- prefix (reuses working storage access — no new bucket needed).
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  cn_number text,
  customer_name text,
  so_number text,
  cn_date date,
  note text,
  file_path text,
  file_name text,
  factory_code text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);
alter table public.credit_notes enable row level security;

-- Read: anyone with Sales view. Write (upload / edit tags / delete): Sales edit. No costing columns exist.
drop policy if exists credit_notes_read on public.credit_notes;
create policy credit_notes_read on public.credit_notes for select to authenticated using (has_perm('sales', 'view'));
drop policy if exists credit_notes_write on public.credit_notes;
create policy credit_notes_write on public.credit_notes for all to authenticated
  using (has_perm('sales', 'edit')) with check (has_perm('sales', 'edit'));

notify pgrst, 'reload schema';
