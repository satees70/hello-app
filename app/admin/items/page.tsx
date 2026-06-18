'use client'
import { useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'

interface Item { id: string; code: string; description: string; unit: string; type: string; stock_group: string; supplied_by_factory: boolean; kg_per_bag: number | null }
const EMPTY = { code: '', description: '', unit: '', type: 'Material', stock_group: '', supplied_by_factory: false, kg_per_bag: '' }

export default function ItemsPage() {
  const { profile, loading } = useProfile()
  useRequireView(profile, 'items')
  const [items, setItems] = useState<Item[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Item | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [needBom, setNeedBom] = useState(false)
  const [bomParents, setBomParents] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const [existingMode, setExistingMode] = useState<'update' | 'skip'>('update')
  const bulkRef = useRef<HTMLInputElement>(null)

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { loadItems(); loadBomParents() } }, [profile])

  async function loadItems() {
    setItems(await fetchAll<Item>('items', '*', 'code'))
  }

  async function loadBomParents() {
    const rows = await fetchAll<{ parent_item_id: string }>('bom_components', 'parent_item_id')
    setBomParents(new Set(rows.map(r => r.parent_item_id)))
  }

  function openCreate() { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true) }
  function openEdit(item: Item) { setEditing(item); setForm({ code: item.code, description: item.description, unit: item.unit, type: item.type, stock_group: item.stock_group || '', supplied_by_factory: item.supplied_by_factory || false, kg_per_bag: item.kg_per_bag != null ? String(item.kg_per_bag) : '' }); setError(''); setShowForm(true) }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const payload = { ...form, kg_per_bag: form.kg_per_bag === '' ? null : Number(form.kg_per_bag) }
    if (editing) {
      const { error } = await supabase.from('items').update(payload).eq('id', editing.id)
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('items').insert(payload)
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
    const csv = 'code,description,unit,type,stock_group\nABC123,EXAMPLE ITEM 1KG,KG,Material,Spices\nXYZ789,EXAMPLE MANUFACTURED ITEM,PACK,Manufactured,Salt\n'
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
            stock_group: pick(r, 'stock_group', 'stock group', 'group'),
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

        const skip = existingMode === 'skip'
        let processed = 0; let firstErr = ''
        for (let i = 0; i < deduped.length; i += 500) {
          const chunk = deduped.slice(i, i + 500)
          const { data: ret, error: upErr } = await supabase.from('items').upsert(chunk, { onConflict: 'code', ignoreDuplicates: skip }).select('code')
          if (upErr) { if (!firstErr) firstErr = upErr.message } else processed += (ret?.length || 0)
        }
        setBulkBusy(false)
        if (bulkRef.current) bulkRef.current.value = ''
        if (firstErr) { setBulkMsg(`Error during import: ${firstErr}${dupNote}`); loadItems(); return }
        if (skip) setBulkMsg(`Added ${processed} new item(s); skipped ${deduped.length - processed} that already existed.${dupNote}`)
        else setBulkMsg(`Imported ${processed} item(s) — new added, existing updated.${dupNote}`)
        loadItems()
      },
      error: (err) => { setBulkMsg(`Could not read file: ${err.message}`); setBulkBusy(false) },
    })
  }

  const missingBom = (i: Item) => i.type === 'Manufactured' && !bomParents.has(i.id)
  const missingBomCount = items.filter(missingBom).length
  const filtered = items.filter(i =>
    (i.code.toLowerCase().includes(search.toLowerCase()) ||
      i.description.toLowerCase().includes(search.toLowerCase())) &&
    (!groupFilter || i.stock_group === groupFilter) &&
    (!needBom || missingBom(i))
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
              Add or update many items at once. Columns: <span className="font-mono text-xs">code, description, unit, type, stock_group</span> (type = Material or Manufactured).
              Existing item codes are updated; new ones are added.
            </p>
            <div className="flex items-center gap-2 mb-3 text-sm">
              <span className="text-gray-600">If an item code already exists:</span>
              <select value={existingMode} onChange={e => setExistingMode(e.target.value as 'update' | 'skip')} disabled={bulkBusy}
                className="border rounded-lg px-2 py-1 bg-white">
                <option value="update">Update it (fix the data)</option>
                <option value="skip">Skip it (keep existing)</option>
              </select>
            </div>
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
              <div>
                <label className="block text-sm font-medium mb-1">Stock Group</label>
                <input value={form.stock_group} onChange={e => setForm({ ...form, stock_group: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" placeholder="e.g. Spices, Salt, Packaging" />
              </div>
              <div className="sm:col-span-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.supplied_by_factory} onChange={e => setForm({ ...form, supplied_by_factory: e.target.checked })} className="h-4 w-4" />
                  <span className="text-sm font-medium">Made at the factory</span>
                  <span className="text-sm text-gray-400">— supplied by the factory, not picked from the warehouse (e.g. printed labels)</span>
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">KG per bag / carton <span className="text-gray-400 font-normal">(optional)</span></label>
                <input type="number" step="any" min="0" value={form.kg_per_bag} onChange={e => setForm({ ...form, kg_per_bag: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" placeholder="e.g. 3 — only if the code doesn't show it" />
                <p className="text-xs text-gray-400 mt-1">Used to convert a Delivery Order's BAG/CTN quantities into KG. Normally read from the code (e.g. 3KG/BAG, 8KG/CTN); set this only for exceptions.</p>
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

        <div className="mb-4 flex flex-wrap gap-2 items-center">
          <input placeholder="Search by code or description..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm bg-white" />
          <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
            <option value="">All stock groups</option>
            {[...new Set(items.map(i => i.stock_group).filter(Boolean))].sort().map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm cursor-pointer ml-1">
            <input type="checkbox" checked={needBom} onChange={e => setNeedBom(e.target.checked)} className="h-4 w-4" />
            <span className="text-gray-700">Manufactured without BOM ({missingBomCount})</span>
          </label>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {['Code', 'Description', 'Unit', 'Stock Group', 'Type', 'Source', ...(isHO ? ['Actions'] : [])].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-gray-400">No items found</td></tr>
              )}
              {filtered.map(item => (
                <tr key={item.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono font-medium">{item.code}</td>
                  <td className="px-4 py-3">{item.description}</td>
                  <td className="px-4 py-3 text-gray-600">{item.unit || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{item.stock_group || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${item.type === 'Material' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                      {item.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {item.supplied_by_factory
                      ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">🏭 Factory</span>
                      : <span className="text-gray-400 text-xs">📦 Warehouse</span>}
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
