import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Per-person, per-month override: no_deduct=true → never deduct that employee's
// late-in / early-out from Total OT for the given month ('YYYY-MM'). Setting it
// back to deduct removes the row.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const { employee_code, month, no_deduct } = await request.json()
  if (!employee_code || !month) {
    return NextResponse.json({ error: 'Missing employee_code or month' }, { status: 400 })
  }

  if (!no_deduct) {
    const { error } = await admin.from('late_deduction_overrides').delete()
      .eq('employee_code', employee_code).eq('month', month)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('late_deduction_overrides')
    .upsert({ employee_code, month, no_deduct: true, updated_at: new Date().toISOString() }, { onConflict: 'employee_code,month' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
