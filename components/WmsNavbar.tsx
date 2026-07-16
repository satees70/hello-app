'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import Navbar from '@/components/Navbar'

// Green nav banner for the WMS (warehouse management) module, so it reads as its own
// area, distinct from the blue portal / Warehouse Receiving. More links get added here
// as WMS modules land (stock, putaway, picking); for now Module 1 is the Location Map.
// EXCEPTION: on the warehouse subdomain (warehouse.srrieaswari.com) the whole area is
// ONE app, so we defer to the single blue "EASWARI Warehouse" nav instead of showing a
// second, different-looking bar here.
const LINKS = [
  { href: '/wms', label: 'Home' },
  { href: '/wms/locations', label: 'Location Map' },
  { href: '/wms/stock', label: 'Stock' },
  { href: '/wms/purchase-orders', label: 'Purchase Orders' },
  { href: '/wms/suppliers', label: 'Suppliers' },
  { href: '/wms/putaway', label: 'Putaway' },
  { href: '/wms/transfers', label: 'Transfers' },
  { href: '/wms/orders', label: 'Orders to Pick' },
  { href: '/wms/dispatch', label: 'Delivery Orders' },
  { href: '/wms/counts', label: 'Stock Counts' },
  { href: '/wms/approvals', label: 'Approvals' },
  { href: '/wms/reports/expiry', label: 'Expiry' },
  { href: '/wms/reports', label: 'Reports' },
  { href: '/wms/labels', label: 'Labels' },
  { href: '/wms/movements', label: 'Movements' },
]

export default function WmsNavbar() {
  const { profile } = useProfile()
  const pathname = usePathname()
  const [onWarehouse, setOnWarehouse] = useState(false)   // warehouse.srrieaswari.com
  useEffect(() => { if (typeof window !== 'undefined') setOnWarehouse(window.location.host.startsWith('warehouse.')) }, [])

  // On the warehouse subdomain, show the same single blue warehouse nav as every
  // other warehouse page — no separate green bar, so it reads as one app.
  if (onWarehouse) {
    if (!profile) return null
    return <Navbar factoryCode={profile.factory_code} fullName={profile.full_name || ''} role={profile.role} />
  }

  return (
    <nav className="bg-emerald-700 text-white">
      <div className="max-w-6xl mx-auto px-4 flex flex-wrap items-center gap-1 min-h-14 py-1">
        <Link href="/wms" className="font-bold text-lg mr-4">EASWARI <span className="font-normal text-emerald-200">WMS</span></Link>
        {LINKS.map(l => {
          const active = pathname === l.href
          return (
            <Link key={l.href} href={l.href}
              className={`px-3 py-2 rounded text-sm font-medium ${active ? 'bg-emerald-800' : 'hover:bg-emerald-600'}`}>
              {l.label}
            </Link>
          )
        })}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Link href="/warehouse" className="text-emerald-100 hover:text-white hidden sm:inline">← Warehouse Receiving</Link>
          {profile && <span className="text-emerald-100 hidden md:inline">{profile.full_name || profile.username}</span>}
          <button onClick={() => supabase.auth.signOut()} className="rounded bg-emerald-800 px-3 py-1.5 hover:bg-emerald-900">Sign out</button>
        </div>
      </div>
    </nav>
  )
}
