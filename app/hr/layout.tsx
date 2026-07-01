import type { ReactNode } from 'react'
import AuthGate from '@/components/AuthGate'
import HrNavbar from '@/components/HrNavbar'

// Every /hr page requires a logged-in user WITH the HR permission.
export default function HrLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate requireModule="hr" hideBar>
      <HrNavbar />
      {children}
    </AuthGate>
  )
}
