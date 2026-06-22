import { supabase } from '@/lib/supabase'

// Public VAPID key (safe to ship). Override with NEXT_PUBLIC_VAPID_PUBLIC_KEY if rotated.
export const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  || 'BHKb_a4GClTdj5ptsYu8frURlPn6JqP7bM_xCfDQRRg3kEQAb2qHRp8CaPxPbd5FMlf3bEdxGifOW1IUc7qmZmM'

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

// Register the service worker, ask permission, subscribe, and save the subscription.
export async function enablePush(userId: string): Promise<{ ok: boolean; msg: string }> {
  if (!pushSupported()) return { ok: false, msg: 'This browser can’t do notifications. On iPhone: open in Safari → Share → Add to Home Screen, then open that app and try again.' }
  let perm = Notification.permission
  if (perm === 'default') perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, msg: 'Notifications were not allowed. Enable them for this site in your browser settings.' }
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) })
  const j = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } }
  if (!j.keys?.p256dh || !j.keys?.auth) return { ok: false, msg: 'Could not read the push keys.' }
  const { error } = await supabase.from('push_subscriptions').upsert(
    { user_id: userId, endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: 'endpoint' })
  if (error) return { ok: false, msg: error.message }
  return { ok: true, msg: 'Notifications enabled on this device.' }
}

export async function pushAlreadyOn() {
  if (!pushSupported()) return false
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = reg && await reg.pushManager.getSubscription()
    return !!sub && Notification.permission === 'granted'
  } catch { return false }
}
