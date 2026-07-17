'use client'
import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import DiscussionPanel from '@/components/DiscussionPanel'

// A floating "💬 Discussion" button on EVERY WMS page. It opens the shared warehouse
// discussion (channel 'wms') so staff can raise a query wherever they are — the current
// page becomes the default thread, so the office can see which area a question is about.
// Reuses the same discussions table / mentions / attachments as the main portal chat.

// Friendly name for the page a question is being asked from (the default thread topic).
const PAGE_LABELS: Record<string, string> = {
  '/wms': 'WMS Home',
  '/wms/locations': 'Location Map',
  '/wms/stock': 'Stock',
  '/wms/purchase-orders': 'Purchase Orders',
  '/wms/suppliers': 'Suppliers',
  '/wms/putaway': 'Putaway',
  '/wms/transfers': 'Transfers',
  '/wms/orders': 'Orders to Pick',
  '/wms/dispatch': 'Delivery Orders',
  '/wms/counts': 'Stock Counts',
  '/wms/approvals': 'Approvals',
  '/wms/reports/expiry': 'Expiry',
  '/wms/reports/stock-card': 'Stock Card',
  '/wms/reports': 'Reports',
  '/wms/labels': 'Labels',
  '/wms/movements': 'Movements',
}
function pageLabel(path: string): string {
  if (PAGE_LABELS[path]) return PAGE_LABELS[path]
  // Longest known prefix wins (covers detail routes like /wms/pick/[id]).
  const hit = Object.keys(PAGE_LABELS).filter(p => p !== '/wms' && path.startsWith(p)).sort((a, b) => b.length - a.length)[0]
  if (hit) return PAGE_LABELS[hit]
  const seg = path.split('/').filter(Boolean).pop() || 'WMS'
  return seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const LAST_KEY = 'wms_disc_lastopen'

export default function WmsDiscussionWidget() {
  const { profile } = useProfile()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)

  const countUnread = useCallback(async () => {
    if (!profile) return
    let since: string | null = null
    try { since = localStorage.getItem(LAST_KEY) } catch { /* ignore */ }
    let q = supabase.from('discussions').select('id', { count: 'exact', head: true }).eq('channel', 'wms').neq('author_id', profile.id)
    if (since) q = q.gt('created_at', since)
    const { count } = await q
    setUnread(count || 0)
  }, [profile])

  useEffect(() => {
    if (!profile || open) return
    countUnread()
    const t = setInterval(countUnread, 30000)
    return () => clearInterval(t)
  }, [profile, open, countUnread])

  if (!profile) return null

  function toggle() {
    const nowOpen = !open
    setOpen(nowOpen)
    if (nowOpen) { try { localStorage.setItem(LAST_KEY, new Date().toISOString()) } catch { /* ignore */ } ; setUnread(0) }
    else countUnread()
  }

  return (
    <>
      {!open && (
        <button onClick={toggle} title="Ask a question / discuss"
          className="fixed z-40 bottom-4 right-4 flex items-center gap-2 bg-emerald-700 text-white rounded-full shadow-lg px-4 py-3 hover:bg-emerald-800">
          <span className="text-lg leading-none">💬</span>
          <span className="text-sm font-medium hidden sm:inline">Discussion</span>
          {unread > 0 && <span className="inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-red-500 text-white text-[11px] font-bold leading-none">{unread}</span>}
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4" onClick={() => toggle()}>
          <div className="bg-white w-full sm:max-w-4xl sm:rounded-xl shadow-lg max-h-[94vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b bg-emerald-700 text-white">
              <span className="font-semibold text-sm">WMS Discussion <span className="font-normal text-emerald-200">· asking from {pageLabel(pathname)}</span></span>
              <button onClick={() => toggle()} className="text-emerald-100 hover:text-white text-lg leading-none">✕</button>
            </div>
            <div className="overflow-y-auto p-3">
              <DiscussionPanel channel="wms" me={profile.id} meName={profile.full_name} title="WMS Discussion" filterTopic={pageLabel(pathname)} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
