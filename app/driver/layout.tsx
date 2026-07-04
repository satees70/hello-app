import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import AuthGate from '@/components/AuthGate'

export const metadata: Metadata = {
  title: 'DRIVER EASWARI',
  appleWebApp: { capable: true, title: 'DRIVER EASWARI', statusBarStyle: 'default' },
}

// Every /driver page requires a logged-in user WITH the Driver permission.
export default function DriverLayout({ children }: { children: ReactNode }) {
  return <AuthGate requireModule="driver">{children}</AuthGate>
}
