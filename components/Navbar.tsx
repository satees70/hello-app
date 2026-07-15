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
  const [onWarehouse, setOnWarehouse] = useState(false)   // warehouse.srrieaswari.com → focused warehouse menu
  useEffect(() => { if (typeof window !== 'undefined') setOnWarehouse(window.location.host.startsWith('warehouse.')) }, [])
  const isHO = factoryCode === 'HEAD_OFFICE'
  const isAdmin = role === 'admin'
  const [pendingCount, setPendingCount] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [myFactories, setMyFactories] = useState<string[]>([])
  interface Notif { id: string; factory_code: string; user_id: string | null; author_id: string | null; type: string; title: string; body: string | null; link: string | null; created_at: string }
  const [me, setMe] = useState('')
  const [offsiteAllowed, setOffsiteAllowed] = useState(false)   // may use the app outside the office
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
      const { data: p } = await supabase.from('profiles').select('permissions, factory_codes, notifications_seen_at, offsite_allowed').eq('id', data.session.user.id).single()
      setPerms((p?.permissions as Permissions) ?? {})
      setMyFactories((p?.factory_codes as string[]) ?? [])
      setNotifSeenAt((p?.notifications_seen_at as string) ?? '')
      setOffsiteAllowed(!!p?.offsite_allowed)
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
    // Hide notifications this user has individually cleared (ticked off).
    const { data: dism } = await supabase.from('notification_dismissals').select('notification_id').eq('user_id', me)
    const dismissed = new Set((dism || []).map(d => d.notification_id as string))
    setNotifs(((data as Notif[]) || []).filter(n => n.author_id !== me && !dismissed.has(n.id)))   // don't show my own / cleared
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHO, me, myFacs.join(',')])
  // Clear one notification for me only (others still see it).
  async function dismissNotif(id: string) {
    setNotifs(ns => ns.filter(n => n.id !== id))
    await supabase.rpc('dismiss_notification', { p_id: id })
  }
  useEffect(() => { loadNotifs(); const t = setInterval(loadNotifs, 30000); return () => clearInterval(t) }, [loadNotifs, pathname])
  const unseenCount = notifSeenAt ? notifs.filter(n => n.created_at > notifSeenAt).length : notifs.length
  function openNotifs() { setNotifOpen(o => !o) }   // opening no longer marks all read — use the button
  async function markAllRead() { await supabase.rpc('mark_notifications_seen'); setNotifSeenAt(new Date().toISOString()) }
  async function sendTest() {
    const { error } = await supabase.rpc('send_test_notification')
    if (error) { addToast('Test failed', error.message); return }
    addToast('🔔 Test sent', 'Watch this device (and your phone if push is on).')
    setTimeout(loadNotifs, 800)
  }
  async function diagnosePush() {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) { addToast('Push check', 'Not signed in.'); return }
    try {
      const r = await fetch('/api/push/diag', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      addToast('Phone push check', j.message || 'No response.')
    } catch { addToast('Phone push check', 'Could not reach the server.') }
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
  const APPROVAL_TABLES = ['change_requests', 'correction_requests', 'do_change_requests', 'split_requests', 'stock_adjustments', 'run_mode_requests', 'mr_cancel_requests', 'mr_cancel_item_requests', 'label_override_requests', 'so_balance_cancel_requests', 'grn_bypass_requests', 'doc_delete_requests', 'return_edit_requests', 'item_change_requests', 'so_change_requests', 'mr_qty_move_requests', 'factory_change_requests', 'food_loss_alerts', 'wms_check_qty_requests'] as const
  const TABLE_LABEL: Record<string, string> = {
    change_requests: 'change', correction_requests: 'timer cancellation', do_change_requests: 'Goods Received change',
    split_requests: 'batch split / un-combine', stock_adjustments: 'stock adjustment', run_mode_requests: 'run-mode change',
    mr_cancel_requests: 'material request cancellation', mr_cancel_item_requests: 'material request line cancellation', label_override_requests: 'label received override', so_balance_cancel_requests: 'order balance cancel', grn_bypass_requests: 'receiving photo bypass', doc_delete_requests: 'document delete', return_edit_requests: 'material return edit', item_change_requests: 'item change', so_change_requests: 'SO number change', mr_qty_move_requests: 'received-qty move', factory_change_requests: 'factory change', food_loss_alerts: 'food-loss alert', wms_check_qty_requests: 'pick check quantity correction',
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
          if (n.author_id === me) return   // don't notify me of my own message
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
    if (isHO || isAdmin || offsiteAllowed) return
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
  }, [isHO, isAdmin, offsiteAllowed])

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
      { href: '/sales-orders', label: 'Outstanding Sales Order', module: 'sales' },
      { href: '/pending-summary', label: 'Pending Summary', module: 'sales' },
      { href: '/repacking', label: 'Repacking', module: 'sales' },
      { href: '/delivery-schedule', label: 'Delivery Schedule' },
      { href: '/dispatch', label: 'Delivery Orders', module: 'dispatch' as ModuleKey },
      { href: '/dispatch/dashboard', label: 'Delivery Status', module: 'dispatch' as ModuleKey },
      { href: '/transport', label: 'Lorry Internal Transfer', module: 'dispatch' as ModuleKey },
      { href: '/supplier', label: 'Supplier (to order)', module: 'sales' },
      { href: '/cancel-notes', label: 'Cancel Notes', module: 'sales' },
    ] },
    { header: 'Receiving', items: [
      { href: '/material-requests', label: 'Material Requests', module: 'material_requests' },
      { href: '/labels', label: 'Labels', module: 'material_requests' },
      { href: '/incoming', label: 'Goods Received', module: 'goods_received' },
      { href: '/warehouse', label: 'Warehouse Receiving', module: 'goods_received' },
      { href: '/transfers', label: 'Material Transfers', module: 'material_requests' },
    ] },
    { header: 'Production', items: [
      { href: '/production', label: 'Order Board', module: 'order_board' },
      { href: '/production?board=grinding', label: '🌀 Grinding Board', module: 'order_board' },
      { href: '/packing', label: 'Packing Schedule', module: 'packing' },
      { href: '/inspection/records', label: 'Inspection Records', module: 'inspection' as ModuleKey },
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
    { header: 'Import', items: [
      { href: '/import', label: 'Shipments', module: 'import' as ModuleKey },
      { href: '/import/suppliers', label: 'Suppliers', module: 'import' as ModuleKey },
    ] },
    { header: 'Warehouse (WMS)', items: [
      { href: '/wms/locations', label: 'Location Map', module: 'warehouse' as ModuleKey },
      { href: '/wms/stock', label: 'Stock', module: 'warehouse' as ModuleKey },
      { href: '/wms/purchase-orders', label: 'Purchase Orders', module: 'warehouse' as ModuleKey },
      { href: '/wms/suppliers', label: 'Suppliers', module: 'warehouse' as ModuleKey },
      { href: '/wms/putaway', label: 'Putaway', module: 'warehouse' as ModuleKey },
      { href: '/wms/transfers', label: 'Transfers', module: 'warehouse' as ModuleKey },
      { href: '/wms/orders', label: 'Orders to Pick', module: 'warehouse' as ModuleKey },
      { href: '/wms/dispatch', label: 'Delivery Orders', module: 'warehouse' as ModuleKey },
      { href: '/wms/counts', label: 'Stock Counts', module: 'warehouse' as ModuleKey },
      { href: '/wms/reports/expiry', label: 'Expiry Alerts', module: 'warehouse' as ModuleKey },
      { href: '/wms/reports', label: 'Reports', module: 'warehouse' as ModuleKey },
      { href: '/wms/labels', label: 'Labels (QR)', module: 'warehouse' as ModuleKey },
      { href: '/wms/movements', label: 'Movements', module: 'warehouse' as ModuleKey },
    ] },
    { header: 'Setup', items: [
      { href: '/admin/packing-lines', label: 'Packing Lines', module: 'packing_lines' as ModuleKey },
      { href: '/admin/grinding-machines', label: 'Grinding Machines', module: 'grinding' as ModuleKey },
      ...(isHO ? [{ href: '/admin/factories', label: 'Factories' }] : []),
      ...(isHO && isAdmin ? [{ href: '/admin/users', label: 'Users' }] : []),
      ...(isHO ? [{ href: '/admin/allowed-networks', label: 'Allowed Networks' }] : []),
    ] },
  ]
  // On the warehouse subdomain this is the ONE and only nav — no separate green WMS
  // bar. Everything lives under two dropdowns so nothing is hidden in another page:
  // "Production" (the receiving / supply-to-production flow) and "WMS" (the warehouse
  // management system). The green "EASWARI WMS" bar only appears on the main portal.
  const warehouseGroups: { header?: string; items: Item[] }[] = [
    // Ordered by the process: demand → pick for the factory → receive → dispatch.
    { header: 'Production', items: [
      { href: '/sales-orders', label: 'Outstanding Sales Order', module: 'sales' },
      { href: '/material-requests', label: 'Pick Runs', module: 'material_requests' },
      { href: '/warehouse/pick-production', label: 'Pick for Production', module: 'material_requests' },
      { href: '/incoming', label: 'Goods Received', module: 'goods_received' },
      { href: '/warehouse', label: 'Warehouse Receiving', module: 'goods_received' },
      { href: '/dispatch/dashboard', label: 'Delivery Status', module: 'dispatch' },
      { href: '/discussion', label: 'Discussion' },
    ] },
    // Ordered by the warehouse process: inbound → store → outbound → control.
    { header: 'WMS', items: [
      // Inbound
      { href: '/wms/purchase-orders', label: 'Purchase Orders', module: 'warehouse' },
      { href: '/wms/suppliers', label: 'Suppliers', module: 'warehouse' },
      { href: '/wms/putaway', label: 'Putaway', module: 'warehouse' },
      // Store
      { href: '/wms/stock', label: 'Stock', module: 'warehouse' },
      { href: '/wms/locations', label: 'Location Map', module: 'warehouse' },
      { href: '/wms/transfers', label: 'Transfers', module: 'warehouse' },
      // Outbound
      { href: '/wms/orders', label: 'Orders to Pick', module: 'warehouse' },
      { href: '/wms/dispatch', label: 'Delivery Orders', module: 'warehouse' },
      // Control
      { href: '/wms/counts', label: 'Stock Counts', module: 'warehouse' },
      { href: '/wms/movements', label: 'Movements', module: 'warehouse' },
      { href: '/wms/reports/expiry', label: 'Expiry Alerts', module: 'warehouse' },
      { href: '/wms/reports', label: 'Reports', module: 'warehouse' },
      { href: '/wms/labels', label: 'Labels (QR)', module: 'warehouse' },
    ] },
  ]
  // Hide links the user has no View permission for (admins/HO/unconfigured see all).
  const menuGroups = (onWarehouse ? warehouseGroups : allGroups)
    .map(g => ({ ...g, items: g.items.filter(it => !it.module || can(profileLike, it.module, 'view')) }))
    .filter(g => g.items.length > 0)
  return (
    <>
      <nav className="bg-emerald-700 text-white px-4 sm:px-6 flex items-center justify-between gap-3 relative z-50">
        <div className="flex items-stretch gap-0.5 min-w-0">
          <span className="font-bold text-lg shrink-0 self-center mr-3">EASWARI{onWarehouse && <span className="font-normal text-emerald-200"> Warehouse</span>}</span>
          <div className="hidden md:flex items-stretch flex-wrap gap-0.5 min-w-0">
          {menuGroups.map((g, gi) => {
            // Top-level group with no header → render its items as direct bar links
            if (!g.header) return g.items.map(l => (
              <Link key={l.href} href={l.href} onClick={() => setOpenMenu(null)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-3 text-sm hover:bg-emerald-800 ${pathname === l.href ? 'bg-emerald-800 font-semibold' : ''}`}>
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
                  className={`inline-flex items-center gap-1 px-3 py-3 text-sm hover:bg-emerald-800 ${open || activeHere ? 'bg-emerald-800 font-semibold' : ''}`}>
                  {g.header}<span className="text-[10px] opacity-80">▾</span>
                </button>
                {open && (
                  <div className="absolute left-0 top-full z-50 w-56 bg-white text-gray-800 rounded-b-lg shadow-xl border py-1.5">
                    {g.items.map(l => (
                      <Link key={l.href} href={l.href} onClick={() => setOpenMenu(null)}
                        className={`flex items-center justify-between px-4 py-2 text-sm hover:bg-emerald-50 ${pathname === l.href ? 'bg-emerald-50 text-emerald-700 font-semibold' : 'text-gray-700'}`}>
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
            <button onClick={openNotifs} className="relative inline-flex items-center justify-center w-9 h-9 rounded hover:bg-emerald-800" aria-label="Notifications" title="Notifications">
              <span className="text-lg leading-none">🔔</span>
              {unseenCount > 0 && <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">{unseenCount > 99 ? '99+' : unseenCount}</span>}
            </button>
            {notifOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                <div className="fixed sm:absolute left-2 right-2 sm:left-auto sm:right-0 top-14 sm:top-auto sm:mt-1 w-auto sm:w-80 max-w-none sm:max-w-[90vw] bg-white text-gray-800 rounded-lg shadow-xl border z-50 max-h-[75vh] sm:max-h-96 overflow-y-auto">
                  <div className="px-4 py-2 border-b sticky top-0 bg-white flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="font-semibold text-sm">Notifications</span>
                    <span className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                      <button onClick={sendTest} className="text-emerald-600 hover:underline text-xs">Send test</button>
                      <button onClick={diagnosePush} className="text-emerald-600 hover:underline text-xs">Check phone push</button>
                      {unseenCount > 0 && <button onClick={markAllRead} className="text-emerald-600 hover:underline text-xs">Mark all read</button>}
                      {pushSupported() && (pushOn
                        ? <span className="text-green-600 text-xs">✓ On this device</span>
                        : <button onClick={enableThisDevice} className="text-emerald-600 hover:underline text-xs">Enable on this phone</button>)}
                    </span>
                  </div>
                  {notifs.length === 0 && <p className="px-4 py-6 text-center text-gray-400 text-sm">Nothing yet.</p>}
                  {notifs.map(n => {
                    const unseen = !notifSeenAt || n.created_at > notifSeenAt
                    const go = () => { setNotifOpen(false); if (n.link) router.push(n.link) }
                    return (
                      <div key={n.id} className={`flex items-start border-b last:border-0 hover:bg-gray-50 ${unseen ? 'bg-emerald-50/60' : ''}`}>
                        <button onClick={go} className="flex items-start gap-2 text-left min-w-0 flex-1 px-4 py-2">
                          {unseen && <span className="mt-1 w-2 h-2 rounded-full bg-emerald-500 shrink-0" />}
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{n.title}</div>
                            {n.body && <div className="text-xs text-gray-500">{n.body}</div>}
                            <div className="text-[10px] text-gray-400 mt-0.5">{isHO ? `${n.factory_code} · ` : ''}{new Date(n.created_at).toLocaleString()}</div>
                          </div>
                        </button>
                        <button onClick={() => dismissNotif(n.id)} title="Clear this notification" className="shrink-0 self-stretch px-3 text-gray-300 hover:text-green-600 hover:bg-green-50" aria-label="Clear">✓</button>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
          <span className="bg-emerald-800 px-2 sm:px-3 py-1 rounded-full text-xs whitespace-nowrap">
            {factoryLabel}
          </span>
          <span className="hidden md:inline">{fullName || 'User'}</span>
          <button onClick={handleLogout} className="hidden sm:inline-block bg-white text-emerald-700 px-3 py-1 rounded hover:bg-emerald-50 text-xs font-medium">
            Logout
          </button>
          {/* Mobile hamburger */}
          <button onClick={() => setMobileOpen(o => !o)} className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded hover:bg-emerald-800 relative" aria-label="Menu">
            <span className="text-xl leading-none">{mobileOpen ? '✕' : '☰'}</span>
            {isHO && pendingCount > 0 && !mobileOpen && <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-semibold rounded-full min-w-[1rem] text-center px-1 leading-tight">{pendingCount}</span>}
          </button>
        </div>
      </nav>

      {/* Mobile slide-down menu */}
      {mobileOpen && (
        <div className="md:hidden bg-emerald-700 text-white border-t border-emerald-600 max-h-[80vh] overflow-y-auto relative z-50">
          {menuGroups.map((g, gi) => (
            <div key={gi} className="border-b border-emerald-600/60 py-1">
              {g.header && <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-emerald-200">{g.header}</div>}
              {g.items.map(l => (
                <Link key={l.href} href={l.href} onClick={() => setMobileOpen(false)}
                  className={`flex items-center justify-between px-5 py-2.5 text-sm ${pathname === l.href ? 'bg-emerald-800 font-semibold' : 'hover:bg-emerald-800'}`}>
                  <span>{l.label}</span>
                  {l.href === '/sales-orders/changes' && isHO && pendingCount > 0 && (
                    <span className="bg-red-500 text-white text-xs font-semibold rounded-full min-w-[1.25rem] text-center px-1.5 py-0.5 leading-none">{pendingCount}</span>
                  )}
                </Link>
              ))}
            </div>
          ))}
          <button onClick={handleLogout} className="w-full text-left px-5 py-3 text-sm font-medium hover:bg-emerald-800">Logout</button>
        </div>
      )}
      {/* click-away backdrop (below the nav so other top menus stay clickable) */}
      {openMenu && <div className="fixed inset-0 z-40" onClick={() => setOpenMenu(null)} />}

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 space-y-2">
          {toasts.map(t => (
            <button key={t.id} onClick={() => router.push('/sales-orders/changes')}
              className="block w-72 text-left bg-white text-gray-800 border border-emerald-200 shadow-lg rounded-lg px-4 py-3 text-sm hover:bg-emerald-50">
              <span className="font-semibold text-emerald-700">{t.title}</span>
              <span className="block text-gray-600 mt-0.5">{t.message}</span>
              <span className="block text-emerald-600 text-xs mt-1">Click to view →</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
