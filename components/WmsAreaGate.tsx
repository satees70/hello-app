'use client'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useProfile } from '@/hooks/useProfile'
import { canWmsArea, type ModuleKey } from '@/lib/permissions'

// Enforces the per-user WMS-area permissions at the page level (not just hidden menu links),
// so a restricted user can't reach an area by typing the URL. The /wms layout already requires
// the 'warehouse' master; this narrows it to the specific area. Most-specific prefix wins
// (e.g. /wms/reports/expiry → Counts & approvals, not Reports).
const AREA_BY_PREFIX: [string, ModuleKey][] = [
  ['/wms/purchase-orders', 'wms_inbound'],
  ['/wms/suppliers', 'wms_inbound'],
  ['/wms/putaway', 'wms_inbound'],
  ['/wms/stock', 'wms_stock'],
  ['/wms/locations', 'wms_stock'],
  ['/wms/transfers', 'wms_stock'],
  ['/wms/movements', 'wms_stock'],
  ['/wms/orders', 'wms_picking'],
  ['/wms/dispatch', 'wms_picking'],
  ['/wms/qc', 'wms_control'],
  ['/wms/counts', 'wms_control'],
  ['/wms/approvals', 'wms_control'],
  ['/wms/reports/expiry', 'wms_control'],   // before /wms/reports
  ['/wms/labels', 'wms_reports'],
  ['/wms/reports', 'wms_reports'],
]

export default function WmsAreaGate({ children }: { children: ReactNode }) {
  const { profile } = useProfile()
  const pathname = usePathname()
  if (!profile) return <>{children}</>   // still loading / not signed in — the layout's AuthGate handles it
  const match = AREA_BY_PREFIX.find(([p]) => pathname === p || pathname.startsWith(p + '/'))
  if (match && !canWmsArea(profile, match[1])) {
    return (
      <div className="p-8 text-center">
        <p className="font-medium text-gray-800">No access to this warehouse area</p>
        <p className="text-sm text-gray-500 mt-1">Your account isn&apos;t allowed to use this part of the warehouse app. Ask Head Office to grant it.</p>
        <Link href="/wms" className="mt-3 inline-block text-sm text-emerald-600 hover:underline">← Warehouse home</Link>
      </div>
    )
  }
  return <>{children}</>
}
