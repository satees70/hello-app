'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export interface Profile {
  id: string
  email: string
  full_name: string
  factory_code: string
  role: string
}

async function fetchProfile(userId: string) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
  return data
}

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    // Check session immediately on mount
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace('/login'); return }
      const data = await fetchProfile(session.user.id)
      if (!data) { router.replace('/login'); return }
      setProfile(data)
      setLoading(false)
    })

    // Also listen for auth changes (logout, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') { router.replace('/login') }
    })

    return () => subscription.unsubscribe()
  }, [router])

  return { profile, loading }
}
