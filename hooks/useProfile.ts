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

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session) { router.replace('/login'); return }
      const { data, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).single()
      if (error || !data) { router.replace('/login'); return }
      setProfile(data)
      setLoading(false)
    })
    return () => subscription.unsubscribe()
  }, [router])

  return { profile, loading }
}
