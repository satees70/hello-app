'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

const LINKS = [
  { href: '/hr/attendance', label: 'Attendance & OT' },
  { href: '/hr/employees', label: 'Employees & shifts' },
]

// Blue nav banner for the HR subdomain, matching the portal's look.
export default function HrNavbar() {
  const { profile } = useProfile()
  const pathname = usePathname()
  return (
    <nav className="bg-blue-600 text-white">
      <div className="max-w-6xl mx-auto px-4 flex flex-wrap items-center gap-1 min-h-14 py-1">
        <span className="font-bold text-lg mr-4">EASWARI <span className="font-normal text-blue-200">HR</span></span>
        {LINKS.map(l => {
          const active = pathname === l.href
          return (
            <Link key={l.href} href={l.href}
              className={`px-3 py-2 rounded text-sm font-medium ${active ? 'bg-blue-700' : 'hover:bg-blue-500'}`}>
              {l.label}
            </Link>
          )
        })}
        <div className="ml-auto flex items-center gap-3 text-sm">
          {profile && <span className="text-blue-100 hidden sm:inline">{profile.full_name || profile.username}</span>}
          <button onClick={() => supabase.auth.signOut()} className="rounded bg-blue-700 px-3 py-1.5 hover:bg-blue-800">Sign out</button>
        </div>
      </div>
    </nav>
  )
}
