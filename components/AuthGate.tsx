'use client'
import type { ReactNode } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can, type ModuleKey } from '@/lib/permissions'

// Wraps the HR / Driver route groups: requires a logged-in Supabase user
// (useProfile bounces to /login if there's no session), and shows a slim bar
// with who's signed in + a sign-out button. When `requireModule` is given, the
// user must also have that permission (admins always pass).
export default function AuthGate({ children, requireModule, hideBar }: { children: ReactNode; requireModule?: ModuleKey; hideBar?: boolean }) {
  const { profile, loading, error } = useProfile()

  if (loading) return <div className="p-6 text-sm text-gray-500">Checking sign-in…</div>
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>
  if (!profile) return null   // redirecting to /login

  if (requireModule && !can(profile, requireModule, 'view')) {
    return (
      <div className="p-8 text-center">
        <p className="font-medium text-gray-800">No access</p>
        <p className="text-sm text-gray-500 mt-1">Your account doesn&apos;t have permission for this page. Ask an admin to grant it.</p>
        <button onClick={() => supabase.auth.signOut()} className="mt-3 text-sm text-blue-600 hover:underline">Sign out</button>
      </div>
    )
  }

  return (
    <>
      {!hideBar && (
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2 text-sm">
          <span className="text-gray-500">Signed in as <b className="text-gray-800">{profile.full_name || profile.username}</b></span>
          <button onClick={() => supabase.auth.signOut()} className="text-blue-600 hover:underline">Sign out</button>
        </div>
      )}
      {children}
    </>
  )
}
