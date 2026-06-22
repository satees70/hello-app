import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import webpush from 'web-push'

export const runtime = 'nodejs'

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  || 'BHKb_a4GClTdj5ptsYu8frURlPn6JqP7bM_xCfDQRRg3kEQAb2qHRp8CaPxPbd5FMlf3bEdxGifOW1IUc7qmZmM'

interface Notif { id: string; factory_code: string; user_id: string | null; title: string; body: string | null; link: string | null; type: string }
interface Sub { endpoint: string; p256dh: string; auth: string }

export async function POST(req: Request) {
  if (req.headers.get('x-push-secret') !== process.env.PUSH_SECRET) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.VAPID_PRIVATE_KEY) return NextResponse.json({ error: 'push not configured' }, { status: 500 })
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:satees@srrieaswari.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY)
  const { id } = await req.json().catch(() => ({ id: null }))
  if (!id) return NextResponse.json({ error: 'no id' }, { status: 400 })

  const { data: n } = await admin.from('notifications').select('*').eq('id', id).single()
  if (!n) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const note = n as Notif

  // Who should receive it: a tagged user, or everyone at that location (+ Head Office)
  let userIds: string[] = []
  if (note.user_id) userIds = [note.user_id]
  else {
    const { data: profs } = await admin.from('profiles').select('id, factory_code, factory_codes')
    userIds = (profs || []).filter(p =>
      p.factory_code === 'HEAD_OFFICE' || p.factory_code === note.factory_code ||
      (Array.isArray(p.factory_codes) && p.factory_codes.includes(note.factory_code))).map(p => p.id)
  }
  if (userIds.length === 0) return NextResponse.json({ sent: 0 })

  const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', userIds)
  const payload = JSON.stringify({ title: note.title, body: note.body || '', url: note.link || '/', tag: note.type })
  let sent = 0
  await Promise.all(((subs as Sub[]) || []).map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      sent++
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode
      if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
    }
  }))
  return NextResponse.json({ sent })
}
