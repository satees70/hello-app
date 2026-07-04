import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import AuthGate from '@/components/AuthGate'
import HrNavbar from '@/components/HrNavbar'

export const metadata: Metadata = {
  title: 'HR EASWARI',
  appleWebApp: { capable: true, title: 'HR EASWARI', statusBarStyle: 'default' },
}

// Every /hr page requires a logged-in user WITH the HR permission.
export default function HrLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate requireModule="hr" hideBar>
      <HrNavbar />
      {children}
    </AuthGate>
  )
}
