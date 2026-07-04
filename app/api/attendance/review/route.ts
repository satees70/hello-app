import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Save (or clear) a human's decision for one employee on one day. One row per
// employee per work_date in attendance_reviews. lunch_decision is one of:
//   'deduct'         — subtract the profile's fixed lunch minutes
//   'worked_through' — no lunch deduction (count the whole span)
//   'manual'         — use manual_minutes as the worked total
// action 'clear' removes the review so the day reverts to auto.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const body = await request.json()
  const { employee_code, work_date } = body
  if (!employee_code || !work_date) {
    return NextResponse.json({ error: 'Missing employee_code or work_date' }, { status: 400 })
  }

  if (body.action === 'clear') {
    const { error } = await admin.from('attendance_reviews').delete()
      .eq('employee_code', employee_code).eq('work_date', work_date)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const valid = ['deduct', 'worked_through', 'manual', 'manual_time', 'span']
  if (!valid.includes(body.lunch_decision)) {
    return NextResponse.json({ error: 'Invalid lunch_decision' }, { status: 400 })
  }

  // manual_time = one or more clock times typed by hand (HH:mm) — the day is then
  // paired with them and shown as manually edited. Keep EVERY time (e.g. a full
  // "08:30, 17:00" pair), not just the first, so a whole day can be entered.
  const times = body.lunch_decision === 'manual_time'
    ? ((body.manual_time ?? '').toString().match(/\d{1,2}:\d{2}/g) || []).map((t: string) => t.padStart(5, '0'))
    : []
  const manual_time = times.length ? times.join(', ') : null

  const row = {
    employee_code,
    work_date,
    lunch_decision: body.lunch_decision,
    manual_minutes: body.lunch_decision === 'manual'
      ? (body.manual_minutes != null && body.manual_minutes !== '' ? Number(body.manual_minutes) : 0)
      : null,
    manual_time,
    reviewed_by_name: (body.reviewed_by_name ?? '').trim() || null,
    reviewed_at: new Date().toISOString(),
  }

  const { error } = await admin.from('attendance_reviews').upsert(row, { onConflict: 'employee_code,work_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
