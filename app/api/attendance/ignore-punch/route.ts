import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Ignore (or restore) one stray punch on a day — e.g. a fingerprint-enrolment tap
// that shouldn't count. A row = that 'HH:mm' is dropped from the day's pairing.
// The raw punch in attendance_punches is untouched (audit trail preserved).

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const { employee_code, work_date, punch_hm, ignore } = await request.json()
  const hm = (punch_hm ?? '').toString().trim()
  if (!employee_code || !work_date || !/^\d{2}:\d{2}$/.test(hm)) {
    return NextResponse.json({ error: 'Missing employee_code, work_date, or HH:mm punch' }, { status: 400 })
  }

  if (!ignore) {
    const { error } = await admin.from('attendance_ignored_punches').delete()
      .eq('employee_code', employee_code).eq('work_date', work_date).eq('punch_hm', hm)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('attendance_ignored_punches')
    .upsert({ employee_code, work_date, punch_hm: hm }, { onConflict: 'employee_code,work_date,punch_hm' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
