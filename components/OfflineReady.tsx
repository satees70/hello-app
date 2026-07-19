'use client'
import { useEffect, useState } from 'react'

// Registers the service worker for everyone (so offline caching applies even to users who
// never enabled push) and shows a banner while the device is offline. It deliberately does
// NOT queue writes — actions still require a connection, so nothing can double-post later.
export default function OfflineReady() {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
    const sync = () => setOffline(!navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => { window.removeEventListener('online', sync); window.removeEventListener('offline', sync) }
  }, [])

  if (!offline) return null
  return (
    <div className="fixed bottom-0 inset-x-0 z-[100] bg-amber-500 text-white text-center text-sm py-1.5 px-3 font-medium shadow-lg">
      ⚠ You’re offline — screens still load, but changes won’t save until you reconnect.
    </div>
  )
}
