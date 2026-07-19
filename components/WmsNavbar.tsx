'use client'
import { useProfile } from '@/hooks/useProfile'
import Navbar from '@/components/Navbar'

// The WMS area uses the SAME warehouse menu as the rest of the Warehouse app — one
// consistent header everywhere. Navbar detects it's a warehouse page (by subdomain or a
// /wms/* — /warehouse* path) and shows the grouped Warehouse tabs, keeping the notification
// bell and office-network guard that live in Navbar.
export default function WmsNavbar() {
  const { profile } = useProfile()
  if (!profile) return null
  return <Navbar factoryCode={profile.factory_code} fullName={profile.full_name || ''} role={profile.role} />
}
