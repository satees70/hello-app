'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { can, type ModuleKey } from '@/lib/permissions'
import type { Profile } from './useProfile'

// Bounce the user to /no-access if they lack View permission for this section.
// Admins, Head Office, and not-yet-configured users always pass (see can()).
export function useRequireView(profile: Profile | null, module: ModuleKey) {
  const router = useRouter()
  useEffect(() => {
    if (profile && !can(profile, module, 'view')) router.replace('/no-access')
  }, [profile, module, router])
}
