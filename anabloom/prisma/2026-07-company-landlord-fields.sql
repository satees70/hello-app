-- Anabloom — add landlord fields to Company (for auto-filling tenancy agreements).
-- WHY: the tenancy agreement needs the landlord's address, phone, bank details
-- and authorised signatory. These are set per company in Settings.
--
-- Run this in the Supabase SQL editor for the anabloom project. It does NOT
-- deploy with the app code. Safe to re-run (idempotent).

alter table "Company" add column if not exists "address"       text;
alter table "Company" add column if not exists "phone"         text;
alter table "Company" add column if not exists "bankName"      text;
alter table "Company" add column if not exists "bankAccountNo" text;
alter table "Company" add column if not exists "signatoryName" text;
alter table "Company" add column if not exists "signatoryNric" text;
