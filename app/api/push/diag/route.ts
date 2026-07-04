import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import webpush from 'web-push'

export const runtime = 'nodejs'

// Diagnose why phone push isn't arriving. Authenticated via the caller's Supabase
// access token; reports whether the server keys are set, whether this user has a
// subscription, and tries a real send — returning a plain-language result.
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  || 'BHKb_a4GClTdj5ptsYu8frURlPn6JqP7bM_xCfDQRRg3kEQAb2qHRp8CaPxPbd5FMlf3bEdxGifOW1IUc7qmZmM'

export async function POST(req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer /i, '')
  if (!token) return NextResponse.json({ message: 'Not signed in.' }, { status: 401 })
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return NextResponse.json({ message: 'Session expired — sign in again.' }, { status: 401 })

  const configured = !!process.env.VAPID_PRIVATE_KEY && !!process.env.PUSH_SECRET
  const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth').eq('user_id', user.id)
  const subCount = (subs || []).length

  if (!configured) return NextResponse.json({ message: `❌ Server push keys are NOT set on Vercel (need VAPID_PRIVATE_KEY and PUSH_SECRET). That's why no phone gets pushes. Subscriptions on file for you: ${subCount}.` })
  if (subCount === 0) return NextResponse.json({ message: '❌ This device has no push subscription. Open the home-screen app, tap the bell → Enable on this phone → Allow.' })

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:satees@srrieaswari.com', VAPID_PUBLIC, process.env.VAPID_PRIVATE_KEY!)
  const payload = JSON.stringify({ title: '🔔 Push test (server)', body: 'This came straight from the server — push works!', url: '/dashboard', tag: 'diag' })
  let sent = 0; const errs: number[] = []
  for (const s of subs!) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); sent++ }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c) errs.push(c); if (c && [400, 403, 404, 410].includes(c)) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint) }
  }
  if (sent > 0) return NextResponse.json({ message: `✅ Sent a push to ${sent} device(s). If you don't see a banner, open iPhone Settings → the app → Notifications and turn them on.` })
  return NextResponse.json({ message: `⚠️ Server tried but all sends failed (codes: ${errs.join(', ') || 'unknown'}). Usually the VAPID keys don't match the saved subscription — the keys need regenerating and re-subscribing.` })
}
