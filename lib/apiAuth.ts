import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { can, type ModuleKey, type Action, type Permissions, type LocationPerms } from '@/lib/permissions'

// Server-side auth for the service-role API routes.
// ----------------------------------------------------------------------------
// Every /api route that does privileged work runs with the Supabase SERVICE
// ROLE key, which bypasses Row Level Security. That is fine ONLY if the route
// first proves who the caller is and that they're allowed to do the action —
// otherwise anyone on the internet can call it. These helpers do that: they
// verify the caller's Supabase access token (sent as `Authorization: Bearer …`
// by the client `apiFetch` wrapper) and load their profile so we can check
// role / permissions before touching any data.
//
// Usage in a route:
//   const auth = await requirePerm(request, 'hr', 'edit')
//   if (auth instanceof NextResponse) return auth   // 401/403 short-circuit
//   // ...auth.userId / auth.profile are now trusted

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export interface CallerProfile {
  id: string
  role: string
  permissions: Permissions | null
  readonly_factories: string[] | null
  location_perms: LocationPerms | null
  warehouse_user: boolean | null
}
export interface Caller {
  userId: string
  profile: CallerProfile
}

function bearer(request: Request): string {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
}

const unauth = () => NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
const forbidden = () => NextResponse.json({ error: 'You don’t have permission to do that.' }, { status: 403 })

// Verify the access token and load the caller's profile. Returns null when the
// request has no valid session.
export async function getCaller(request: Request): Promise<Caller | null> {
  const token = bearer(request)
  if (!token) return null
  const { data: { user }, error } = await admin.auth.getUser(token)
  if (error || !user) return null
  const { data: profile } = await admin
    .from('profiles')
    .select('id, role, permissions, readonly_factories, location_perms, warehouse_user')
    .eq('id', user.id)
    .single()
  if (!profile) return null
  return { userId: user.id, profile: profile as CallerProfile }
}

// Gate a route on a module/action permission (admins always pass — see can()).
// Returns the Caller when allowed, or a NextResponse (401/403) to return as-is.
//
// opts mirror the extra ways the UI grants access, for routes that fire before a
// specific factory is known (e.g. uploading a document):
//   allowWarehouse — warehouse staff (warehouse_user) receive for every factory,
//                    so they pass regardless of the section grid (Goods Received).
//   anyLocation    — a user granted `edit` at ANY single factory (via per-location
//                    overrides) passes, even if their default grid is view-only.
export async function requirePerm(
  request: Request,
  module: ModuleKey,
  action: Action,
  opts?: { allowWarehouse?: boolean; anyLocation?: boolean },
): Promise<Caller | NextResponse> {
  const caller = await getCaller(request)
  if (!caller) return unauth()
  const p = caller.profile
  let ok = can(p, module, action)
  if (!ok && opts?.allowWarehouse && p.warehouse_user) ok = true
  if (!ok && opts?.anyLocation && action === 'edit') {
    const lp = p.location_perms || {}
    ok = Object.keys(lp).some(fc => !!lp[fc]?.[module]?.edit)
  }
  if (!ok) return forbidden()
  return caller
}

// Gate a route on being an admin.
export async function requireAdmin(request: Request): Promise<Caller | NextResponse> {
  const caller = await getCaller(request)
  if (!caller) return unauth()
  if (caller.profile.role !== 'admin') return forbidden()
  return caller
}
