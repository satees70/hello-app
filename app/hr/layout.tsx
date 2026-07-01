import type { ReactNode } from 'react'
import AuthGate from '@/components/AuthGate'

// Every /hr page requires a logged-in user.
export default function HrLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>
}
