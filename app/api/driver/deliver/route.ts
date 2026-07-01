import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Mark one delivery_schedule order delivered (or undo it). Uses the service key
// so a driver's phone — not logged into the portal yet (placeholder auth) — can
// save without opening the tables to anonymous writes.
// TODO(auth): gate by the authenticated driver once real Supabase Auth lands.

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(request: Request) {
  const { id, ids, photo_path, note, undo } = await request.json()
  // Accept one id or many (an outlet can have several SO orders delivered together).
  const idList: string[] = Array.isArray(ids) && ids.length ? ids : (id ? [id] : [])
  if (!idList.length) return NextResponse.json({ error: 'Missing order id(s)' }, { status: 400 })

  const patch = undo
    ? { delivered_at: null, delivery_photo_path: null, delivery_note: null }
    : {
        delivered_at: new Date().toISOString(),
        delivery_photo_path: photo_path ?? null,
        delivery_note: (note ?? '').trim() || null,
      }

  const { error } = await admin.from('delivery_schedule').update(patch).in('id', idList)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
