import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Per-person, per-month ('YYYY-MM') OT switch. off=true → a row exists and ALL of
// that person's OT is skipped for the month; off=false → the row is removed and
// OT counts again (the default).

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const { employee_code, month, off } = await request.json()
  if (!employee_code || !month) {
    return NextResponse.json({ error: 'Missing employee_code or month' }, { status: 400 })
  }

  if (!off) {
    const { error } = await admin.from('ot_month_off').delete()
      .eq('employee_code', employee_code).eq('month', month)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('ot_month_off')
    .upsert({ employee_code, month, updated_at: new Date().toISOString(), updated_by: auth.userId, updated_by_name: auth.profile.full_name || null }, { onConflict: 'employee_code,month' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
