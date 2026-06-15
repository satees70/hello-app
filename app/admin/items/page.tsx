'use client'
import { useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Item { id: string; code: string; description: string; unit: string; type: string }
const EMPTY = { code: '', description: '', unit: '', type: 'Material' }

export default function ItemsPage() {
  const { profile, loading } = useProfile()
  const [items, setItems] = useState<Item[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Item | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const bulkRef = useRef<HTMLInputElement>(null)

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) loadItems() }, [profile])

  async function loadItems() {
    const { data } = await supabase.from('items').select('*').order('code')
    setItems(data || [])
  }

  function openCreate() { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true) }
  function openEdit(item: Item) { setEditing(item); setForm({ code: item.code, description: item.description, unit: item.unit, type: item.type }); setError(''); setShowForm(true) }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    if (editing) {
      const { error } = await supabase.from('items').update(form).eq('id', editing.id)
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('items').insert(form)
      if (error) { setError(error.message); setSaving(false); return }
    }
    setShowForm(false); setSaving(false); loadItems()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this item?')) return
    await supabase.from('items').delete().eq('id', id)
    loadItems()
  }

  function downloadTemplate() {
    const csv = 'code,description,unit,type\nABC123,EXAMPLE ITEM 1KG,KG,Material\nXYZ789,EXAMPLE MANUFACTURED ITEM,PACK,Manufactured\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'items-template.csv'; a.click(); URL.revokeObjectURL(url)
  }

  function handleBulkUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBulkBusy(true); setBulkMsg(''); setError('')
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: true,
      complete: async (res) => {
        const pick = (r: Record<string, string>, ...keys: string[]) => {
          for (const k of Object.keys(r)) { if (keys.includes(k.trim().toLowerCase())) return (r[k] || '').trim() }
          return ''
        }
        const rows = res.data
          .map(r => ({
            code: pick(r, 'code', 'item code', 'item_code'),
            description: pick(r, 'description', 'desc'),
            unit: pick(r, 'unit', 'uom'),
            type: /man/i.test(pick(r, 'type')) ? 'Manufactured' : 'Material',
          }))
          .filter(r => r.code)
        if (rows.length === 0) { setBulkMsg('No rows with an item code were found. Check the column headers.'); setBulkBusy(false); if (bulkRef.current) bulkRef.current.value = ''; return }

        // Detect & merge duplicate codes within the file (keep the last entry)
        const seen = new Map<string, typeof rows[number]>()
        const dups = new Set<string>()
        rows.forEach(r => { if (seen.has(r.code)) dups.add(r.code); seen.set(r.code, r) })
        const deduped = [...seen.values()]
        const dupNote = dups.size > 0
          ? ` ⚠ ${dups.size} duplicate code(s) in your file were merged (kept the last row each): ${[...dups].slice(0, 8).join(', ')}${dups.size > 8 ? '…' : ''}.`
          : ''

        let ok = 0; let firstErr = ''
        for (let i = 0; i < deduped.length; i += 500) {
          const chunk = deduped.slice(i, i + 500)
          const { error: upErr } = await supabase.from('items').upsert(chunk, { onConflict: 'code' })
          if (upErr) { if (!firstErr) firstErr = upErr.message } else ok += chunk.length
        }
        setBulkBusy(false)
        if (bulkRef.current) bulkRef.current.value = ''
        if (firstErr) setBulkMsg(`Imported ${ok} of ${deduped.length}. Some failed: ${firstErr}${dupNote}`)
        else setBulkMsg(`Imported ${ok} item(s) (existing codes were updated).${dupNote}`)
        loadItems()
      },
      error: (err) => { setBulkMsg(`Could not read file: ${err.message}`); setBulkBusy(false) },
    })
  }

  const filtered = items.filter(i =>
    i.code.toLowerCase().includes(search.toLowerCase()) ||
    i.description.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Items Master</h1>
          {isHO && (
            <button onClick={openCreate}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
              + Add Item
            </button>
          )}
        </div>

        {isHO && (
          <div className="bg-white rounded-xl shadow-sm border p-5 mb-6">
            <h2 className="font-semibold mb-1">Bulk upload from CSV</h2>
            <p className="text-gray-500 text-sm mb-3">
              Add or update many items at once. Columns: <span className="font-mono text-xs">code, description, unit, type</span> (type = Material or Manufactured).
              Existing item codes are updated; new ones are added.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={downloadTemplate} className="border px-4 py-2 rounded-lg hover:bg-gray-50 text-sm">Download template</button>
              <input ref={bulkRef} type="file" accept=".csv,text/csv" disabled={bulkBusy} onChange={handleBulkUpload}
                className="block text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium hover:file:bg-blue-100" />
              {bulkBusy && <span className="text-blue-600 text-sm">Importing…</span>}
            </div>
            {bulkMsg && <p className="text-sm mt-3 bg-gray-50 border rounded p-2">{bulkMsg}</p>}
          </div>
        )}

        {showForm && isHO && (
          <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{editing ? 'Edit Item' : 'New Item'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Item Code</label>
                <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" required disabled={!!editing} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Unit</label>
                <input value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2">
                  <option value="Material">Material</option>
                  <option value="Manufactured">Manufactured</option>
                </select>
              </div>
            </div>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded">{error}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={saving}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </form>
        )}

        <div className="mb-4">
          <input placeholder="Search by code or description..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm bg-white" />
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {['Code', 'Description', 'Unit', 'Type', ...(isHO ? ['Actions'] : [])].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="text-center py-8 text-gray-400">No items found</td></tr>
              )}
              {filtered.map(item => (
                <tr key={item.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono font-medium">{item.code}</td>
                  <td className="px-4 py-3">{item.description}</td>
                  <td className="px-4 py-3 text-gray-600">{item.unit || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${item.type === 'Material' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                      {item.type}
                    </span>
                  </td>
                  {isHO && (
                    <td className="px-4 py-3 flex gap-2">
                      <button onClick={() => openEdit(item)} className="text-blue-600 hover:underline text-xs">Edit</button>
                      <button onClick={() => handleDelete(item.id)} className="text-red-500 hover:underline text-xs">Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
