'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, type ModuleKey } from '@/lib/permissions'

export type Field = {
  key: string
  label: string
  type?: 'text' | 'number' | 'date' | 'time' | 'select' | 'item'
  options?: string[]
  list?: boolean   // show as a column in the list table
  wide?: boolean   // span full width in the form
}

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const fmtDate = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || '—') }

export default function ProcessLog({ table, title, subtitle, moduleKey, fields }: {
  table: string; title: string; subtitle?: string; moduleKey: ModuleKey; fields: Field[]
}) {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, moduleKey)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [factory, setFactory] = useState('')
  const [editing, setEditing] = useState<Record<string, unknown> | 'new' | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [items, setItems] = useState<{ code: string; description: string | null }[]>([])
  const hasItemField = fields.some(f => f.type === 'item')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, moduleKey, 'edit')
  const myFactoryOptions = isHO ? factories.map(f => f.code)
    : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : []))
  const listFields = fields.filter(f => f.list)

  useEffect(() => { if (profile) { loadFactories(); load() } }, [profile])
  useEffect(() => { if (profile && hasItemField && items.length === 0) fetchAll<{ code: string; description: string | null }>('items', 'code, description', 'code').then(setItems) }, [profile])
  async function loadFactories() { const { data } = await supabase.from('factories').select('code, name').order('code'); setFactories(data || []) }
  async function load() { const { data } = await supabase.from(table).select('*').order('created_at', { ascending: false }); setRows((data as Record<string, unknown>[]) || []) }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c

  function openNew() {
    setEditing('new'); setError(''); setFactory(myFactoryOptions[0] || '')
    const f: Record<string, string> = {}; fields.forEach(fl => f[fl.key] = fl.type === 'date' ? todayLocal() : ''); setForm(f)
  }
  function openEdit(r: Record<string, unknown>) {
    setEditing(r); setError(''); setFactory((r.factory_code as string) || '')
    const f: Record<string, string> = {}; fields.forEach(fl => f[fl.key] = r[fl.key] == null ? '' : String(r[fl.key])); setForm(f)
  }
  function close() { setEditing(null) }

  async function save() {
    setSaving(true); setError('')
    if (!factory) { setError('Pick a factory.'); setSaving(false); return }
    const payload: Record<string, unknown> = { factory_code: factory }
    fields.forEach(fl => { const v = form[fl.key]; payload[fl.key] = fl.type === 'number' ? (v === '' ? null : Number(v)) : (v === '' ? null : v) })
    let err
    if (editing === 'new') {
      const { data: sess } = await supabase.auth.getSession()
      payload.created_by = sess.session?.user.id || null
      err = (await supabase.from(table).insert(payload)).error
    } else {
      err = (await supabase.from(table).update(payload).eq('id', (editing as Record<string, unknown>).id as string)).error
    }
    setSaving(false)
    if (err) { setError(err.message); return }
    close(); load()
  }

  const cell = (r: Record<string, unknown>, fl: Field) => {
    const v = r[fl.key]
    if (v == null || v === '') return '—'
    return fl.type === 'date' ? fmtDate(String(v)) : String(v)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          {canEdit && <button onClick={() => (editing ? close() : openNew())} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">{editing ? 'Cancel' : '+ New record'}</button>}
        </div>
        {subtitle && <p className="text-gray-500 text-sm mb-5">{subtitle}</p>}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{[...(isHO ? ['Factory'] : []), ...listFields.map(f => f.label), ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={listFields.length + 2} className="text-center py-8 text-gray-400">No records yet.</td></tr>}
              {rows.map(r => (
                <tr key={r.id as string} className="border-b last:border-0 hover:bg-gray-50">
                  {isHO && <td className="px-3 py-2 whitespace-nowrap">{factoryName(r.factory_code as string)}</td>}
                  {listFields.map(fl => <td key={fl.key} className="px-3 py-2 whitespace-nowrap">{cell(r, fl)}</td>)}
                  <td className="px-3 py-2 text-right"><button onClick={() => openEdit(r)} className="text-blue-600 hover:underline">{canEdit ? 'Open' : 'View'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={close}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-3xl my-8 p-6" onClick={e => e.stopPropagation()}>
            {hasItemField && <datalist id="process-items">{items.map(it => <option key={it.code} value={`${it.code}${it.description ? ' — ' + it.description : ''}`} />)}</datalist>}
            <h2 className="font-semibold text-lg mb-4">{editing === 'new' ? `New — ${title}` : title}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {editing === 'new' && myFactoryOptions.length > 1 && (
                <div><label className="block text-sm font-medium mb-1">Factory</label>
                  <select value={factory} onChange={e => setFactory(e.target.value)} className="w-full border rounded-lg px-3 py-2">{myFactoryOptions.map(c => <option key={c} value={c}>{factoryName(c)}</option>)}</select></div>
              )}
              {fields.map(fl => (
                <div key={fl.key} className={fl.wide ? 'sm:col-span-3' : ''}>
                  <label className="block text-sm font-medium mb-1">{fl.label}</label>
                  {fl.type === 'select' ? (
                    <select value={form[fl.key] || ''} onChange={e => setForm({ ...form, [fl.key]: e.target.value })} disabled={!canEdit} className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100">
                      <option value="">—</option>{(fl.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : fl.type === 'item' ? (
                    <input list="process-items" value={form[fl.key] || ''} onChange={e => setForm({ ...form, [fl.key]: e.target.value })} disabled={!canEdit}
                      placeholder="Search code or name…" className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
                  ) : (
                    <input type={fl.type === 'number' ? 'number' : fl.type === 'date' ? 'date' : fl.type === 'time' ? 'time' : 'text'}
                      value={form[fl.key] || ''} onChange={e => setForm({ ...form, [fl.key]: e.target.value })} disabled={!canEdit}
                      className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
                  )}
                </div>
              ))}
            </div>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mt-3">{error}</p>}
            <div className="flex gap-2 mt-4">
              {canEdit && <button onClick={save} disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{saving ? 'Saving…' : 'Save'}</button>}
              <button onClick={close} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
