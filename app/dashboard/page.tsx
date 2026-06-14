'use client'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import Link from 'next/link'

export default function DashboardPage() {
  const { profile, loading, error } = useProfile()

  if (loading && !error) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (error) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{error}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const isHO = profile.factory_code === 'HEAD_OFFICE'
  const isAdmin = profile.role === 'admin'

  const cards = [
    { href: '/admin/items', label: 'Items Master', desc: 'View and manage all items', show: true },
    { href: '/sales-orders', label: 'Sales Orders', desc: 'Upload and track sales order PDFs', show: true },
    { href: '/sales-orders/changes', label: isHO ? 'Pending Changes' : 'My Change Requests', desc: isHO ? 'Approve or reject line change requests' : 'Track change requests you raised', show: true },
    { href: '/production', label: 'Production Board', desc: 'Production batches from confirmed orders', show: true },
    { href: '/material-requests', label: 'Material Requests', desc: 'Material shortfalls requested from the warehouse', show: true },
    { href: '/admin/bom', label: 'Bill of Materials', desc: 'Define recipes for manufactured items', show: isHO },
    { href: '/admin/location-map', label: 'Location Map', desc: 'Map location codes to factories', show: isHO },
    { href: '/admin/users', label: 'User Management', desc: 'Create and manage user accounts', show: isHO && isAdmin },
  ].filter(c => c.show)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold mb-1">Welcome, {profile.full_name || profile.email}</h1>
        <p className="text-gray-500 mb-8">
          {isHO ? 'Head Office — you can see all factories' : `Factory: ${profile.factory_code}`}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {cards.map(card => (
            <Link key={card.href} href={card.href}
              className="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
              <h2 className="font-semibold text-lg mb-1">{card.label}</h2>
              <p className="text-gray-500 text-sm">{card.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
