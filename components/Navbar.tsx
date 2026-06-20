'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { can, type ModuleKey, type Permissions } from '@/lib/permissions'

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
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [myFactories, setMyFactories] = useState<string[]>([])
  // This user's permissions (for menu view-gating). Until loaded, can() treats an
  // unset grid as full access, so nothing is hidden by mistake.
  const profileLike = { role, permissions: perms }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return
      const { data: p } = await supabase.from('profiles').select('permissions, factory_codes').eq('id', data.session.user.id).single()
      setPerms((p?.permissions as Permissions) ?? {})
      setMyFactories((p?.factory_codes as string[]) ?? [])
    })
  }, [])

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
  const APPROVAL_TABLES = ['change_requests', 'correction_requests', 'do_change_requests', 'split_requests', 'stock_adjustments', 'run_mode_requests', 'mr_cancel_requests'] as const
  const TABLE_LABEL: Record<string, string> = {
    change_requests: 'change', correction_requests: 'timer cancellation', do_change_requests: 'Goods Received change',
    split_requests: 'batch split / un-combine', stock_adjustments: 'stock adjustment', run_mode_requests: 'run-mode change',
    mr_cancel_requests: 'material request cancellation',
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
    ] },
    { header: 'Sales', items: [
      { href: '/sales-orders', label: 'Sales Orders', module: 'sales' },
    ] },
    { header: 'Receiving', items: [
      { href: '/material-requests', label: 'Material Requests', module: 'material_requests' },
      { href: '/incoming', label: 'Goods Received', module: 'goods_received' },
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
      ...(isHO ? [
        { href: '/admin/bom', label: 'BOM', module: 'bom' as ModuleKey },
        { href: '/admin/location-map', label: 'Location Map' },
      ] : []),
    ] },
    { header: 'Setup', items: [
      { href: '/admin/packing-lines', label: 'Packing Lines', module: 'packing_lines' as ModuleKey },
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
        <div className="flex items-stretch flex-wrap gap-0.5 min-w-0">
          <span className="font-bold text-lg shrink-0 self-center mr-3">EASWARI</span>
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
        <div className="flex items-center gap-2 sm:gap-4 text-sm shrink-0">
          <span className="bg-blue-800 px-2 sm:px-3 py-1 rounded-full text-xs whitespace-nowrap">
            {factoryLabel}
          </span>
          <span className="hidden md:inline">{fullName || 'User'}</span>
          <button onClick={handleLogout} className="bg-white text-blue-700 px-3 py-1 rounded hover:bg-blue-50 text-xs font-medium">
            Logout
          </button>
        </div>
      </nav>
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
