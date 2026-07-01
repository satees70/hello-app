import type { ReactNode } from 'react'
import AuthGate from '@/components/AuthGate'

// Every /driver page requires a logged-in user WITH the Driver permission.
export default function DriverLayout({ children }: { children: ReactNode }) {
  return <AuthGate requireModule="driver">{children}</AuthGate>
}
