import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Upsert one employee (name / shift profile / is_driver / active), keyed by
// employee_code. Used by the /hr/employees setup page.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const { employee_code, name, shift_profile_id, is_driver, active } = await request.json()
  if (!employee_code) return NextResponse.json({ error: 'Missing employee_code' }, { status: 400 })

  const row: Record<string, unknown> = { employee_code }
  if (name !== undefined) row.name = (name ?? '').trim() || employee_code
  if (shift_profile_id !== undefined) row.shift_profile_id = shift_profile_id || null
  if (is_driver !== undefined) row.is_driver = !!is_driver
  if (active !== undefined) row.active = !!active

  const { error } = await admin.from('employees').upsert(row, { onConflict: 'employee_code' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
