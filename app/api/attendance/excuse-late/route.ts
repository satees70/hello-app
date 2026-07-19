import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Excuse (or un-excuse) one day's late-in / early-out so the Monthly Summary
// doesn't deduct it from Total OT. excused=true → a row exists; false → removed.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const { employee_code, work_date, excused, reason } = await request.json()
  if (!employee_code || !work_date) {
    return NextResponse.json({ error: 'Missing employee_code or work_date' }, { status: 400 })
  }

  if (!excused) {
    const { error } = await admin.from('late_excuses').delete()
      .eq('employee_code', employee_code).eq('work_date', work_date)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('late_excuses')
    .upsert({ employee_code, work_date, reason: (reason ?? '').toString().trim() || null, updated_at: new Date().toISOString(), updated_by: auth.userId, updated_by_name: auth.profile.full_name || null }, { onConflict: 'employee_code,work_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
