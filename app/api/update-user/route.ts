import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requirePerm } from '@/lib/apiAuth'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const LOGIN_DOMAIN = 'avina.local'

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'users', 'edit')   // changing accounts/passwords is an edit action, not view
  if (auth instanceof NextResponse) return auth

  const { id, username, full_name, factory_code, factory_codes, readonly_factories, warehouse_user, offsite_allowed, role, permissions, capabilities, location_perms, customer_filter, password } = await request.json()
  if (!id) return NextResponse.json({ error: 'Missing user id' }, { status: 400 })

  // Non-admins may manage ordinary users (e.g. toggle HR/Driver access) but must
  // not grant the admin role or modify an existing admin account.
  if (auth.profile.role !== 'admin') {
    if (role === 'admin') return NextResponse.json({ error: 'Only an admin can grant the admin role.' }, { status: 403 })
    const { data: target } = await supabaseAdmin.from('profiles').select('role').eq('id', id).single()
    if (target?.role === 'admin') return NextResponse.json({ error: 'Only an admin can modify an admin account.' }, { status: 403 })
  }

  const profileUpdate: Record<string, unknown> = { full_name, factory_code, factory_codes: factory_codes ?? [factory_code], readonly_factories: readonly_factories ?? [], warehouse_user: !!warehouse_user, offsite_allowed: !!offsite_allowed, role, permissions: permissions ?? {}, capabilities: capabilities ?? {}, location_perms: location_perms ?? {}, customer_filter: (customer_filter ?? '').trim() || null }

  // Setting/changing the username also moves the login (internal) email so the
  // user can sign in by that username from now on.
  if (username !== undefined && username !== null && String(username).trim() !== '') {
    const uname = String(username).trim().toLowerCase()
    if (!/^[a-z0-9._-]+$/.test(uname)) return NextResponse.json({ error: 'Username may use letters, numbers, . _ - only.' }, { status: 400 })
    const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email: `${uname}@${LOGIN_DOMAIN}`, email_confirm: true })
    if (emailErr) {
      const msg = /already|exists|registered/i.test(emailErr.message) ? `Username "${uname}" is already taken.` : emailErr.message
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    profileUpdate.username = uname
  }

  const { error: profileError } = await supabaseAdmin.from('profiles').update(profileUpdate).eq('id', id)
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 400 })

  if (password) {
    const { error: pwError } = await supabaseAdmin.auth.admin.updateUserById(id, { password })
    if (pwError) return NextResponse.json({ error: pwError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
