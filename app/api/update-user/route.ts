import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  const { id, full_name, factory_code, factory_codes, role, permissions, password } = await request.json()
  if (!id) return NextResponse.json({ error: 'Missing user id' }, { status: 400 })

  // Update the profile (name / factory / factory list / role / permission grid)
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ full_name, factory_code, factory_codes: factory_codes ?? [factory_code], role, permissions: permissions ?? {} })
    .eq('id', id)
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 400 })

  // Optional password reset
  if (password) {
    const { error: pwError } = await supabaseAdmin.auth.admin.updateUserById(id, { password })
    if (pwError) return NextResponse.json({ error: pwError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
