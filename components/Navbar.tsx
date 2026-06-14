'use client'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'

interface NavbarProps {
  factoryCode: string
  fullName: string
  role: string
}

export default function Navbar({ factoryCode, fullName, role }: NavbarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const isHO = factoryCode === 'HEAD_OFFICE'
  const isAdmin = role === 'admin'

  async function handleLogout() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const links = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/admin/items', label: 'Items' },
    { href: '/sales-orders', label: 'Sales Orders' },
    { href: '/sales-orders/changes', label: 'Pending Changes' },
    { href: '/production', label: 'Production' },
    { href: '/material-requests', label: 'Material Requests' },
    ...(isHO ? [
      { href: '/admin/bom', label: 'BOM' },
      { href: '/admin/location-map', label: 'Location Map' },
      ...(isAdmin ? [{ href: '/admin/users', label: 'Users' }] : []),
    ] : []),
  ]

  return (
    <nav className="bg-blue-700 text-white px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-6">
        <span className="font-bold text-lg">AVINA</span>
        {links.map(l => (
          <Link key={l.href} href={l.href}
            className={`text-sm hover:text-blue-200 ${pathname === l.href ? 'underline font-semibold' : ''}`}>
            {l.label}
          </Link>
        ))}
      </div>
      <div className="flex items-center gap-4 text-sm">
        <span className="bg-blue-800 px-3 py-1 rounded-full text-xs">
          {isHO ? 'Head Office' : factoryCode}
        </span>
        <span>{fullName || 'User'}</span>
        <button onClick={handleLogout} className="bg-white text-blue-700 px-3 py-1 rounded hover:bg-blue-50 text-xs font-medium">
          Logout
        </button>
      </div>
    </nav>
  )
}
