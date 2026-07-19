/* Service worker: web-push notifications + offline app-shell caching. */

/* ---------------- web push ---------------- */
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) { data = { title: 'Notification', body: event.data ? event.data.text() : '' } }
  const title = data.title || 'EASWARI'
  const options = {
    body: data.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: data.url || '/' },
    tag: data.tag || undefined,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus() } }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})

/* ---------------- offline caching ----------------
   Conservative strategy so the app doesn't white-screen on flaky signal:
   - Navigations: network-first (always fresh when online), fall back to the cached
     page, then an offline notice — so previously-visited screens still open offline.
   - Build assets (/_next/static, scripts, styles, images, fonts): cache-first with a
     background refresh.
   - GET + same-origin only. API routes and cross-origin (Supabase/Anthropic) are never
     touched, so data writes always go straight to the network — nothing is queued or
     replayed (that would risk double-posting stock/delivery actions). */
const CACHE = 'easwari-cache-v1'
const OFFLINE_URL = '/offline'
const PRECACHE = [OFFLINE_URL, '/icon.svg']

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(PRECACHE)
    self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch (e) { return }
  if (url.origin !== self.location.origin) return   // Supabase / Anthropic / other origins — leave alone
  if (url.pathname.startsWith('/api/')) return       // never cache API responses

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req)
        const cache = await caches.open(CACHE)
        cache.put(req, fresh.clone())
        return fresh
      } catch (e) {
        const cache = await caches.open(CACHE)
        return (await cache.match(req)) || (await cache.match(OFFLINE_URL)) || Response.error()
      }
    })())
    return
  }

  const asset = url.pathname.startsWith('/_next/static/') || ['style', 'script', 'image', 'font'].includes(req.destination)
  if (asset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(req)
      const network = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res }).catch(() => cached)
      return cached || network
    })())
  }
})
