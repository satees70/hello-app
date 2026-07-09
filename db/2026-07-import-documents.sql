-- 2026-07 · Import Shipment Management — documents + auto-detect (step 3)
-- ============================================================================
-- WHY: staff want to upload the paperwork for a shipment (a supplier SALES
-- ORDER, a commercial/proforma INVOICE, or a BILL OF LADING) and have the app
-- read it and pre-fill the shipment for them — supplier, reference, BL number,
-- container numbers, and item lines. It is OPTIONAL: you can still type
-- everything by hand, and a shipment can start from ANY of these documents (you
-- might have the BL first, the invoice first, etc.).
--
-- This step adds (a) a private storage bucket to hold the uploaded files, and
-- (b) a table that records each uploaded document, what type it is, and the
-- data the model read out of it (kept as jsonb so you can review before it is
-- applied to the shipment). The actual reading is done by an app API route
-- using the Anthropic API — the SAME pattern as extract-sales-order — which
-- does not need any SQL.
--
-- ⚠️  RUN THIS BY HAND in the Supabase SQL editor. Idempotent / safe to re-run.
--
-- SECURITY: gated by the 'import' permission via has_perm(), like the rest of
--     the Import tables. The bucket is PRIVATE; the app reads files with the
--     service role and shows them via signed URLs.
-- ============================================================================


-- 1) Private storage bucket for the uploaded PDFs -----------------------------
insert into storage.buckets (id, name, public)
values ('import-docs', 'import-docs', false)
on conflict (id) do nothing;

-- Only signed-in staff WITH the import permission may read/write/remove files
-- in this bucket (has_perm reads the caller's JWT, so anon gets nothing).
drop policy if exists import_docs_read   on storage.objects;
drop policy if exists import_docs_write  on storage.objects;
drop policy if exists import_docs_delete on storage.objects;
create policy import_docs_read   on storage.objects for select to authenticated
  using (bucket_id = 'import-docs' and has_perm('import', 'view'));
create policy import_docs_write  on storage.objects for insert to authenticated
  with check (bucket_id = 'import-docs' and has_perm('import', 'edit'));
create policy import_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'import-docs' and has_perm('import', 'edit'));


-- 2) Document records ---------------------------------------------------------
-- One row per uploaded file. `extracted` holds whatever the model read (supplier
-- name, reference, BL, containers, items…) so it can be shown for review and
-- then applied to the shipment. `status` tracks that little lifecycle.
create table if not exists public.import_documents (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.import_shipments(id) on delete cascade,
  bl_id            uuid references public.import_bills_of_lading(id) on delete set null,  -- optional link (future)
  doc_type         text not null default 'other'
    check (doc_type in ('sales_order', 'invoice', 'bill_of_lading', 'packing_list', 'other')),
  file_name        text,
  file_path        text not null,                 -- path inside the import-docs bucket
  status           text not null default 'Uploaded'
    check (status in ('Uploaded', 'Processing', 'Review', 'Applied', 'Error')),
  extracted        jsonb,                          -- structured data the model read
  error_message    text,
  uploaded_by      uuid,
  uploaded_by_name text,
  created_at       timestamptz not null default now()
);
create index if not exists import_documents_shipment on public.import_documents (shipment_id);


-- 3) Grants + Row Level Security ---------------------------------------------
grant select, insert, update, delete on public.import_documents to authenticated;
alter table public.import_documents enable row level security;

drop policy if exists import_documents_read   on public.import_documents;
drop policy if exists import_documents_insert on public.import_documents;
drop policy if exists import_documents_update on public.import_documents;
drop policy if exists import_documents_delete on public.import_documents;
create policy import_documents_read   on public.import_documents for select using (has_perm('import', 'view'));
create policy import_documents_insert on public.import_documents for insert with check (has_perm('import', 'edit'));
create policy import_documents_update on public.import_documents for update using (has_perm('import', 'edit')) with check (has_perm('import', 'edit'));
create policy import_documents_delete on public.import_documents for delete using (has_perm('import', 'edit'));
