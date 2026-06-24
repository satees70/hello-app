'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { can, type ModuleKey, type Permissions } from '@/lib/permissions'
import { enablePush, pushAlreadyOn, pushSupported } from '@/lib/push'

interface NavbarProps {
  factoryCode: string
  fullName: string
  role: string
}

interface Toast { id: number; title: string; message: string }

export default function Navbar({ factoryCode, fullName, role }: NavbarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const isHO = factoryCode === 'HEAD_OFFICE'
  const isAdmin = role === 'admin'
  const [pendingCount, setPendingCount] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [myFactories, setMyFactories] = useState<string[]>([])
  interface Notif { id: string; factory_code: string; user_id: string | null; type: string; title: string; body: string | null; link: string | null; created_at: string }
  const [me, setMe] = useState('')
  const [notifs, setNotifs] = useState<Notif[]>([])
  const [notifSeenAt, setNotifSeenAt] = useState<string>('')
  const [notifOpen, setNotifOpen] = useState(false)
  const [pushOn, setPushOn] = useState(false)
  useEffect(() => { pushAlreadyOn().then(setPushOn) }, [])
  async function enableThisDevice() {
    if (!me) return
    const r = await enablePush(me)
    setPushOn(r.ok)
    addToast(r.ok ? '✅ Phone notifications on' : 'Notifications', r.msg)
  }
  // This user's permissions (for menu view-gating). Until loaded, can() treats an
  // unset grid as full access, so nothing is hidden by mistake.
  const profileLike = { role, permissions: perms }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return
      setMe(data.session.user.id)
      const { data: p } = await supabase.from('profiles').select('permissions, factory_codes, notifications_seen_at').eq('id', data.session.user.id).single()
      setPerms((p?.permissions as Permissions) ?? {})
      setMyFactories((p?.factory_codes as string[]) ?? [])
      setNotifSeenAt((p?.notifications_seen_at as string) ?? '')
    })
  }, [])

  // Notifications for this user's location(s) — HO sees all
  const myFacs = myFactories.length ? myFactories : [factoryCode]
  const loadNotifs = useCallback(async () => {
    if (!me) return
    let q = supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(40)
    // Personal (mention) notifications always; location notifications by factory (HO = all)
    if (isHO) q = q.or(`user_id.eq.${me},user_id.is.null`)
    else q = q.or(`user_id.eq.${me},and(user_id.is.null,factory_code.in.(${myFacs.join(',')}))`)
    const { data } = await q
    setNotifs((data as Notif[]) || [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHO, me, myFacs.join(',')])
  useEffect(() => { loadNotifs(); const t = setInterval(loadNotifs, 30000); return () => clearInterval(t) }, [loadNotifs, pathname])
  const unseenCount = notifSeenAt ? notifs.filter(n => n.created_at > notifSeenAt).length : notifs.length
  async function openNotifs() {
    setNotifOpen(o => !o)
    if (!notifOpen) { await supabase.rpc('mark_notifications_seen'); setNotifSeenAt(new Date().toISOString()) }
  }

  // Top-bar label: Head Office, "Multi-site (N)", or the single factory code.
  const factoryLabel = isHO ? 'Head Office'
    : myFactories.filter(c => c !== 'HEAD_OFFICE').length > 1 ? `Multi-site (${myFactories.filter(c => c !== 'HEAD_OFFICE').length})`
    : factoryCode

  function addToast(title: string, message: string) {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, title, message }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 7000)
  }

  // Every kind of approval that lands in Pending Changes
  const APPROVAL_TABLES = ['change_requests', 'correction_requests', 'do_change_requests', 'split_requests', 'stock_adjustments', 'run_mode_requests', 'mr_cancel_requests', 'doc_delete_requests', 'return_edit_requests', 'item_change_requests', 'so_change_requests', 'mr_qty_move_requests', 'factory_change_requests', 'food_loss_alerts'] as const
  const TABLE_LABEL: Record<string, string> = {
    change_requests: 'change', correction_requests: 'timer cancellation', do_change_requests: 'Goods Received change',
    split_requests: 'batch split / un-combine', stock_adjustments: 'stock adjustment', run_mode_requests: 'run-mode change',
    mr_cancel_requests: 'material request cancellation', doc_delete_requests: 'document delete', return_edit_requests: 'material return edit', item_change_requests: 'item change', so_change_requests: 'SO number change', mr_qty_move_requests: 'received-qty move', factory_change_requests: 'factory change', food_loss_alerts: 'food-loss alert',
  }

  // Head Office: total pending approvals across ALL approval types
  const refreshPending = useCallback(async () => {
    if (!isHO) return
    const results = await Promise.all(APPROVAL_TABLES.map(t =>
      supabase.from(t).select('id', { count: 'exact', head: true }).eq('status', 'Pending')))
    setPendingCount(results.reduce((s, r) => s + (r.count || 0), 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHO])

  // Refresh on nav + every 30s
  useEffect(() => {
    if (!isHO) return
    refreshPending()
    const timer = setInterval(refreshPending, 30000)
    return () => clearInterval(timer)
  }, [isHO, pathname, refreshPending])

  // Live notifications:
  //  - Head Office gets a toast + badge bump when any new request is raised
  //  - The requester gets a toast when their change request is approved/rejected
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    let myId: string | null = null
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return
      myId = data.session.user.id
      supabase.realtime.setAuth(data.session.access_token)
      channel = supabase.channel('approvals-feed')
      for (const t of APPROVAL_TABLES) {
        channel = channel
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: t }, () => {
            if (!isHO) return
            addToast('🔔 New request to approve', `A new ${TABLE_LABEL[t]} request is waiting in Pending Changes.`)
            refreshPending()
          })
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: t }, payload => {
            if (isHO) refreshPending()
            const row = payload.new as { requested_by?: string; status?: string }
            if (row.requested_by === myId && (row.status === 'Approved' || row.status === 'Rejected')) {
              const ok = row.status === 'Approved'
              addToast(ok ? '✅ Request approved' : '❌ Request rejected', `Your ${TABLE_LABEL[t]} request was ${ok ? 'approved' : 'rejected'} by Head Office.`)
            }
          })
      }
      channel.subscribe()
    })
    return () => { if (channel) supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHO, refreshPending])

  // Live location notifications → toast + prepend to the bell list
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return
      supabase.realtime.setAuth(data.session.access_token)
      channel = supabase.channel('notif-feed')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, payload => {
          const n = payload.new as Notif
          const forMe = n.user_id ? n.user_id === me : (isHO || myFacs.includes(n.factory_code))
          if (!forMe) return
          setNotifs(prev => prev.some(x => x.id === n.id) ? prev : [n, ...prev].slice(0, 40))
          addToast(n.user_id ? '💬 ' + n.title : '🔔 ' + n.title, n.body || '')
        })
        .subscribe()
    })
    return () => { if (channel) supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHO, me, myFacs.join(',')])

  // Office-only access guard. Factory staff may only use the app from an allowed
  // office IP; Head Office + Admins are exempt. Master switch (app_config) lets it
  // be turned off. Result cached for the session to avoid re-checking every page.
  useEffect(() => {
    if (isHO || isAdmin) return
    if (typeof window !== 'undefined' && sessionStorage.getItem('netguard_ok') === '1') return
    let cancelled = false
    ;(async () => {
      const { data: cfg } = await supabase.from('app_config').select('network_guard_enabled').eq('id', 1).maybeSingle()
      if (!cfg?.network_guard_enabled) return                       // guard off (or table missing) → allow
      const { data: nets } = await supabase.from('allowed_networks').select('ip').eq('enabled', true)
      const allowed = (nets || []).map(n => String(n.ip).trim())
      let myIp = ''
      try { myIp = (await (await fetch('/api/whoami')).json()).ip || '' } catch { return } // can't tell → don't lock out
      if (cancelled) return
      if (allowed.includes(myIp.trim())) { sessionStorage.setItem('netguard_ok', '1'); return }
      await supabase.auth.signOut()
      router.replace('/blocked')
    })()
    return () => { cancelled = true }
  }, [isHO, isAdmin])

  async function handleLogout() {
    sessionStorage.removeItem('netguard_ok')
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Menu grouped by area so it's easy to scan (group with no header = top-level).
  // `module` ties a link to a permission section; links without a module (e.g.
  // Dashboard, HO-only Setup pages) are always shown to whoever reaches them.
  type Item = { href: string; label: string; module?: ModuleKey }
  const allGroups: { header?: string; items: Item[] }[] = [
    { items: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/sales-orders/changes', label: 'Pending Changes', module: 'changes' },
      { href: '/discussion', label: 'Discussion' },
    ] },
    { header: 'Sales', items: [
      { href: '/sales-orders', label: 'Sales Orders', module: 'sales' },
      { href: '/repacking', label: 'Repacking', module: 'sales' },
      { href: '/dispatch', label: 'Delivery Orders', module: 'dispatch' as ModuleKey },
      { href: '/supplier', label: 'Supplier (to order)', module: 'sales' },
    ] },
    { header: 'Receiving', items: [
      { href: '/material-requests', label: 'Material Requests', module: 'material_requests' },
      { href: '/labels', label: 'Labels', module: 'material_requests' },
      { href: '/incoming', label: 'Goods Received', module: 'goods_received' },
      { href: '/transfers', label: 'Material Transfers', module: 'material_requests' },
    ] },
    { header: 'Production', items: [
      { href: '/production', label: 'Order Board', module: 'order_board' },
      { href: '/packing', label: 'Packing Schedule', module: 'packing' },
      { href: '/grinding', label: 'Grinding', module: 'grinding' },
      { href: '/drying-roasting', label: 'Drying & Roasting', module: 'drying' },
      { href: '/moisture', label: 'Moisture', module: 'moisture' },
      { href: '/oprp', label: 'OPRP Record', module: 'oprp' },
    ] },
    { header: 'Reports', items: [
      { href: '/stock', label: 'Stock', module: 'stock' },
      { href: '/stock-adjustment', label: 'Stock Adjustment', module: 'stock_adjustment' as ModuleKey },
      { href: '/traceability', label: 'Traceability', module: 'traceability' },
      { href: '/admin/items', label: 'Items', module: 'items' },
      { href: '/admin/bom', label: 'BOM', module: 'bom' as ModuleKey },
      ...(isHO ? [
        { href: '/admin/location-map', label: 'Location Map' },
      ] : []),
    ] },
    { header: 'Setup', items: [
      { href: '/admin/packing-lines', label: 'Packing Lines', module: 'packing_lines' as ModuleKey },
      ...(isHO ? [{ href: '/admin/factories', label: 'Factories' }] : []),
      ...(isHO && isAdmin ? [{ href: '/admin/users', label: 'Users' }] : []),
      ...(isHO ? [{ href: '/admin/allowed-networks', label: 'Allowed Networks' }] : []),
    ] },
  ]
  // Hide links the user has no View permission for (admins/HO/unconfigured see all).
  const menuGroups = allGroups
    .map(g => ({ ...g, items: g.items.filter(it => !it.module || can(profileLike, it.module, 'view')) }))
    .filter(g => g.items.length > 0)
  return (
    <>
      <nav className="bg-blue-700 text-white px-4 sm:px-6 flex items-center justify-between gap-3 relative z-50">
        <div className="flex items-stretch gap-0.5 min-w-0">
          <span className="font-bold text-lg shrink-0 self-center mr-3">EASWARI</span>
          <div className="hidden md:flex items-stretch flex-wrap gap-0.5 min-w-0">
          {menuGroups.map((g, gi) => {
            // Top-level group with no header → render its items as direct bar links
            if (!g.header) return g.items.map(l => (
              <Link key={l.href} href={l.href} onClick={() => setOpenMenu(null)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-3 text-sm hover:bg-blue-800 ${pathname === l.href ? 'bg-blue-800 font-semibold' : ''}`}>
                {l.label}
                {l.href === '/sales-orders/changes' && isHO && pendingCount > 0 && (
                  <span className="bg-red-500 text-white text-xs font-semibold rounded-full min-w-[1.25rem] text-center px-1.5 py-0.5 leading-none">{pendingCount}</span>
                )}
              </Link>
            ))
            // Otherwise → a top menu button that opens a dropdown
            const open = openMenu === g.header
            const activeHere = g.items.some(l => l.href === pathname)
            return (
              <div key={gi} className="relative shrink-0">
                <button
                  onClick={() => setOpenMenu(open ? null : g.header!)}
                  onMouseEnter={() => { if (openMenu) setOpenMenu(g.header!) }}
                  className={`inline-flex items-center gap-1 px-3 py-3 text-sm hover:bg-blue-800 ${open || activeHere ? 'bg-blue-800 font-semibold' : ''}`}>
                  {g.header}<span className="text-[10px] opacity-80">▾</span>
                </button>
                {open && (
                  <div className="absolute left-0 top-full z-50 w-56 bg-white text-gray-800 rounded-b-lg shadow-xl border py-1.5">
                    {g.items.map(l => (
                      <Link key={l.href} href={l.href} onClick={() => setOpenMenu(null)}
                        className={`flex items-center justify-between px-4 py-2 text-sm hover:bg-blue-50 ${pathname === l.href ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-gray-700'}`}>
                        <span>{l.label}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 text-sm shrink-0">
          {/* Notification bell */}
          <div className="relative">
            <button onClick={openNotifs} className="relative inline-flex items-center justify-center w-9 h-9 rounded hover:bg-blue-800" aria-label="Notifications" title="Notifications">
              <span className="text-lg leading-none">🔔</span>
              {unseenCount > 0 && <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">{unseenCount > 99 ? '99+' : unseenCount}</span>}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                <div className="absolute right-0 mt-1 w-80 max-w-[90vw] bg-white text-gray-800 rounded-lg shadow-xl border z-50 max-h-96 overflow-y-auto">
                  <div className="px-4 py-2 border-b sticky top-0 bg-white flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm">Notifications</span>
                    {pushSupported() && (pushOn
                      ? <span className="text-green-600 text-xs">✓ On this device</span>
                      : <button onClick={enableThisDevice} className="text-blue-600 hover:underline text-xs">Enable on this phone</button>)}
                  </div>
                  {notifs.length === 0 && <p className="px-4 py-6 text-center text-gray-400 text-sm">Nothing yet.</p>}
                  {notifs.map(n => {
                    const unseen = !notifSeenAt || n.created_at > notifSeenAt
                    const go = () => { setNotifOpen(false); if (n.link) router.push(n.link) }
                    return (
                      <button key={n.id} onClick={go} className={`block w-full text-left px-4 py-2 border-b last:border-0 hover:bg-gray-50 ${unseen ? 'bg-blue-50/60' : ''}`}>
                        <div className="flex items-start gap-2">
                          {unseen && <span className="mt-1 w-2 h-2 rounded-full bg-blue-500 shrink-0" />}
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{n.title}</div>
                            {n.body && <div className="text-xs text-gray-500">{n.body}</div>}
                            <div className="text-[10px] text-gray-400 mt-0.5">{isHO ? `${n.factory_code} · ` : ''}{new Date(n.created_at).toLocaleString()}</div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
          <span className="bg-blue-800 px-2 sm:px-3 py-1 rounded-full text-xs whitespace-nowrap">
            {factoryLabel}
          </span>
          <span className="hidden md:inline">{fullName || 'User'}</span>
          <button onClick={handleLogout} className="hidden sm:inline-block bg-white text-blue-700 px-3 py-1 rounded hover:bg-blue-50 text-xs font-medium">
            Logout
          </button>
          {/* Mobile hamburger */}
          <button onClick={() => setMobileOpen(o => !o)} className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded hover:bg-blue-800 relative" aria-label="Menu">
            <span className="text-xl leading-none">{mobileOpen ? '✕' : '☰'}</span>
            {isHO && pendingCount > 0 && !mobileOpen && <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-semibold rounded-full min-w-[1rem] text-center px-1 leading-tight">{pendingCount}</span>}
          </button>
        </div>
      </nav>

      {/* Mobile slide-down menu */}
      {mobileOpen && (
        <div className="md:hidden bg-blue-700 text-white border-t border-blue-600 max-h-[80vh] overflow-y-auto relative z-50">
          {menuGroups.map((g, gi) => (
            <div key={gi} className="border-b border-blue-600/60 py-1">
              {g.header && <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-blue-200">{g.header}</div>}
              {g.items.map(l => (
                <Link key={l.href} href={l.href} onClick={() => setMobileOpen(false)}
                  className={`flex items-center justify-between px-5 py-2.5 text-sm ${pathname === l.href ? 'bg-blue-800 font-semibold' : 'hover:bg-blue-800'}`}>
                  <span>{l.label}</span>
                  {l.href === '/sales-orders/changes' && isHO && pendingCount > 0 && (
                    <span className="bg-red-500 text-white text-xs font-semibold rounded-full min-w-[1.25rem] text-center px-1.5 py-0.5 leading-none">{pendingCount}</span>
                  )}
                </Link>
              ))}
            </div>
          ))}
          <button onClick={handleLogout} className="w-full text-left px-5 py-3 text-sm font-medium hover:bg-blue-800">Logout</button>
        </div>
      )}
      {/* click-away backdrop (below the nav so other top menus stay clickable) */}
      {openMenu && <div className="fixed inset-0 z-40" onClick={() => setOpenMenu(null)} />}

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 space-y-2">
          {toasts.map(t => (
            <button key={t.id} onClick={() => router.push('/sales-orders/changes')}
              className="block w-72 text-left bg-white text-gray-800 border border-blue-200 shadow-lg rounded-lg px-4 py-3 text-sm hover:bg-blue-50">
              <span className="font-semibold text-blue-700">{t.title}</span>
              <span className="block text-gray-600 mt-0.5">{t.message}</span>
              <span className="block text-blue-600 text-xs mt-1">Click to view →</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
