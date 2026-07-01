import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Set (or clear) the leave type on an absent day. Empty leave_type clears it.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const { employee_code, work_date, leave_type } = await request.json()
  if (!employee_code || !work_date) {
    return NextResponse.json({ error: 'Missing employee_code or work_date' }, { status: 400 })
  }

  const lt = (leave_type ?? '').toString().trim()
  if (!lt) {
    const { error } = await admin.from('leave_days').delete()
      .eq('employee_code', employee_code).eq('work_date', work_date)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('leave_days')
    .upsert({ employee_code, work_date, leave_type: lt, updated_at: new Date().toISOString() }, { onConflict: 'employee_code,work_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
