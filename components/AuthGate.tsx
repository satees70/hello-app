'use client'
import type { ReactNode } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

// Wraps the HR / Driver route groups: requires a logged-in Supabase user
// (useProfile bounces to /login if there's no session), and shows a slim bar
// with who's signed in + a sign-out button.
export default function AuthGate({ children }: { children: ReactNode }) {
  const { profile, loading, error } = useProfile()

  if (loading) return <div className="p-6 text-sm text-gray-500">Checking sign-in…</div>
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>
  if (!profile) return null   // redirecting to /login

  return (
    <>
      <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 text-sm">
        <span className="text-gray-500">Signed in as <b className="text-gray-800">{profile.full_name || profile.username}</b></span>
        <button onClick={() => supabase.auth.signOut()} className="text-blue-600 hover:underline">Sign out</button>
      </div>
      {children}
    </>
  )
}
