import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

// Upsert one employee (name / shift profile / is_driver / active), keyed by
// employee_code. Used by the /hr/employees setup page.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'hr', 'edit')
  if (auth instanceof NextResponse) return auth

  const { employee_code, name, shift_profile_id, is_driver, is_production, active, delivery_name, crew_role, join_date, resign_date } = await request.json()
  if (!employee_code) return NextResponse.json({ error: 'Missing employee_code' }, { status: 400 })

  const row: Record<string, unknown> = { employee_code }
  if (name !== undefined) row.name = (name ?? '').trim() || employee_code
  if (shift_profile_id !== undefined) row.shift_profile_id = shift_profile_id || null
  if (is_driver !== undefined) row.is_driver = !!is_driver
  if (is_production !== undefined) row.is_production = !!is_production
  if (active !== undefined) row.active = !!active
  if (delivery_name !== undefined) row.delivery_name = (delivery_name ?? '').trim() || null
  if (crew_role !== undefined) row.crew_role = crew_role === 'driver' || crew_role === 'kelindan' ? crew_role : null
  if (join_date !== undefined) row.join_date = (join_date ?? '').trim() || null
  if (resign_date !== undefined) row.resign_date = (resign_date ?? '').trim() || null

  const { error } = await admin.from('employees').upsert(row, { onConflict: 'employee_code' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
