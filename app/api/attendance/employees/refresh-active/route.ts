import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Set employees.active from attendance: active = punched within the last N days
// of the latest punch. Anyone with no recent punch is marked inactive (a human
// can still flip it back on the Employees page).

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const WINDOW_DAYS = 14

export async function POST() {
  // Last punch per employee (page newest-first).
  const last = new Map<string, string>()
  let from = 0
  for (;;) {
    const { data, error } = await admin.from('attendance_punches')
      .select('employee_code, punch_time').order('punch_time', { ascending: false }).range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    for (const r of data) if (!last.has(r.employee_code)) last.set(r.employee_code, r.punch_time)
    if (data.length < 1000) break
    from += 1000
  }

  let maxTs = 0
  for (const v of last.values()) maxTs = Math.max(maxTs, Date.parse(v))
  const threshold = maxTs - WINDOW_DAYS * 86400000

  const { data: emps } = await admin.from('employees').select('employee_code')
  const activeCodes: string[] = [], inactiveCodes: string[] = []
  for (const e of emps || []) {
    const lp = last.get(e.employee_code)
    ;(lp && Date.parse(lp) >= threshold ? activeCodes : inactiveCodes).push(e.employee_code)
  }

  if (activeCodes.length) {
    const { error } = await admin.from('employees').update({ active: true }).in('employee_code', activeCodes)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (inactiveCodes.length) {
    const { error } = await admin.from('employees').update({ active: false }).in('employee_code', inactiveCodes)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, active: activeCodes.length, inactive: inactiveCodes.length, windowDays: WINDOW_DAYS })
}
