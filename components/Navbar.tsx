'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'

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

  function addToast(title: string, message: string) {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, title, message }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 7000)
  }

  // Head Office: count of change requests waiting for approval (refresh on nav + every 30s)
  useEffect(() => {
    if (!isHO) return
    let active = true
    const fetchCount = async () => {
      const { count } = await supabase
        .from('change_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Pending')
      if (active) setPendingCount(count || 0)
    }
    fetchCount()
    const timer = setInterval(fetchCount, 30000)
    return () => { active = false; clearInterval(timer) }
  }, [isHO, pathname])

  // Live notifications:
  //  - Head Office gets a toast when a new request is raised
  //  - The requester gets a toast when their request is approved/rejected
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null
    let myId: string | null = null
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) return
      myId = data.session.user.id
      supabase.realtime.setAuth(data.session.access_token)
      channel = supabase
        .channel('change-requests-feed')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'change_requests' }, payload => {
          if (!isHO) return
          const row = payload.new as { request_type?: string; requested_by_name?: string; requested_by_email?: string }
          const kind = row.request_type === 'delete' ? 'delete' : 'change'
          addToast('🔔 New request to approve', `New ${kind} request from ${row.requested_by_name || row.requested_by_email || 'a user'}`)
          setPendingCount(c => c + 1)
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'change_requests' }, payload => {
          const row = payload.new as { requested_by?: string; status?: string; request_type?: string }
          if (isHO && (row.status === 'Approved' || row.status === 'Rejected')) {
            setPendingCount(c => Math.max(0, c - 1))
          }
          // Notify the person who raised it
          if (row.requested_by === myId && (row.status === 'Approved' || row.status === 'Rejected')) {
            const what = row.request_type === 'delete' ? 'delete request' : 'change request'
            const ok = row.status === 'Approved'
            addToast(ok ? '✅ Request approved' : '❌ Request rejected', `Your ${what} was ${ok ? 'approved' : 'rejected'} by Head Office.`)
          }
        })
        .subscribe()
    })
    return () => { if (channel) supabase.removeChannel(channel) }
  }, [isHO])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  // Menu grouped by area so it's easy to scan (group with no header = top-level).
  // Empty groups (e.g. Setup for non-HO users) are dropped below.
  const menuGroups: { header?: string; items: { href: string; label: string }[] }[] = [
    { items: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/sales-orders/changes', label: 'Pending Changes' },
    ] },
    { header: 'Sales', items: [
      { href: '/sales-orders', label: 'Sales Orders' },
    ] },
    { header: 'Receiving', items: [
      { href: '/material-requests', label: 'Material Requests' },
      { href: '/incoming', label: 'Goods Received' },
    ] },
    { header: 'Production', items: [
      { href: '/production', label: 'Order Board' },
      { href: '/packing', label: 'Packing Schedule' },
    ] },
    { header: 'Reports', items: [
      { href: '/stock', label: 'Stock' },
      { href: '/traceability', label: 'Traceability' },
      { href: '/admin/items', label: 'Items' },
      ...(isHO ? [
        { href: '/admin/bom', label: 'BOM' },
        { href: '/admin/location-map', label: 'Location Map' },
      ] : []),
    ] },
    { header: 'Setup', items: [
      ...(isHO && isAdmin ? [{ href: '/admin/users', label: 'Users' }] : []),
    ] },
  ].filter(g => g.items.length > 0)
  return (
    <>
      <nav className="bg-blue-700 text-white px-4 sm:px-6 flex items-center justify-between gap-3 relative z-50">
        <div className="flex items-stretch flex-wrap gap-0.5 min-w-0">
          <span className="font-bold text-lg shrink-0 self-center mr-3">AVINA</span>
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
            {isHO ? 'Head Office' : factoryCode}
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
