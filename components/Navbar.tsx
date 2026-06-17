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

  const links = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/admin/items', label: 'Items' },
    { href: '/sales-orders', label: 'Sales Orders' },
    { href: '/sales-orders/changes', label: 'Pending Changes' },
    { href: '/production', label: 'Order Board' },
    { href: '/packing', label: 'Packing Schedule' },
    { href: '/material-requests', label: 'Material Requests' },
    { href: '/incoming', label: 'Goods Received' },
    { href: '/stock', label: 'Stock' },
    { href: '/traceability', label: 'Traceability' },
    ...(isHO ? [
      { href: '/admin/bom', label: 'BOM' },
      { href: '/admin/location-map', label: 'Location Map' },
      ...(isAdmin ? [{ href: '/admin/users', label: 'Users' }] : []),
    ] : []),
  ]

  return (
    <>
      <nav className="bg-blue-700 text-white px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 sm:gap-6 overflow-x-auto whitespace-nowrap min-w-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="font-bold text-lg shrink-0">AVINA</span>
          {links.map(l => (
            <Link key={l.href} href={l.href}
              className={`text-sm hover:text-blue-200 inline-flex items-center shrink-0 ${pathname === l.href ? 'underline font-semibold' : ''}`}>
              {l.label}
              {l.href === '/sales-orders/changes' && isHO && pendingCount > 0 && (
                <span className="ml-1.5 bg-red-500 text-white text-xs font-semibold rounded-full min-w-[1.25rem] text-center px-1.5 py-0.5 leading-none">
                  {pendingCount}
                </span>
              )}
            </Link>
          ))}
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
