'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'
import { PERMISSION_MODULES, defaultGrid, isConfigured, type Permissions, type Action } from '@/lib/permissions'

interface UserRow { id: string; email: string; full_name: string; factory_code: string; factory_codes: string[] | null; role: string; permissions: Permissions | null }
type FormState = { email: string; password: string; full_name: string; factory_code: string; factory_codes: string[]; role: string; permissions: Permissions }
const blankForm = (): FormState => ({ email: '', password: '', full_name: '', factory_code: '', factory_codes: [], role: 'user', permissions: defaultGrid() })

export default function UsersPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const [users, setUsers] = useState<UserRow[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [mode, setMode] = useState<'closed' | 'create' | 'edit'>('closed')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(blankForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (!profile) return
    if (profile.factory_code !== 'HEAD_OFFICE' || profile.role !== 'admin') {
      router.replace('/dashboard')
      return
    }
    loadData()
  }, [profile])

  async function loadData() {
    const [{ data: u }, { data: f }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('factories').select('*').order('code'),
    ])
    setUsers(u || [])
    setFactories(f || [])
  }

  function openCreate() {
    setEditingId(null); setForm(blankForm()); setError(''); setSuccess(''); setMode('create')
  }
  function openEdit(u: UserRow) {
    setEditingId(u.id); setError(''); setSuccess('')
    setForm({
      email: u.email, password: '', full_name: u.full_name || '', factory_code: u.factory_code,
      factory_codes: u.factory_codes?.length ? u.factory_codes : (u.factory_code ? [u.factory_code] : []),
      role: u.role,
      permissions: isConfigured(u.permissions) ? (u.permissions as Permissions) : defaultGrid(),
    })
    setMode('edit')
  }
  function closeForm() { setMode('closed'); setEditingId(null) }

  // Factory access (multi-select). Head Office is exclusive (sees everything).
  const hoSelected = form.factory_codes.includes('HEAD_OFFICE') || form.factory_code === 'HEAD_OFFICE'
  function toggleHO(checked: boolean) {
    setForm(prev => checked
      ? { ...prev, factory_codes: ['HEAD_OFFICE'], factory_code: 'HEAD_OFFICE' }
      : { ...prev, factory_codes: [], factory_code: '' })
  }
  function toggleFactory(code: string, checked: boolean) {
    setForm(prev => {
      const list = checked
        ? [...prev.factory_codes.filter(c => c !== 'HEAD_OFFICE'), code]
        : prev.factory_codes.filter(c => c !== code)
      return { ...prev, factory_codes: list, factory_code: list[0] || '' }
    })
  }

  const setPerm = (moduleKey: string, action: Action, checked: boolean) =>
    setForm(prev => ({ ...prev, permissions: { ...prev.permissions, [moduleKey]: { ...prev.permissions[moduleKey], [action]: checked } } }))
  const setAll = (checked: boolean) => {
    const g: Permissions = {}
    for (const m of PERMISSION_MODULES) g[m.key] = { view: checked, edit: checked, delete: checked }
    setForm(prev => ({ ...prev, permissions: g }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(''); setSuccess('')
    if (form.factory_codes.length === 0) { setError('Select Head Office or at least one factory.'); setSaving(false); return }
    const isEdit = mode === 'edit'
    const url = isEdit ? '/api/update-user' : '/api/create-user'
    const body = isEdit
      ? { id: editingId, full_name: form.full_name, factory_code: form.factory_code, factory_codes: form.factory_codes, role: form.role, permissions: form.permissions, password: form.password || undefined }
      : { email: form.email, password: form.password, full_name: form.full_name, factory_code: form.factory_code, factory_codes: form.factory_codes, role: form.role, permissions: form.permissions }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (data.error) { setError(data.error); setSaving(false); return }
    setSuccess(isEdit ? 'User updated successfully!' : 'User created successfully!')
    setSaving(false)
    closeForm()
    loadData()
  }

  // Short access summary for the table
  function accessLabel(u: UserRow) {
    if (u.role === 'admin') return { text: 'Full (Admin)', cls: 'bg-purple-100 text-purple-700' }
    if (!isConfigured(u.permissions)) return { text: 'Default (full)', cls: 'bg-gray-100 text-gray-600' }
    const p = u.permissions as Permissions
    const views = PERMISSION_MODULES.filter(m => p[m.key]?.view).length
    return { text: `Custom · ${views}/${PERMISSION_MODULES.length} sections`, cls: 'bg-amber-100 text-amber-700' }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">User Management</h1>
          <button onClick={() => (mode === 'closed' ? openCreate() : closeForm())}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
            {mode === 'closed' ? '+ Add User' : 'Cancel'}
          </button>
        </div>

        {mode !== 'closed' && (
          <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{mode === 'edit' ? `Edit User — ${form.email}` : 'Create New User'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Full Name</label>
                <input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email</label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500" required disabled={mode === 'edit'} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{mode === 'edit' ? 'New Password (leave blank to keep)' : 'Password'}</label>
                <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" required={mode === 'create'} minLength={6}
                  placeholder={mode === 'edit' ? '••••••• (unchanged)' : ''} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2">
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>

            {/* Factory access (multi-select) */}
            <div>
              <label className="block text-sm font-medium mb-1">Factory access</label>
              <label className="inline-flex items-center gap-2 text-sm mb-2">
                <input type="checkbox" className="h-4 w-4" checked={hoSelected} onChange={e => toggleHO(e.target.checked)} />
                Head Office (sees all factories)
              </label>
              {!hoSelected && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 border rounded-lg p-3">
                    {factories.map(f => (
                      <label key={f.code} className="inline-flex items-center gap-2 text-sm">
                        <input type="checkbox" className="h-4 w-4"
                          checked={form.factory_codes.includes(f.code)}
                          onChange={e => toggleFactory(f.code, e.target.checked)} />
                        {f.name}
                      </label>
                    ))}
                  </div>
                  {form.factory_codes.length === 0 && <p className="text-xs text-amber-600 mt-1">Select at least one factory (or tick Head Office).</p>}
                  {form.factory_codes.length > 1 && <p className="text-xs text-blue-600 mt-1">This user will see all {form.factory_codes.length} selected factories together (merged view).</p>}
                </>
              )}
            </div>

            {/* Permission grid */}
            {form.role === 'admin' ? (
              <p className="text-sm text-purple-700 bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                Admins have full access to everything — no permission grid needed.
              </p>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium">Permissions (per section)</label>
                  <div className="text-xs space-x-3">
                    <button type="button" onClick={() => setAll(true)} className="text-blue-600 hover:underline">Tick all</button>
                    <button type="button" onClick={() => setAll(false)} className="text-blue-600 hover:underline">Clear all</button>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mb-2">The user only sees their own factory&apos;s data, limited to what&apos;s ticked here.</p>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Section</th>
                        {(['view', 'edit', 'delete'] as Action[]).map(a => (
                          <th key={a} className="px-3 py-2 font-medium text-gray-600 capitalize w-20 text-center">{a}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {PERMISSION_MODULES.map(m => (
                        <tr key={m.key} className="border-b last:border-0">
                          <td className="px-3 py-2">
                            <div className="font-medium">{m.label}</div>
                            <div className="text-xs text-gray-400">{m.desc}</div>
                          </td>
                          {(['view', 'edit', 'delete'] as Action[]).map(a => (
                            <td key={a} className="px-3 py-2 text-center">
                              <input type="checkbox" className="h-4 w-4"
                                checked={!!form.permissions[m.key]?.[a]}
                                onChange={e => setPerm(m.key, a, e.target.checked)} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded">{error}</p>}
            {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded">{success}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={saving}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                {saving ? 'Saving...' : mode === 'edit' ? 'Save Changes' : 'Create User'}
              </button>
              <button type="button" onClick={closeForm} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
            </div>
          </form>
        )}

        {success && mode === 'closed' && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-4">{success}</p>}

        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {['Name', 'Email', 'Factory / HO', 'Role', 'Access', ''].map((h, i) => (
                  <th key={i} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">No users yet</td></tr>
              )}
              {users.map(u => {
                const al = accessLabel(u)
                return (
                  <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{u.full_name || '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{u.email}</td>
                    <td className="px-4 py-3">
                      {(u.factory_codes?.length ? u.factory_codes : [u.factory_code]).filter(Boolean).map(fc => (
                        <span key={fc} className={`mr-1 mb-1 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${fc === 'HEAD_OFFICE' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {fc === 'HEAD_OFFICE' ? 'Head Office' : fc}
                        </span>
                      ))}
                    </td>
                    <td className="px-4 py-3 capitalize">{u.role}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${al.cls}`}>{al.text}</span></td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(u)} className="text-blue-600 hover:underline text-sm font-medium">Edit</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
