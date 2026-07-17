'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

interface Supplier { id: string; name: string; code: string; active: boolean; notes: string | null }
const EMPTY = { name: '', code: '', notes: '', active: true }

export default function WmsSuppliersPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [rows, setRows] = useState<Supplier[]>([])
  const [q, setQ] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() { setRows(await fetchAll<Supplier>('wms_suppliers', '*', 'name')) }

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return rows.filter(r => !n || r.name.toLowerCase().includes(n) || r.code.toLowerCase().includes(n))
  }, [rows, q])

  function openCreate() { setEditing(null); setForm(EMPTY); setErr(''); setShowForm(true) }
  function openEdit(r: Supplier) { setEditing(r); setForm({ name: r.name, code: r.code, notes: r.notes || '', active: r.active }); setErr(''); setShowForm(true) }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    const name = form.name.trim(); const code = form.code.trim().toUpperCase()
    if (!name) { setErr('Enter the supplier name.'); return }
    if (!code) { setErr('Enter a short code (used on the batch number).'); return }
    setBusy(true); setErr('')
    const payload = { name, code, notes: form.notes.trim() || null, active: form.active }
    const res = editing
      ? await supabase.from('wms_suppliers').update(payload).eq('id', editing.id)
      : await supabase.from('wms_suppliers').insert(payload)
    setBusy(false)
    if (res.error) { setErr(/duplicate|unique/i.test(res.error.message) ? `Code "${code}" is already used by another supplier.` : res.error.message); return }
    setShowForm(false); load()
  }

  async function toggleActive(r: Supplier) { if (!canEdit) return; await supabase.from('wms_suppliers').update({ active: !r.active }).eq('id', r.id); load() }
  async function remove(r: Supplier) {
    if (!canEdit || !confirm(`Delete supplier "${r.name}"?`)) return
    const { error } = await supabase.from('wms_suppliers').delete().eq('id', r.id)
    if (error) { alert(error.message); return }
    load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Suppliers</h1>
            <p className="text-gray-500 text-sm mt-1">Give each supplier a short code. When you receive goods, the batch number uses today’s date + this code (e.g. <span className="font-mono">260714ABC</span>) so the same item from different suppliers stays separate.</p>
          </div>
          {canEdit && <button onClick={openCreate} className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 text-sm font-medium">+ Add supplier</button>}
        </div>

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or code…" className="border rounded-lg px-3 py-2 text-sm w-full mb-4" />

        {showForm && (
          <form onSubmit={save} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{editing ? 'Edit supplier' : 'New supplier'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2"><label className="block text-sm font-medium mb-1">Supplier name</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full border rounded-lg px-3 py-2" required /></div>
              <div><label className="block text-sm font-medium mb-1">Batch code</label><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} className="w-full border rounded-lg px-3 py-2 font-mono" placeholder="ABC" maxLength={6} required /></div>
            </div>
            <div><label className="block text-sm font-medium mb-1">Notes <span className="text-gray-400 font-normal">(optional)</span></label><input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Active</label>
            {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{err}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={busy} className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" onClick={() => setShowForm(false)} className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </form>
        )}

        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Supplier', 'Batch code', 'Status', 'Actions'].map(h => <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>)}</tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={4} className="text-center py-10 text-gray-400">No suppliers yet — add one so its code can tag batches.</td></tr>}
              {filtered.map(r => (
                <tr key={r.id} className={`border-b last:border-0 hover:bg-gray-50 ${r.active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2.5">{r.name}{r.notes ? <span className="text-gray-400 text-xs"> · {r.notes}</span> : ''}</td>
                  <td className="px-4 py-2.5"><span className="font-mono font-medium bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">{r.code}</span></td>
                  <td className="px-4 py-2.5">{r.active ? <span className="text-emerald-700 text-xs">Active</span> : <span className="text-gray-400 text-xs">Inactive</span>}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {canEdit ? <div className="flex gap-3 text-xs">
                      <button onClick={() => openEdit(r)} className="text-emerald-700 hover:underline">Edit</button>
                      <button onClick={() => toggleActive(r)} className="text-gray-500 hover:underline">{r.active ? 'Deactivate' : 'Activate'}</button>
                      <button onClick={() => remove(r)} className="text-red-500 hover:underline">Delete</button>
                    </div> : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per supplier */}
        <div className="sm:hidden space-y-2">
          {filtered.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No suppliers yet — add one so its code can tag batches.</div>}
          {filtered.map(r => (
            <div key={r.id} className={`bg-white rounded-xl border shadow-sm p-3 ${r.active ? '' : 'opacity-50'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm">{r.name}</div>
                  {r.notes && <div className="text-xs text-gray-500 leading-snug">{r.notes}</div>}
                </div>
                <span className="font-mono font-medium bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded shrink-0">{r.code}</span>
              </div>
              <div className="mt-1.5 text-xs">{r.active ? <span className="text-emerald-700">Active</span> : <span className="text-gray-400">Inactive</span>}</div>
              {canEdit && (
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5 pt-2 border-t text-xs">
                  <button onClick={() => openEdit(r)} className="text-emerald-700 hover:underline font-medium">Edit</button>
                  <button onClick={() => toggleActive(r)} className="text-gray-500 hover:underline font-medium">{r.active ? 'Deactivate' : 'Activate'}</button>
                  <button onClick={() => remove(r)} className="text-red-500 hover:underline font-medium">Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
