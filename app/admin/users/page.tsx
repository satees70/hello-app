'use client'
import { Fragment, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'
import { PERMISSION_MODULES, CAPABILITIES, defaultGrid, defaultCaps, isConfigured, type Permissions, type Action } from '@/lib/permissions'
import MultiFilter from '@/components/MultiFilter'

interface UserRow { id: string; username: string | null; email: string; full_name: string; factory_code: string; factory_codes: string[] | null; readonly_factories: string[] | null; warehouse_user?: boolean | null; role: string; permissions: Permissions | null; capabilities?: Record<string, boolean> | null; location_perms?: Record<string, Permissions> | null }
type FormState = { username: string; email: string; password: string; full_name: string; factory_code: string; factory_codes: string[]; readonly_factories: string[]; warehouse_user: boolean; role: string; permissions: Permissions; capabilities: Record<string, boolean>; location_perms: Record<string, Permissions> }
const blankForm = (): FormState => ({ username: '', email: '', password: '', full_name: '', factory_code: '', factory_codes: [], readonly_factories: [], warehouse_user: false, role: 'user', permissions: defaultGrid(), capabilities: defaultCaps(), location_perms: {} })

export default function UsersPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const [users, setUsers] = useState<UserRow[]>([])
  const [uFilters, setUFilters] = useState<Record<string, Set<string>>>({})
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
      username: u.username || '', email: u.email, password: '', full_name: u.full_name || '', factory_code: u.factory_code,
      factory_codes: u.factory_codes?.length ? u.factory_codes : (u.factory_code ? [u.factory_code] : []),
      readonly_factories: u.readonly_factories || [],
      warehouse_user: !!u.warehouse_user,
      role: u.role,
      permissions: isConfigured(u.permissions) ? (u.permissions as Permissions) : defaultGrid(),
      capabilities: { ...defaultCaps(), ...(u.capabilities || {}) },
      location_perms: u.location_perms || {},
    })
    setMode('edit')
  }
  // Copy another user's access into a NEW user — same factories/role/permissions,
  // but a fresh username & password for the admin to fill in.
  function openCopy(u: UserRow) {
    setEditingId(null); setError(''); setSuccess('')
    setForm({
      username: '', email: '', password: '', full_name: '', factory_code: u.factory_code,
      factory_codes: u.factory_codes?.length ? u.factory_codes : (u.factory_code ? [u.factory_code] : []),
      readonly_factories: u.readonly_factories || [],
      warehouse_user: !!u.warehouse_user,
      role: u.role,
      permissions: isConfigured(u.permissions) ? (u.permissions as Permissions) : defaultGrid(),
      capabilities: { ...defaultCaps(), ...(u.capabilities || {}) },
      location_perms: u.location_perms ? JSON.parse(JSON.stringify(u.location_perms)) : {},
    })
    setMode('create')
    setSuccess(`Copied access from ${u.username || u.full_name || u.email} — set a username & password, adjust if needed, then create.`)
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

  // Grid helpers take an optional location: null = the default grid; a factory code
  // = that location's override grid (in form.location_perms).
  const gridOf = (loc: string | null): Permissions => loc === null ? form.permissions : (form.location_perms[loc] || {})
  const writeGrid = (loc: string | null, g: Permissions) => setForm(prev => loc === null
    ? { ...prev, permissions: g }
    : { ...prev, location_perms: { ...prev.location_perms, [loc]: g } })
  const setPerm = (loc: string | null, moduleKey: string, action: Action, checked: boolean) =>
    writeGrid(loc, { ...gridOf(loc), [moduleKey]: { ...gridOf(loc)[moduleKey], [action]: checked } })
  const setAll = (checked: boolean) => {
    const g: Permissions = {}
    for (const m of PERMISSION_MODULES) g[m.key] = { view: checked, edit: checked, delete: checked }
    writeGrid(null, g)
  }
  // One-click level for a single section: none | view | edit | full
  const setRow = (loc: string | null, moduleKey: string, level: 'none' | 'view' | 'edit' | 'full') =>
    writeGrid(loc, { ...gridOf(loc), [moduleKey]: { view: level !== 'none', edit: level === 'edit' || level === 'full', delete: level === 'full' } })
  // Apply a level to every section in a menu group at once
  const setGroup = (loc: string | null, group: string, level: 'none' | 'view' | 'edit' | 'full') => {
    const g = { ...gridOf(loc) }
    for (const m of PERMISSION_MODULES) if (m.group === group) g[m.key] = { view: level !== 'none', edit: level === 'edit' || level === 'full', delete: level === 'full' }
    writeGrid(loc, g)
  }
  const PERM_GROUPS = [...new Set(PERMISSION_MODULES.map(m => m.group))]
  // Per-location overrides: start a location pre-filled (ticked) from the default grid.
  const addOverride = (loc: string) => setForm(prev => ({ ...prev, location_perms: { ...prev.location_perms, [loc]: JSON.parse(JSON.stringify(prev.permissions)) } }))
  const removeOverride = (loc: string) => setForm(prev => { const lp = { ...prev.location_perms }; delete lp[loc]; return { ...prev, location_perms: lp } })
  const facName = (code: string) => factories.find(f => f.code === code)?.name || code

  // The view/edit/delete grid, reused for the default (loc=null) and each location override.
  const permTable = (loc: string | null) => {
    const grid = gridOf(loc)
    return (
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-gray-600">Section</th>
              <th className="px-3 py-2 font-medium text-gray-600 w-16 text-center">👁 View</th>
              <th className="px-3 py-2 font-medium text-gray-600 w-24 text-center">✏️ Edit<span className="block text-[10px] font-normal text-gray-400">(or request)</span></th>
              <th className="px-3 py-2 font-medium text-gray-600 w-16 text-center">🗑 Delete</th>
              <th className="px-3 py-2 font-medium text-gray-600 w-40 text-center">Quick set</th>
            </tr>
          </thead>
          <tbody>
            {PERM_GROUPS.map(grp => (
              <Fragment key={grp}>
                <tr className="bg-gray-50/70 border-b">
                  <td className="px-3 py-1.5 font-semibold text-gray-700">{grp}</td>
                  <td colSpan={3}></td>
                  <td className="px-3 py-1.5 text-center text-xs space-x-2 whitespace-nowrap">
                    <button type="button" onClick={() => setGroup(loc, grp, 'view')} className="text-blue-600 hover:underline">View all</button>
                    <button type="button" onClick={() => setGroup(loc, grp, 'edit')} className="text-blue-600 hover:underline">Edit all</button>
                    <button type="button" onClick={() => setGroup(loc, grp, 'none')} className="text-gray-400 hover:underline">Off</button>
                  </td>
                </tr>
                {PERMISSION_MODULES.filter(m => m.group === grp).map(m => (
                  <tr key={m.key} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{m.label} {m.needsApproval && <span title="Factory edits here need Head Office approval" className="text-amber-600">⚑</span>}</div>
                      <div className="text-xs text-gray-400">{m.desc}</div>
                    </td>
                    {(['view', 'edit', 'delete'] as Action[]).map(a => (
                      <td key={a} className="px-3 py-2 text-center">
                        <input type="checkbox" className="h-4 w-4" checked={!!grid[m.key]?.[a]}
                          onChange={e => setPerm(loc, m.key, a, e.target.checked)} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-center text-xs space-x-1.5 whitespace-nowrap">
                      <button type="button" onClick={() => setRow(loc, m.key, 'view')} className="text-blue-600 hover:underline">View</button>
                      <button type="button" onClick={() => setRow(loc, m.key, 'edit')} className="text-blue-600 hover:underline">Edit</button>
                      <button type="button" onClick={() => setRow(loc, m.key, 'full')} className="text-blue-600 hover:underline">Full</button>
                      <button type="button" onClick={() => setRow(loc, m.key, 'none')} className="text-gray-400 hover:underline">Off</button>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(''); setSuccess('')
    if (form.factory_codes.length === 0) { setError('Select Head Office or at least one factory.'); setSaving(false); return }
    const isEdit = mode === 'edit'
    const url = isEdit ? '/api/update-user' : '/api/create-user'
    const body = isEdit
      ? { id: editingId, username: form.username || undefined, full_name: form.full_name, factory_code: form.factory_code, factory_codes: form.factory_codes, readonly_factories: form.readonly_factories, warehouse_user: form.warehouse_user, role: form.role, permissions: form.permissions, capabilities: form.capabilities, location_perms: form.location_perms, password: form.password || undefined }
      : { username: form.username, email: form.email || undefined, password: form.password, full_name: form.full_name, factory_code: form.factory_code, factory_codes: form.factory_codes, readonly_factories: form.readonly_factories, warehouse_user: form.warehouse_user, role: form.role, permissions: form.permissions, capabilities: form.capabilities, location_perms: form.location_perms }
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

  const uFacs = (u: UserRow) => (u.factory_codes?.length ? u.factory_codes : [u.factory_code]).filter(Boolean) as string[]
  const uPass = (sel: Set<string> | undefined, v: string) => !sel || !sel.size || sel.has(v)
  const uDist = (get: (u: UserRow) => string) => [...new Set(users.map(get))].filter(Boolean).sort()
  const allFacCodes = [...new Set(users.flatMap(uFacs))].sort()
  const visibleUsers = users.filter(u =>
    uPass(uFilters.name, u.full_name || '—') && uPass(uFilters.email, u.username || '—') && uPass(uFilters.role, u.role) &&
    (!uFilters.factory || !uFilters.factory.size || uFacs(u).some(f => uFilters.factory!.has(f))))

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
            <h2 className="font-semibold text-lg">{mode === 'edit' ? `Edit User — ${form.username || form.email}` : 'Create New User'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Full Name</label>
                <input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Username <span className="text-gray-400 font-normal">(used to log in)</span></label>
                <input type="text" autoCapitalize="none" autoCorrect="off" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" placeholder="e.g. gopi or avina14store" required={mode === 'create'} />
                {mode === 'edit' && <p className="text-xs text-gray-400 mt-1">Changing this changes how they log in.</p>}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Email <span className="text-gray-400 font-normal">(optional — for reference, can be shared)</span></label>
                <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500" disabled={mode === 'edit'} />
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
              {(() => {
                const choices = (hoSelected ? factories : factories.filter(f => form.factory_codes.includes(f.code))).filter(f => f.code !== 'HEAD_OFFICE')
                if (choices.length === 0) return null
                return (
                  <div className="mt-3 border-t pt-3">
                    <p className="text-xs font-medium text-gray-600 mb-1">View-only at <span className="font-normal text-gray-400">— can see records there but not edit / delete / request changes</span></p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {choices.map(f => (
                        <label key={f.code} className="inline-flex items-center gap-2 text-sm">
                          <input type="checkbox" className="h-4 w-4" checked={form.readonly_factories.includes(f.code)}
                            onChange={e => setForm(prev => ({ ...prev, readonly_factories: e.target.checked ? [...prev.readonly_factories, f.code] : prev.readonly_factories.filter(c => c !== f.code) }))} />
                          {f.name}
                        </label>
                      ))}
                    </div>
                    {form.readonly_factories.length > 0 && <p className="text-xs text-amber-600 mt-1">View-only at {form.readonly_factories.length} factory(ies) — the Edit / Delete / Request buttons are hidden for those records.</p>}
                  </div>
                )
              })()}
            </div>

            {/* Warehouse staff: restricted Material Requests view */}
            <label className="flex items-start gap-2 cursor-pointer bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              <input type="checkbox" className="h-4 w-4 mt-0.5" checked={form.warehouse_user}
                onChange={e => setForm({ ...form, warehouse_user: e.target.checked })} />
              <span className="text-sm">
                <span className="font-medium">📦 Warehouse staff</span>
                <span className="block text-gray-500 text-xs">On Material Requests they only see <strong>released pick runs</strong> — they can enter the SO number and record what they pick, but don&apos;t see the factory&apos;s open/draft requests. Give them factory access for the locations they pick for (or Head Office to see all).</span>
              </span>
            </label>

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
                {/* Plain-language legend so it's obvious what each column does */}
                <div className="text-xs text-gray-600 bg-gray-50 border rounded-lg p-3 mb-3 space-y-1">
                  <p>The user only sees their own factory&apos;s data, limited to what&apos;s ticked here.</p>
                  <p>👁 <strong>View</strong> — can open & read the section.</p>
                  <p>✏️ <strong>Edit</strong> — can add/change records. <span className="text-amber-700">For ⚑-marked sections a factory user&apos;s changes are <strong>sent to Head Office for approval</strong> (Head Office&apos;s own edits apply immediately).</span></p>
                  <p>🗑 <strong>Delete</strong> — can remove records (usually leave off).</p>
                  <p className="text-gray-400">Quick set per row: <strong>View</strong> · <strong>Edit</strong> · <strong>Full</strong> (incl. delete) · <strong>Off</strong>.</p>
                </div>
                <p className="text-xs font-medium text-gray-500 mb-1">Default — applies to every location the user can access</p>
                {permTable(null)}

                {/* Per-location overrides */}
                <div className="mt-5">
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-medium">Per-location overrides <span className="text-gray-400 font-normal">(optional)</span></label>
                    <select value="" onChange={e => { if (e.target.value) addOverride(e.target.value) }} className="border rounded px-2 py-1 text-sm bg-white">
                      <option value="">+ Add a location…</option>
                      {factories.filter(f => f.code !== 'HEAD_OFFICE' && !form.location_perms[f.code]).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                    </select>
                  </div>
                  <p className="text-xs text-gray-400 mb-2">A location added here uses its <strong>own</strong> grid instead of the default above. It starts <strong>pre-ticked from the default</strong> — just change what differs.</p>
                  {Object.keys(form.location_perms).length === 0
                    ? <p className="text-xs text-gray-400">No overrides — the default grid applies everywhere.</p>
                    : Object.keys(form.location_perms).sort().map(loc => (
                      <div key={loc} className="border rounded-lg p-3 mb-3 bg-gray-50/40">
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium text-sm">🏭 {facName(loc)}</span>
                          <button type="button" onClick={() => removeOverride(loc)} className="text-red-500 hover:underline text-xs">Remove override</button>
                        </div>
                        {permTable(loc)}
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* Special permissions — individual capabilities on top of the section grid */}
            {form.role !== 'admin' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium">Special permissions</label>
                  <div className="text-xs space-x-3">
                    <button type="button" onClick={() => setForm(p => ({ ...p, capabilities: defaultCaps() }))} className="text-blue-600 hover:underline">Allow all</button>
                    <button type="button" onClick={() => setForm(p => ({ ...p, capabilities: Object.fromEntries(CAPABILITIES.map(c => [c.key, false])) }))} className="text-blue-600 hover:underline">Disallow all</button>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mb-2">Specific actions on top of the grid. A user still needs the section&apos;s Edit (and factory access) — these let you switch the sensitive ones on/off per person.</p>
                <div className="border rounded-lg divide-y">
                  {CAPABILITIES.map(c => (
                    <label key={c.key} className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50">
                      <input type="checkbox" className="h-4 w-4 mt-0.5" checked={form.capabilities[c.key] !== false}
                        onChange={e => setForm(p => ({ ...p, capabilities: { ...p.capabilities, [c.key]: e.target.checked } }))} />
                      <span className="text-sm"><span className="font-medium">{c.label}</span><span className="block text-xs text-gray-400">{c.desc}</span></span>
                    </label>
                  ))}
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

        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[30rem]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>
                {['Name', 'Username', 'Factory / HO', 'Role', 'Access', ''].map((h, i) => (
                  <th key={i} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
              <tr className="border-b">
                <th className="px-3 py-1.5 min-w-[120px]"><MultiFilter values={uDist(u => u.full_name || '—')} selected={uFilters.name || new Set()} onChange={s => setUFilters(p => ({ ...p, name: s }))} /></th>
                <th className="px-3 py-1.5 min-w-[120px]"><MultiFilter values={uDist(u => u.username || '—')} selected={uFilters.email || new Set()} onChange={s => setUFilters(p => ({ ...p, email: s }))} /></th>
                <th className="px-3 py-1.5 min-w-[120px]"><MultiFilter values={allFacCodes} selected={uFilters.factory || new Set()} onChange={s => setUFilters(p => ({ ...p, factory: s }))} /></th>
                <th className="px-3 py-1.5 min-w-[90px]"><MultiFilter values={uDist(u => u.role)} selected={uFilters.role || new Set()} onChange={s => setUFilters(p => ({ ...p, role: s }))} /></th>
                <th className="px-3 py-1.5"></th><th className="px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">No users yet</td></tr>
              )}
              {users.length > 0 && visibleUsers.length === 0 && (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">No users match the filter</td></tr>
              )}
              {visibleUsers.map(u => {
                const al = accessLabel(u)
                return (
                  <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{u.full_name || '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{u.username || <span className="text-gray-400">{u.email}</span>}</td>
                    <td className="px-4 py-3">
                      {(u.factory_codes?.length ? u.factory_codes : [u.factory_code]).filter(Boolean).map(fc => (
                        <span key={fc} className={`mr-1 mb-1 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${fc === 'HEAD_OFFICE' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                          {fc === 'HEAD_OFFICE' ? 'Head Office' : fc}
                        </span>
                      ))}
                    </td>
                    <td className="px-4 py-3 capitalize">{u.role}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${al.cls}`}>{al.text}</span></td>
                    <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                      <button onClick={() => openEdit(u)} className="text-blue-600 hover:underline text-sm font-medium">Edit</button>
                      <button onClick={() => openCopy(u)} className="text-gray-600 hover:underline text-sm font-medium" title="Create a new user with the same access">Copy</button>
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
