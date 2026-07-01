'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

// Full profile so we can resend it unchanged (update-user replaces these fields).
interface U {
  id: string; username: string | null; full_name: string; role: string
  factory_code: string; factory_codes: string[] | null; readonly_factories: string[] | null
  warehouse_user: boolean | null; capabilities: Record<string, boolean> | null
  location_perms: Record<string, unknown> | null; customer_filter: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  permissions: Record<string, any> | null
}

const HR_FIELDS = 'id, username, full_name, role, factory_code, factory_codes, readonly_factories, warehouse_user, capabilities, location_perms, customer_filter, permissions'

export default function HrUsersPage() {
  const { profile } = useProfile()
  const [users, setUsers] = useState<U[]>([])
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ username: '', full_name: '', password: '', hr: true, driver: false })

  const canManage = !!profile && (profile.role === 'admin' || can(profile, 'users', 'view'))

  const load = useCallback(async () => {
    const { data } = await supabase.from('profiles').select(HR_FIELDS).order('username')
    setUsers((data as U[]) || [])
  }, [])
  useEffect(() => { if (canManage) load() }, [canManage, load])

  const hasHr = (u: U) => u.role === 'admin' || !!u.permissions?.hr?.view
  const hasDriver = (u: U) => u.role === 'admin' || !!u.permissions?.driver?.view

  // Resend the whole profile with only the one permission toggled — so nothing else is lost.
  async function toggle(u: U, mod: 'hr' | 'driver', on: boolean) {
    if (u.role === 'admin') { setError('Admins already have full access.'); return }
    setError(null); setMsg(null)
    const permissions = { ...(u.permissions || {}) }
    permissions[mod] = { view: on, edit: on, delete: false }
    const res = await fetch('/api/update-user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: u.id, username: u.username, full_name: u.full_name, role: u.role,
        factory_code: u.factory_code, factory_codes: u.factory_codes, readonly_factories: u.readonly_factories,
        warehouse_user: u.warehouse_user, capabilities: u.capabilities, location_perms: u.location_perms,
        customer_filter: u.customer_filter, permissions,
      }),
    })
    const j = await res.json()
    if (!res.ok) setError(j.error || 'Update failed'); else await load()
  }

  async function addUser(e: FormEvent) {
    e.preventDefault()
    if (!form.username.trim() || !form.password) { setError('Username and password are required.'); return }
    setBusy(true); setError(null); setMsg(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const permissions: Record<string, any> = {}
    if (form.hr) permissions.hr = { view: true, edit: true, delete: false }
    if (form.driver) permissions.driver = { view: true, edit: true, delete: false }
    const res = await fetch('/api/create-user', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: form.username, password: form.password, full_name: form.full_name || form.username,
        factory_code: 'HEAD_OFFICE', factory_codes: ['HEAD_OFFICE'], role: 'user', permissions,
      }),
    })
    const j = await res.json()
    if (!res.ok) setError(j.error || 'Create failed')
    else { setMsg(`Created "${form.username}".`); setForm({ username: '', full_name: '', password: '', hr: true, driver: false }); await load() }
    setBusy(false)
  }

  if (!profile) return null
  if (!canManage) return <div className="p-8 text-center text-sm text-gray-500">Only admins (or users with the Users permission) can manage logins.</div>

  return (
    <main className="max-w-4xl mx-auto p-4 sm:p-6">
      <h1 className="text-2xl font-semibold mb-1">Users</h1>
      <p className="text-sm text-gray-500 mb-4">Create logins and control who can open the HR and Driver apps. Same accounts as the main portal.</p>

      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
      {msg && <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">{msg}</div>}

      {/* Add user */}
      <form onSubmit={addUser} className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="font-medium mb-3">Add a login</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">Username
            <input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
              placeholder="e.g. hrclerk" className="block mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs">Full name
            <input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })}
              className="block mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs">Password
            <input type="text" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
              className="block mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs flex items-center gap-1.5 pb-1.5"><input type="checkbox" checked={form.hr} onChange={e => setForm({ ...form, hr: e.target.checked })} /> HR access</label>
          <label className="text-xs flex items-center gap-1.5 pb-1.5"><input type="checkbox" checked={form.driver} onChange={e => setForm({ ...form, driver: e.target.checked })} /> Driver access</label>
          <button type="submit" disabled={busy} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Creating…' : 'Add login'}
          </button>
        </div>
      </form>

      {/* User list */}
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-500">
            <tr className="border-b border-gray-100">
              <th className="px-4 py-2 font-medium">Username</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium text-center">HR access</th>
              <th className="px-4 py-2 font-medium text-center">Driver access</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-b border-gray-50">
                <td className="px-4 py-2 font-mono text-xs">{u.username || '—'}</td>
                <td className="px-4 py-2">{u.full_name}</td>
                <td className="px-4 py-2 text-xs text-gray-500">{u.role}{u.role === 'admin' ? ' (all access)' : ''}</td>
                <td className="px-4 py-2 text-center">
                  <input type="checkbox" checked={hasHr(u)} disabled={u.role === 'admin'} onChange={e => toggle(u, 'hr', e.target.checked)} />
                </td>
                <td className="px-4 py-2 text-center">
                  <input type="checkbox" checked={hasDriver(u)} disabled={u.role === 'admin'} onChange={e => toggle(u, 'driver', e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
