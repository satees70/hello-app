-- Anabloom — add tenant identity fields (company registration numbers + address).
-- WHY: tenants can be individuals (IC number) or companies (old + new SSM
-- registration numbers), and the tenancy agreement needs the tenant's address.
--
-- Run this in the Supabase SQL editor for the anabloom project. It does NOT
-- deploy with the app code. Safe to re-run (idempotent).

alter table "Tenant" add column if not exists "regNoOld" text;
alter table "Tenant" add column if not exists "regNoNew" text;
alter table "Tenant" add column if not exists "address"  text;
