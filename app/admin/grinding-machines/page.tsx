'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface Machine {
  id: string
  name: string
  factory_code: string | null
  model: string | null
  serial_no: string | null
  location: string | null
  commissioned_on: string | null
  notes: string | null
  active: boolean
}

export default function GrindingMachinesPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'grinding')
  const [machines, setMachines] = useState<Machine[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [form, setForm] = useState({ name: '', factory: '', model: '', serial_no: '', location: '', commissioned_on: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'grinding', 'edit')
  const canDelete = can(profile, 'grinding', 'delete')

  useEffect(() => { if (profile) load() }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    if (!isHO && profile) setForm(s => ({ ...s, factory: s.factory || profile.factory_code }))
    const { data } = await supabase.from('grinding_machines')
      .select('id, name, factory_code, model, serial_no, location, commissioned_on, notes, active')
      .order('factory_code', { nullsFirst: true }).order('name')
    setMachines((data as Machine[]) || [])
  }

  const factoryName = (c: string | null) => factories.find(x => x.code === c)?.name || c || '—'

  async function addMachine(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true); setError(''); setSuccess('')
    const { error: e1 } = await supabase.from('grinding_machines').insert({
      name: form.name.trim(),
      factory_code: form.factory || null,
      model: form.model.trim() || null,
      serial_no: form.serial_no.trim() || null,
      location: form.location.trim() || null,
      commissioned_on: form.commissioned_on || null,
      notes: form.notes.trim() || null,
    })
    setSaving(false)
    if (e1) { setError(e1.message.includes('duplicate') ? 'A machine with that ID already exists.' : e1.message); return }
    setForm(s => ({ name: '', factory: isHO ? '' : s.factory, model: '', serial_no: '', location: '', commissioned_on: '', notes: '' }))
    setSuccess('Machine added.'); load()
  }

  async function saveField(m: Machine, patch: Partial<Machine>) {
    setMachines(prev => prev.map(x => x.id === m.id ? { ...x, ...patch } : x))
    const { error: e1 } = await supabase.from('grinding_machines').update(patch).eq('id', m.id)
    if (e1) { setError(e1.message); load() }
  }

  async function toggleActive(m: Machine) {
    await saveField(m, { active: !m.active })
  }

  async function remove(m: Machine) {
    if (!confirm(`Delete machine "${m.name}"? This can't be undone.`)) return
    const { error: e1 } = await supabase.from('grinding_machines').delete().eq('id', m.id)
    if (e1) { setError(e1.message); return }
    setMachines(prev => prev.filter(x => x.id !== m.id))
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center text-red-500">{profileError}</div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Grinding Machines</h1>
        <p className="text-gray-500 text-sm mb-5">Register each grinding machine, assign it to a factory, and record its details. These IDs appear in the Grinding record&apos;s machine picker, and the details will feed the machine-maintenance module.</p>

        {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
        {success && <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">{success}</div>}

        {/* Add form */}
        {canEdit && (
          <form onSubmit={addMachine} className="bg-white rounded-xl shadow-sm border p-4 mb-6">
            <h2 className="font-medium mb-3">Add a machine</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <label className="text-xs text-gray-600">Machine ID / No.*
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. GMC 3" className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-600">Factory
                <select value={form.factory} onChange={e => setForm({ ...form, factory: e.target.value })}
                  className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm">
                  <option value="">— unassigned —</option>
                  {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-600">Model
                <input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}
                  placeholder="e.g. XYZ-200" className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-600">Serial no.
                <input value={form.serial_no} onChange={e => setForm({ ...form, serial_no: e.target.value })}
                  className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-600">Location / line
                <input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })}
                  placeholder="e.g. Grinding room A" className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-600">Commissioned on
                <input type="date" value={form.commissioned_on} onChange={e => setForm({ ...form, commissioned_on: e.target.value })}
                  className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs text-gray-600 sm:col-span-2 lg:col-span-3">Notes
                <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="Anything useful for maintenance later…" className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1.5 text-sm" />
              </label>
            </div>
            <button type="submit" disabled={saving} className="mt-3 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? 'Adding…' : 'Add machine'}
            </button>
          </form>
        )}

        {/* List */}
        <div className="bg-white rounded-xl shadow-sm border overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Machine ID', 'Factory', 'Model', 'Serial no.', 'Location', 'Commissioned', 'Notes', 'Active', ''].map(h =>
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {machines.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-400">No machines yet.</td></tr>}
              {machines.map(m => (
                <tr key={m.id} className={`border-b last:border-0 ${m.active ? '' : 'bg-gray-50 text-gray-400'}`}>
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{m.name}</td>
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <select value={m.factory_code ?? ''} onChange={e => saveField(m, { factory_code: e.target.value || null })}
                        className="rounded border border-gray-200 px-2 py-1 text-xs">
                        <option value="">— unassigned —</option>
                        {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                      </select>
                    ) : factoryName(m.factory_code)}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit ? <input defaultValue={m.model ?? ''} onBlur={e => { if (e.target.value.trim() !== (m.model ?? '')) saveField(m, { model: e.target.value.trim() || null }) }}
                      className="w-28 rounded border border-gray-200 px-2 py-1 text-xs" /> : (m.model || '—')}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit ? <input defaultValue={m.serial_no ?? ''} onBlur={e => { if (e.target.value.trim() !== (m.serial_no ?? '')) saveField(m, { serial_no: e.target.value.trim() || null }) }}
                      className="w-28 rounded border border-gray-200 px-2 py-1 text-xs" /> : (m.serial_no || '—')}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit ? <input defaultValue={m.location ?? ''} onBlur={e => { if (e.target.value.trim() !== (m.location ?? '')) saveField(m, { location: e.target.value.trim() || null }) }}
                      className="w-32 rounded border border-gray-200 px-2 py-1 text-xs" /> : (m.location || '—')}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {canEdit ? <input type="date" defaultValue={m.commissioned_on ?? ''} onBlur={e => { if ((e.target.value || null) !== (m.commissioned_on ?? null)) saveField(m, { commissioned_on: e.target.value || null }) }}
                      className="rounded border border-gray-200 px-2 py-1 text-xs" /> : (m.commissioned_on || '—')}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit ? <input defaultValue={m.notes ?? ''} onBlur={e => { if (e.target.value.trim() !== (m.notes ?? '')) saveField(m, { notes: e.target.value.trim() || null }) }}
                      className="w-40 rounded border border-gray-200 px-2 py-1 text-xs" /> : (m.notes || '—')}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={m.active} disabled={!canEdit} onChange={() => toggleActive(m)} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {canDelete && <button onClick={() => remove(m)} className="text-xs text-red-600 hover:underline">delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
