import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Create / update / delete a shift profile (OT threshold + lunch rule).

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const body = await request.json()

  if (body.action === 'delete') {
    if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    const { error } = await admin.from('shift_profiles').delete().eq('id', body.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const cleanTime = (t: unknown) => {
    const s = (t ?? '').toString().trim()
    return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : null
  }

  const row: Record<string, unknown> = {
    name: (body.name ?? '').trim() || 'Shift',
    normal_hours: body.normal_hours != null && body.normal_hours !== '' ? Number(body.normal_hours) : 7.5,
    lunch_rule: body.lunch_rule === 'auto_deduct' ? 'auto_deduct' : 'punch',
    lunch_minutes: body.lunch_minutes != null && body.lunch_minutes !== '' ? Number(body.lunch_minutes) : 60,
    shift_start: cleanTime(body.shift_start),
    shift_end: cleanTime(body.shift_end),
    ot_before: cleanTime(body.ot_before),
    ot_after: cleanTime(body.ot_after),
  }

  // Weekly schedule: keep only days 0..6 with a valid start AND end; else off.
  if (body.week_schedule && typeof body.week_schedule === 'object') {
    const ws: Record<string, { start: string; end: string } | null> = {}
    for (let d = 0; d <= 6; d++) {
      const e = body.week_schedule[String(d)]
      const s = cleanTime(e?.start), en = cleanTime(e?.end)
      ws[String(d)] = s && en ? { start: s, end: en } : null
    }
    row.week_schedule = ws
  }

  if (body.id) row.id = body.id

  const { error } = await admin.from('shift_profiles').upsert(row)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
