import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { fetchPunches } from '@/lib/zklink'

// ZKLink → attendance_punches sync.
// ----------------------------------------------------------------------------
// Pulls punches from the last synced day (re-pulling that day; dedupe by
// source_id absorbs the overlap) through today (Asia/Kuala_Lumpur), or from the
// backfill start on the very first run. Triggered by a cron, or manually in the
// browser. Override the window with ?from=yyyy-MM-dd.
//
// Protection: if CRON_SECRET is set, the request must pass ?key=<secret> (or an
// Authorization: Bearer <secret> header). With no CRON_SECRET set it's open —
// fine for dev, set the secret before exposing this publicly.

export const dynamic = 'force-dynamic'
export const maxDuration = 60   // paging through many days can take a while

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const TZ = 'Asia/Kuala_Lumpur'
const DEFAULT_BACKFILL_START = process.env.ZKLINK_BACKFILL_START || '2026-06-01'

// yyyy-MM-dd for "now" in Kuala Lumpur.
function klToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

export async function GET(request: Request) {
  const url = new URL(request.url)

  // Cron / manual protection.
  const secret = process.env.CRON_SECRET
  if (secret) {
    const key = url.searchParams.get('key')
      || request.headers.get('authorization')?.replace('Bearer ', '')
    if (key !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = klToday()

  // Start from ?from=, else where we left off, else the backfill start.
  let startDate = url.searchParams.get('from') || ''
  if (!startDate) {
    const { data: state } = await supabaseAdmin
      .from('sync_state').select('last_synced_date').eq('key', 'zklink').maybeSingle()
    startDate = state?.last_synced_date || DEFAULT_BACKFILL_START
  }

  // Pull from ZKLink.
  let punches
  try {
    punches = await fetchPunches(startDate, today)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  // Build rows; dedupe within this batch on source_id = code|time.
  const seen = new Set<string>()
  const rows = []
  for (const p of punches) {
    if (!p.employee_code || !p.punch_time) continue
    const source_id = `${p.employee_code}|${p.punch_time}`
    if (seen.has(source_id)) continue
    seen.add(source_id)
    rows.push({
      employee_code: p.employee_code,
      // Device time is KL local; tag +08:00 so it stores as the right instant.
      punch_time: `${p.punch_time.replace(' ', 'T')}+08:00`,
      source_id,
      first_name: null,                         // event API doesn't return a name
      department_name: p.device_name ?? null,   // store the device for context
      raw: p.raw ?? p,
    })
  }

  // Insert new punches; ignore any source_id we already have.
  let inserted = 0
  if (rows.length) {
    const { data, error } = await supabaseAdmin
      .from('attendance_punches')
      .upsert(rows, { onConflict: 'source_id', ignoreDuplicates: true })
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    inserted = data?.length ?? 0
  }

  // Advance the cursor.
  const nowIso = new Date().toISOString()
  await supabaseAdmin.from('sync_state').upsert(
    { key: 'zklink', last_synced_at: nowIso, last_synced_date: today, updated_at: nowIso },
    { onConflict: 'key' },
  )

  return NextResponse.json({
    ok: true,
    range: { from: startDate, to: today },
    pulled: punches.length,
    inserted,
  })
}
