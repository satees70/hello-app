-- ============================================================================
-- ⛔ DO NOT RUN — VERIFIED NOT NEEDED (checked 2026-07-02).
-- Stored delivery dates already match the source Excel (e.g. SO-40792 = 19/06
-- in both). The parser fix (deployed 2026-06-29) means all rows since are
-- correct too. Running the blanket +1 shift below would now CORRUPT the ~79
-- correctly-stored rows. Kept only as a historical record.
-- ============================================================================
-- ONE-TIME FIX — (obsolete) originally intended to run ONCE only.
-- ----------------------------------------------------------------------------
-- Delivery schedules saved before the date-parsing fix stored every Excel date
-- one day too early (SheetJS timezone/float drift). This shifts every ISO date
-- (YYYY-MM-DD) inside the stored `data` JSON forward by one day so it matches
-- the original Excel. The user-picked `delivery_date` column is NOT touched.
--
-- ⚠️  Running this more than once will push the dates too far. Run it a single time.
-- ============================================================================

update delivery_schedule ds
set data = (
  select jsonb_object_agg(
    kv.key,
    case
      when jsonb_typeof(kv.value) = 'string'
       and (kv.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
      then to_jsonb((((kv.value #>> '{}')::date) + 1)::text)
      else kv.value
    end
  )
  from jsonb_each(ds.data) as kv
)
where ds.data is not null
  and exists (
    select 1
    from jsonb_each(ds.data) e
    where jsonb_typeof(e.value) = 'string'
      and (e.value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
  );

-- Quick check afterwards (optional): the dates below should now match your Excel.
-- select so_number, data->>'Date' as doc_date, data->>'UDF_PODELDATE' as po_del_date
-- from delivery_schedule order by created_at desc limit 20;
