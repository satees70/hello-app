import type { ReactNode } from 'react'
import AuthGate from '@/components/AuthGate'

// Every /hr page requires a logged-in user WITH the HR permission.
export default function HrLayout({ children }: { children: ReactNode }) {
  return <AuthGate requireModule="hr">{children}</AuthGate>
}
