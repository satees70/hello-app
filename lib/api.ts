import { supabase } from '@/lib/supabase'

// Client-side fetch wrapper for our own /api/* routes.
// ----------------------------------------------------------------------------
// The server routes authenticate the caller from the Supabase access token, so
// every privileged call must send it. Use apiFetch instead of fetch for any
// /api/* route that does service-role work; it attaches
// `Authorization: Bearer <token>` from the current session. (Plain fetch is
// fine for unauthenticated endpoints like /api/whoami.)
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  const headers = new Headers(init.headers || {})
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}
