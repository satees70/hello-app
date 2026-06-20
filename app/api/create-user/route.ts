import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  const { email, password, full_name, factory_code, factory_codes, readonly_factories, role, permissions } = await request.json()

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (authError) return NextResponse.json({ error: authError.message }, { status: 400 })

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .insert({ id: authData.user.id, email, full_name, factory_code, factory_codes: factory_codes ?? [factory_code], readonly_factories: readonly_factories ?? [], role, permissions: permissions ?? {} })
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
