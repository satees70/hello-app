import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Set (or clear) a driver's trip type for one day — overrides the auto value
// from the delivery schedule. Empty trip_type clears the override.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const { employee_code, work_date, trip_type } = await request.json()
  if (!employee_code || !work_date) {
    return NextResponse.json({ error: 'Missing employee_code or work_date' }, { status: 400 })
  }

  const tt = (trip_type ?? '').toString().trim()
  if (!tt) {
    const { error } = await admin.from('driver_trip_overrides').delete()
      .eq('employee_code', employee_code).eq('work_date', work_date)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('driver_trip_overrides')
    .upsert({ employee_code, work_date, trip_type: tt, updated_at: new Date().toISOString() }, { onConflict: 'employee_code,work_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
