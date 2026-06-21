import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const LOGIN_DOMAIN = 'avina.local'

export async function POST(request: Request) {
  const { username, email, password, full_name, factory_code, factory_codes, readonly_factories, role, permissions } = await request.json()

  const uname = (username || '').trim().toLowerCase()
  if (!uname || !/^[a-z0-9._-]+$/.test(uname)) {
    return NextResponse.json({ error: 'Username is required (letters, numbers, . _ - only).' }, { status: 400 })
  }
  const loginEmail = `${uname}@${LOGIN_DOMAIN}`

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
  })
  if (authError) {
    const msg = /already.*registered|exists/i.test(authError.message) ? `Username "${uname}" is already taken.` : authError.message
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: authData.user.id, username: uname, email: email || loginEmail, full_name, factory_code, factory_codes: factory_codes ?? [factory_code], readonly_factories: readonly_factories ?? [], role, permissions: permissions ?? {} })
  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id)   // roll back the auth user so the username frees up
    return NextResponse.json({ error: profileError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
