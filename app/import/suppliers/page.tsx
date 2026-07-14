'use client'
import { useEffect, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import type { ImportSupplier } from '@/lib/import'

const EMPTY = { name: '', country: '', contact_person: '', email: '', phone: '', notes: '', active: true }

export default function ImportSuppliersPage() {
  const { profile, loading, error: profileError } = useProfile()
  const canEdit = can(profile, 'import', 'edit')
  const canDelete = can(profile, 'import', 'delete')

  const [suppliers, setSuppliers] = useState<ImportSupplier[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ImportSupplier | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showInactive, setShowInactive] = useState(false)

  useEffect(() => { if (profile) load() }, [profile])
  async function load() { setSuppliers(await fetchAll<ImportSupplier>('import_suppliers', '*', 'name')) }

  function openCreate() { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true) }
  function openEdit(s: ImportSupplier) {
    setEditing(s)
    setForm({ name: s.name, country: s.country || '', contact_person: s.contact_person || '', email: s.email || '', phone: s.phone || '', notes: s.notes || '', active: s.active })
    setError(''); setShowForm(true)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!form.name.trim()) { setError('Enter a supplier name.'); return }
    setSaving(true); setError('')
    const payload = {
      name: form.name.trim(), country: form.country.trim() || null,
      contact_person: form.contact_person.trim() || null, email: form.email.trim() || null,
      phone: form.phone.trim() || null, notes: form.notes.trim() || null, active: form.active,
    }
    const { error: err } = editing
      ? await supabase.from('import_suppliers').update(payload).eq('id', editing.id)
      : await supabase.from('import_suppliers').insert({ ...payload, created_by: profile.id })
    setSaving(false)
    if (err) { setError(err.message.includes('import_suppliers_name_key') ? 'A supplier with that name already exists.' : err.message); return }
    setShowForm(false); load()
  }

  async function remove(s: ImportSupplier) {
    if (!confirm(`Delete supplier "${s.name}"? If it's used on any shipment, use "Active: no" instead.`)) return
    const { error: err } = await supabase.from('import_suppliers').delete().eq('id', s.id)
    if (err) { alert(err.message.includes('foreign key') ? 'This supplier is used on a shipment — set it to inactive instead of deleting.' : err.message); return }
    load()
  }

  if (loading && !profileError) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (profileError) return <div className="p-8 text-sm text-red-600">{profileError}</div>
  if (!profile) return null

  const list = suppliers.filter(s => showInactive || s.active)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h1 className="text-2xl font-bold">Import suppliers</h1>
          {canEdit && <button onClick={openCreate} className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 text-sm font-medium">+ New supplier</button>}
        </div>
        <p className="text-gray-500 text-sm mb-5">The fixed list of overseas suppliers you can pick from when creating a shipment.</p>

        <label className="inline-flex items-center gap-1.5 text-sm mb-4"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="h-4 w-4" /> Show inactive</label>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Name', 'Country', 'Contact', 'Email', 'Phone', ''].map(h => <th key={h} className="text-left px-4 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-gray-400">No suppliers yet.</td></tr>}
              {list.map(s => (
                <tr key={s.id} className={`border-b last:border-0 hover:bg-gray-50 ${!s.active ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-2 font-medium whitespace-nowrap">{s.name}{!s.active && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 align-middle">inactive</span>}</td>
                  <td className="px-4 py-2 text-gray-600">{s.country || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{s.contact_person || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{s.email || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{s.phone || '—'}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {canEdit && <button onClick={() => openEdit(s)} className="text-emerald-600 hover:underline text-xs mr-3">Edit</button>}
                    {canDelete && <button onClick={() => remove(s)} className="text-red-500 hover:underline text-xs">Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={() => setShowForm(false)}>
          <form onClick={e => e.stopPropagation()} onSubmit={save} className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold mb-4">{editing ? 'Edit supplier' : 'New supplier'}</h2>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
            <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Name *</span>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" autoFocus /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Country</span>
                <input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
              <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Contact person</span>
                <input value={form.contact_person} onChange={e => setForm(f => ({ ...f, contact_person: e.target.value }))} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
              <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Email</span>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
              <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Phone</span>
                <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
            </div>
            <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Notes</span>
              <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
            <label className="inline-flex items-center gap-2 text-sm mb-4"><input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="h-4 w-4" /> Active (available to pick on new shipments)</label>
            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={() => setShowForm(false)} className="text-gray-500 hover:underline text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
