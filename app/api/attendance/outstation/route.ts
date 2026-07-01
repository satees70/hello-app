import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Add or remove a multi-day outstation trip for a driver.
//   POST { employee_code, start_date, end_date }  → add
//   POST { action:'delete', id }                   → remove

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

export async function POST(request: Request) {
  const body = await request.json()

  if (body.action === 'delete') {
    if (!body.id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
    const { error } = await admin.from('outstation_trips').delete().eq('id', body.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { employee_code, start_date, end_date } = body
  if (!employee_code || !isDate(start_date) || !isDate(end_date)) {
    return NextResponse.json({ error: 'Need employee_code, start_date, end_date (yyyy-MM-dd)' }, { status: 400 })
  }
  if (end_date < start_date) return NextResponse.json({ error: 'Return date is before departure.' }, { status: 400 })

  const { error } = await admin.from('outstation_trips').insert({ employee_code, start_date, end_date })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
