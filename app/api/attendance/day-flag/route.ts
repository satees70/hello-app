import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Per-day HR overrides for one employee/day: exclude_ot (don't count that day's
// OT) and force_half (count the day as a half day). The caller sends only the
// flag(s) it's changing; the other keeps its stored value. When both end up
// false the row is removed.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const { employee_code, work_date, exclude_ot, force_half } = await request.json()
  if (!employee_code || !work_date) {
    return NextResponse.json({ error: 'Missing employee_code or work_date' }, { status: 400 })
  }

  const { data: cur } = await admin.from('attendance_day_flags')
    .select('exclude_ot, force_half').eq('employee_code', employee_code).eq('work_date', work_date).maybeSingle()

  const next = {
    exclude_ot: exclude_ot === undefined ? (cur?.exclude_ot ?? false) : !!exclude_ot,
    force_half: force_half === undefined ? (cur?.force_half ?? false) : !!force_half,
  }

  if (!next.exclude_ot && !next.force_half) {
    const { error } = await admin.from('attendance_day_flags').delete()
      .eq('employee_code', employee_code).eq('work_date', work_date)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('attendance_day_flags')
    .upsert({ employee_code, work_date, ...next, updated_at: new Date().toISOString() }, { onConflict: 'employee_code,work_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
