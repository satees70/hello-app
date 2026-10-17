import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm, isHoOrAdmin } from '@/lib/apiAuth'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const LOGIN_DOMAIN = 'avina.local'
// The roles the app uses (the User Management page offers exactly these).
const ROLES = ['user', 'admin']

// Stable JSON (sorted keys) so jsonb fields compare equal regardless of key order.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

const includesHO = (fc: unknown, fcs: unknown) =>
  fc === 'HEAD_OFFICE' || (Array.isArray(fcs) && fcs.includes('HEAD_OFFICE'))

// The access fields update-user rewrites — compared for a non-admin's own account.
const ACCESS_FIELDS = ['factory_code', 'factory_codes', 'readonly_factories', 'warehouse_user', 'offsite_allowed', 'role', 'permissions', 'capabilities', 'location_perms', 'customer_filter'] as const

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'users', 'edit')   // changing accounts/passwords is an edit action, not view
  if (auth instanceof NextResponse) return auth

  const body = await request.json()
  const { id, username, full_name, factory_code, factory_codes, readonly_factories, warehouse_user, offsite_allowed, role, permissions, capabilities, location_perms, customer_filter, password } = body
  if (!id) return NextResponse.json({ error: 'Missing user id' }, { status: 400 })

  const { data: target } = await supabaseAdmin.from('profiles')
    .select('id, username, role, factory_code, factory_codes, readonly_factories, warehouse_user, offsite_allowed, permissions, capabilities, location_perms, customer_filter')
    .eq('id', id).maybeSingle()
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 })

  // Only known roles (an unchanged legacy value is allowed to round-trip).
  if (role !== undefined && !ROLES.includes(role) && role !== target.role) {
    return NextResponse.json({ error: `Unknown role "${role}".` }, { status: 400 })
  }

  const profileUpdate: Record<string, unknown> = { full_name, factory_code, factory_codes: factory_codes ?? [factory_code], readonly_factories: readonly_factories ?? [], warehouse_user: !!warehouse_user, offsite_allowed: !!offsite_allowed, role, permissions: permissions ?? {}, capabilities: capabilities ?? {}, location_perms: location_perms ?? {}, customer_filter: (customer_filter ?? '').trim() || null }

  // Non-admins may manage ordinary users (e.g. toggle HR/Driver access) but must
  // not grant the admin role or modify an existing admin account.
  const me = auth.profile
  if (me.role !== 'admin') {
    if (role === 'admin') return NextResponse.json({ error: 'Only an admin can grant the admin role.' }, { status: 403 })
    if (target.role === 'admin') return NextResponse.json({ error: 'Only an admin can modify an admin account.' }, { status: 403 })

    // Your own account: only your name / password — no raising your own access.
    // (The UI resends the whole profile, so compare what was sent to what's saved.)
    if (id === auth.userId) {
      const current: Record<string, unknown> = {
        factory_code: target.factory_code, factory_codes: target.factory_codes ?? [target.factory_code],
        readonly_factories: target.readonly_factories ?? [], warehouse_user: !!target.warehouse_user,
        offsite_allowed: !!target.offsite_allowed, role: target.role, permissions: target.permissions ?? {},
        capabilities: target.capabilities ?? {}, location_perms: target.location_perms ?? {},
        customer_filter: (target.customer_filter ?? '').trim() || null,
      }
      const changed = ACCESS_FIELDS.some(f => body[f] !== undefined && stable(profileUpdate[f]) !== stable(current[f]))
      const unameChanged = username != null && String(username).trim() !== '' && String(username).trim().toLowerCase() !== (target.username || '')
      if (changed || unameChanged) {
        return NextResponse.json({ error: 'You can only change your own name or password. Ask an admin to change your access.' }, { status: 403 })
      }
      // Nothing else changes — write back only the name.
      for (const k of Object.keys(profileUpdate)) if (k !== 'full_name') delete profileUpdate[k]
    }

    // Head Office sees every factory — only HO/admin may hand that out (or edit an HO account).
    if (!isHoOrAdmin(me)) {
      if (includesHO(target.factory_code, target.factory_codes)) return NextResponse.json({ error: 'Only Head Office can modify a Head Office account.' }, { status: 403 })
      if (includesHO(profileUpdate.factory_code, profileUpdate.factory_codes)) return NextResponse.json({ error: 'Only Head Office can give Head Office access.' }, { status: 403 })
    }
  }

  // Setting/changing the username also moves the login (internal) email so the
  // user can sign in by that username from now on. The profile is saved FIRST so
  // a failed profile update can't leave the login and the profile out of sync.
  let newUname: string | null = null
  if (username !== undefined && username !== null && String(username).trim() !== '') {
    const uname = String(username).trim().toLowerCase()
    if (!/^[a-z0-9._-]+$/.test(uname)) return NextResponse.json({ error: 'Username may use letters, numbers, . _ - only.' }, { status: 400 })
    newUname = uname
    profileUpdate.username = uname
  }

  const { error: profileError } = await supabaseAdmin.from('profiles').update(profileUpdate).eq('id', id)
  if (profileError) {
    const msg = newUname && /duplicate|unique/i.test(profileError.message) ? `Username "${newUname}" is already taken.` : profileError.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  if (newUname) {
    const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email: `${newUname}@${LOGIN_DOMAIN}`, email_confirm: true })
    if (emailErr) {
      // Put the old username back so the profile still matches how they log in.
      if (newUname !== target.username) await supabaseAdmin.from('profiles').update({ username: target.username }).eq('id', id)
      const msg = /already|exists|registered/i.test(emailErr.message) ? `Username "${newUname}" is already taken.` : emailErr.message
      return NextResponse.json({ error: msg }, { status: 400 })
    }
  }

  if (password) {
    const { error: pwError } = await supabaseAdmin.auth.admin.updateUserById(id, { password })
    if (pwError) return NextResponse.json({ error: pwError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
