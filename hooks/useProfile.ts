'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { Permissions } from '@/lib/permissions'

export interface Profile {
  id: string
  email: string
  full_name: string
  factory_code: string
  role: string
  permissions?: Permissions | null
}

async function fetchProfile(userId: string) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
  return data
}

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace('/login'); return }
      const { data, error: profileError } = await supabase
        .from('profiles').select('*').eq('id', session.user.id).single()
      if (profileError) { setError(`Profile error: ${profileError.message}`); setLoading(false); return }
      if (!data) { setError('No profile found for this user.'); setLoading(false); return }
      setProfile(data)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') { router.replace('/login') }
    })

    return () => subscription.unsubscribe()
  }, [router])

  return { profile, loading, error }
}
