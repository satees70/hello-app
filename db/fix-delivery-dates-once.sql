-- ============================================================================
-- ONE-TIME FIX — run this ONCE only, then delete/ignore this file.
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
