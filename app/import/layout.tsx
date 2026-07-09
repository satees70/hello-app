import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import AuthGate from '@/components/AuthGate'
import ImportNavbar from '@/components/ImportNavbar'

export const metadata: Metadata = {
  title: 'Import EASWARI',
  appleWebApp: { capable: true, title: 'Import EASWARI', statusBarStyle: 'default' },
}

// Every /import page requires a logged-in user WITH the Import permission
// (a RESTRICTED module — Head Office + assigned import staff only).
export default function ImportLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate requireModule="import" hideBar>
      <ImportNavbar />
      {children}
    </AuthGate>
  )
}
