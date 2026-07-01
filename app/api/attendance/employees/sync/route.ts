import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { fetchEmployees } from '@/lib/zklink'

// Pull the employee master from ZKLink and upsert into `employees` (name only —
// shift_profile_id / is_driver set by hand are preserved). Needs the Employee
// permission granted to the app in the ZKLink console.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET() {
  let emps
  try {
    emps = await fetchEmployees()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const rows = emps
    .filter(e => e.employee_code && e.name)
    .map(e => ({ employee_code: e.employee_code, name: e.name }))

  let upserted = 0
  if (rows.length) {
    // onConflict employee_code → updates only `name`, leaving shift_profile_id etc.
    const { data, error } = await admin.from('employees')
      .upsert(rows, { onConflict: 'employee_code' }).select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    upserted = data?.length ?? 0
  }

  return NextResponse.json({ ok: true, pulled: emps.length, upserted })
}
