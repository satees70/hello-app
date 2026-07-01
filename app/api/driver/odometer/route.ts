import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Save the odometer (start/end km) for one line/trip — keyed by route + date,
// matching the existing delivery_trips row the office created when assigning the
// driver. Service key, same reasoning as ../deliver.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const toIntOrNull = (v: unknown) =>
  v === null || v === undefined || v === '' ? null : Number(v)

export async function POST(request: Request) {
  const { route, delivery_date, odometer_start, odometer_end } = await request.json()
  if (!route || !delivery_date) {
    return NextResponse.json({ error: 'Missing route or delivery_date' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (odometer_start !== undefined) patch.odometer_start = toIntOrNull(odometer_start)
  if (odometer_end !== undefined) patch.odometer_end = toIntOrNull(odometer_end)

  const { error } = await admin.from('delivery_trips').update(patch)
    .eq('route', route).eq('delivery_date', delivery_date)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
