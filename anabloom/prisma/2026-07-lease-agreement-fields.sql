-- Anabloom — add lease fields for the tenancy agreement (Schedules H, I, J).
-- WHY: utility deposit, use-of-premises and renewal option are per-lease and
-- complete the auto-filled tenancy agreement.
--
-- Run this in the Supabase SQL editor for the anabloom project. It does NOT
-- deploy with the app code. Safe to re-run (idempotent).

alter table "Lease" add column if not exists "utilityDeposit" numeric(65,30) not null default 0;
alter table "Lease" add column if not exists "premisesUse"    text;
alter table "Lease" add column if not exists "renewalOption"  text;
