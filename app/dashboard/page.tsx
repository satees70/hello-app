'use client'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { can, type ModuleKey } from '@/lib/permissions'
import Link from 'next/link'

export default function DashboardPage() {
  const { profile, loading, error } = useProfile()

  if (loading && !error) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (error) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{error}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const isHO = profile.factory_code === 'HEAD_OFFICE'
  const isAdmin = profile.role === 'admin'

  // Same grouping as the top menu. Each card maps to a permission section;
  // cards without a module (e.g. Location Map) are HO-only by their branch.
  type Card = { href: string; label: string; desc: string; module?: ModuleKey }
  const rawGroups: { header?: string; items: Card[] }[] = [
    { items: [
      { href: '/sales-orders/changes', label: isHO ? 'Pending Changes' : 'My Change Requests', desc: isHO ? 'Approve or reject line change requests' : 'Track change requests you raised', module: 'changes' },
    ] },
    { header: 'Sales', items: [
      { href: '/sales-orders', label: 'Sales Orders', desc: 'Upload and track sales order PDFs', module: 'sales' },
    ] },
    { header: 'Receiving', items: [
      { href: '/material-requests', label: 'Material Requests', desc: 'Material shortfalls requested from the warehouse', module: 'material_requests' },
      { href: '/incoming', label: 'Goods Received', desc: 'Receive deliveries (DO) into stock', module: 'goods_received' },
    ] },
    { header: 'Production', items: [
      { href: '/production', label: 'Order Board', desc: 'Production batches from confirmed orders', module: 'order_board' },
      { href: '/packing', label: 'Packing Schedule', desc: 'What to pack today, by line', module: 'packing' },
    ] },
    { header: 'Reports', items: [
      { href: '/stock', label: 'Stock', desc: 'Stock on hand by batch and expiry', module: 'stock' },
      { href: '/traceability', label: 'Traceability', desc: 'Recall report — trace batches & materials', module: 'traceability' },
      { href: '/admin/items', label: 'Items Master', desc: 'View and manage all items', module: 'items' },
      ...(isHO ? [
        { href: '/admin/bom', label: 'Bill of Materials', desc: 'Define recipes for manufactured items', module: 'bom' as ModuleKey },
        { href: '/admin/location-map', label: 'Location Map', desc: 'Map location codes to factories' },
      ] : []),
    ] },
    { header: 'Setup', items: [
      ...(isHO && isAdmin ? [{ href: '/admin/users', label: 'User Management', desc: 'Create and manage user accounts' }] : []),
    ] },
  ]
  const groups = rawGroups
    .map(g => ({ ...g, items: g.items.filter(c => !c.module || can(profile, c.module, 'view')) }))
    .filter(g => g.items.length > 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold mb-1">Welcome, {profile.full_name || profile.email}</h1>
        <p className="text-gray-500 mb-8">
          {isHO ? 'Head Office — you can see all factories' : `Factory: ${profile.factory_code}`}
        </p>

        <div className="space-y-7">
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.header && <h2 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">{g.header}</h2>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {g.items.map(card => (
                  <Link key={card.href} href={card.href}
                    className="bg-white rounded-xl shadow-sm border p-6 hover:shadow-md transition">
                    <h3 className="font-semibold text-lg mb-1">{card.label}</h3>
                    <p className="text-gray-500 text-sm">{card.desc}</p>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
