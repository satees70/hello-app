-- One-time: collapse EXISTING cancel notes so all notes for the same sales order share a single
-- (earliest) Cancel Note number — e.g. SO-40895's CN-00024 / 00025 / 00026 all become CN-00024.
-- Safe to re-run (after the first run each SO already has one number, so nothing changes).
-- Run in the Supabase SQL editor.

with canon as (
  select so_number, min(cancel_note_no) as cn
  from public.so_balance_cancel_requests
  where cancel_note_no is not null and so_number is not null
  group by so_number
)
update public.so_balance_cancel_requests r
  set cancel_note_no = c.cn
  from canon c
  where r.so_number = c.so_number and r.cancel_note_no is not null and r.cancel_note_no <> c.cn;

with canon as (
  select so_number, min(cancel_note_no) as cn
  from public.so_balance_cancel_requests
  where cancel_note_no is not null and so_number is not null
  group by so_number
)
update public.sales_order_lines l
  set balance_cancel_no = c.cn
  from canon c
  where l.so_number = c.so_number and l.balance_cancel_no is not null and l.balance_cancel_no <> c.cn;
