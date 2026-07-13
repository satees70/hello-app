import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import AuthGate from '@/components/AuthGate'
import WmsNavbar from '@/components/WmsNavbar'

export const metadata: Metadata = {
  title: 'WMS EASWARI',
  appleWebApp: { capable: true, title: 'WMS EASWARI', statusBarStyle: 'default' },
}

// Every /wms page requires a logged-in user WITH the 'warehouse' (WMS) permission —
// a restricted module, so Head Office + admins always pass and everyone else needs an
// explicit grant. This is separate from the 'warehouse user' flag used by Warehouse
// Receiving, so the two areas can be granted independently.
export default function WmsLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate requireModule="warehouse" hideBar>
      <WmsNavbar />
      {children}
    </AuthGate>
  )
}
