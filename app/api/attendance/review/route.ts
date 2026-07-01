import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

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

  const valid = ['deduct', 'worked_through', 'manual', 'manual_time']
  if (!valid.includes(body.lunch_decision)) {
    return NextResponse.json({ error: 'Invalid lunch_decision' }, { status: 400 })
  }

  // manual_time = the missing punch typed in by hand (HH:mm) — the day is then
  // paired with it and shown as manually edited.
  const mt = (body.manual_time ?? '').toString().trim()
  const manual_time = body.lunch_decision === 'manual_time' && /^\d{1,2}:\d{2}/.test(mt) ? mt.slice(0, 5) : null

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
