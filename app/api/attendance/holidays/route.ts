import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Manage the public-holiday calendar. POST { holiday_date, name } adds/updates;
// POST { action:'delete', holiday_date } removes.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const body = await request.json()
  const date = (body.holiday_date ?? '').toString().trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'holiday_date must be yyyy-MM-dd' }, { status: 400 })
  }

  if (body.action === 'delete') {
    const { error } = await admin.from('public_holidays').delete().eq('holiday_date', date)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await admin.from('public_holidays')
    .upsert({ holiday_date: date, name: (body.name ?? '').trim() || null }, { onConflict: 'holiday_date' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
