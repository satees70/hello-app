'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

// Usernames are stored in Supabase as a hidden internal email, e.g. "gopi@avina.local".
// Users type just their username; an email with "@" is still accepted as-is.
const LOGIN_DOMAIN = 'avina.local'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const id = email.trim()
    const loginEmail = id.includes('@') ? id : `${id.toLowerCase()}@${LOGIN_DOMAIN}`
    const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmail, password })
    if (error) { setError(error.message); setLoading(false); return }
    if (!data.session) { setError('Login succeeded but no session returned. Please try again.'); setLoading(false); return }
    // Verify session is actually stored before redirecting
    const { data: { session: stored } } = await supabase.auth.getSession()
    if (!stored) { setError('Session was not saved to browser storage. Try disabling browser privacy extensions.'); setLoading(false); return }
    window.location.href = '/dashboard'
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md p-8 text-gray-900">
        <h1 className="text-2xl font-bold text-center mb-2">EASWARI Portal</h1>
        <p className="text-center text-gray-500 mb-6 text-sm">Sign in to your account</p>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Username</label>
            <input type="text" autoCapitalize="none" autoCorrect="off" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="your username" className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900" required />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900" required />
          </div>
          {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  )
}
