import type { ReactNode } from 'react'
import AuthGate from '@/components/AuthGate'

// Every /driver page requires a logged-in user.
export default function DriverLayout({ children }: { children: ReactNode }) {
  return <AuthGate>{children}</AuthGate>
}
