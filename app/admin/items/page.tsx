'use client'
import { useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface Item { id: string; code: string; description: string; unit: string; type: string; stock_group: string; supplied_by_factory: boolean; kg_per_bag: number | null; pcs_per_roll: number | null }
const EMPTY = { code: '', description: '', unit: '', type: 'Material', stock_group: '', supplied_by_factory: false, kg_per_bag: '', pcs_per_roll: '' }
// Fields that can be edited (the Code is locked — it's referenced across documents)
const ITEM_FIELDS = [
  { key: 'description', label: 'Description' },
  { key: 'unit', label: 'Unit' },
  { key: 'type', label: 'Type' },
  { key: 'stock_group', label: 'Stock Group' },
  { key: 'supplied_by_factory', label: 'Made at factory' },
  { key: 'kg_per_bag', label: 'KG per bag/carton' },
  { key: 'pcs_per_roll', label: 'Pieces per roll' },
] as const
// String form of an item's value, for comparing/recording changes
const itemStr = (it: Item, k: string): string => {
  const v = (it as unknown as Record<string, unknown>)[k]
  if (k === 'supplied_by_factory') return v ? 'true' : 'false'
  return v == null ? '' : String(v)
}

export default function ItemsPage() {
  const { profile, loading } = useProfile()
  useRequireView(profile, 'items')
  const canEdit = can(profile, 'items', 'edit')
  const canDelete = can(profile, 'items', 'delete')
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
  const [success, setSuccess] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkField, setBulkField] = useState('stock_group')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkEditBusy, setBulkEditBusy] = useState(false)
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(new Set())

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const toggleSel = (id: string) => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  useEffect(() => { if (profile) { loadItems(); loadBomParents() } }, [profile])

  async function loadItems() {
    setItems(await fetchAll<Item>('items', '*', 'code'))
    const { data: pend } = await supabase.from('item_change_requests').select('item_id').eq('status', 'Pending')
    setPendingItemIds(new Set((pend || []).map(r => r.item_id).filter(Boolean)))
  }

  async function loadBomParents() {
    const rows = await fetchAll<{ parent_item_id: string }>('bom_components', 'parent_item_id')
    setBomParents(new Set(rows.map(r => r.parent_item_id)))
  }

  function openCreate() { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true) }
  function openEdit(item: Item) { setEditing(item); setForm({ code: item.code, description: item.description, unit: item.unit, type: item.type, stock_group: item.stock_group || '', supplied_by_factory: item.supplied_by_factory || false, kg_per_bag: item.kg_per_bag != null ? String(item.kg_per_bag) : '', pcs_per_roll: item.pcs_per_roll != null ? String(item.pcs_per_roll) : '' }); setError(''); setShowForm(true) }

  // Turn a form field into the string we store on a change request
  const formStr = (k: string): string => {
    const v = (form as unknown as Record<string, unknown>)[k]
    if (k === 'supplied_by_factory') return v ? 'true' : 'false'
    return v == null ? '' : String(v)
  }

  // Insert one change request per (item, field). Returns true on success.
  async function submitItemRequests(rows: { item: Item; field: string; value: string }[], reason: string): Promise<boolean> {
    if (!profile) return false
    const payload = rows.map(r => ({
      item_id: r.item.id, item_code: r.item.code, field: r.field,
      old_value: itemStr(r.item, r.field), new_value: r.value, reason: reason || null,
      requested_by: profile.id, requested_by_name: profile.full_name || null,
    }))
    const { error } = await supabase.from('item_change_requests').insert(payload)
    if (error) { setError(error.message); return false }
    return true
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(''); setSuccess('')
    const payload = { ...form, kg_per_bag: form.kg_per_bag === '' ? null : Number(form.kg_per_bag), pcs_per_roll: form.pcs_per_roll === '' ? null : Number(form.pcs_per_roll) }
    if (editing && !isHO) {
      // Staff: send each changed field to Head Office for approval (code is locked)
      const changed = ITEM_FIELDS.filter(f => formStr(f.key) !== itemStr(editing, f.key))
      if (changed.length === 0) { setError('Nothing changed.'); setSaving(false); return }
      const reason = window.prompt('Reason for these changes (sent to Head Office):') || ''
      if (reason === null) { setSaving(false); return }
      const ok = await submitItemRequests(changed.map(f => ({ item: editing, field: f.key, value: formStr(f.key) })), reason)
      setSaving(false)
      if (ok) { setShowForm(false); setSuccess(`Sent ${changed.length} change(s) to Head Office for approval.`); loadItems() }
      return
    }
    if (editing) {
      const { error } = await supabase.from('items').update(payload).eq('id', editing.id)
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('items').insert(payload)
      if (error) { setError(error.message); setSaving(false); return }
    }
    setShowForm(false); setSaving(false); loadItems()
  }

  // Bulk-set one field on all selected items (HO applies; staff request approval)
  async function applyBulk() {
    setError(''); setSuccess('')
    const targets = items.filter(i => selected.has(i.id))
    if (targets.length === 0) { setError('Tick at least one item first.'); return }
    const label = ITEM_FIELDS.find(f => f.key === bulkField)?.label || bulkField
    if (!confirm(`Set "${label}" to "${bulkValue || '(blank)'}" on ${targets.length} item(s)${isHO ? '' : ' — sent to Head Office for approval'}?`)) return
    setBulkEditBusy(true)
    if (isHO) {
      const value: unknown = bulkField === 'supplied_by_factory' ? (bulkValue === 'true')
        : (bulkField === 'kg_per_bag' || bulkField === 'pcs_per_roll') ? (bulkValue === '' ? null : Number(bulkValue))
          : bulkValue
      const { error } = await supabase.from('items').update({ [bulkField]: value }).in('id', targets.map(t => t.id))
      setBulkEditBusy(false)
      if (error) { setError(error.message); return }
      setSuccess(`Updated ${label} on ${targets.length} item(s).`); setSelected(new Set()); loadItems()
    } else {
      const reason = window.prompt('Reason for this bulk change (sent to Head Office):') || ''
      const ok = await submitItemRequests(targets.map(t => ({ item: t, field: bulkField, value: bulkValue })), reason)
      setBulkEditBusy(false)
      if (ok) { setSuccess(`Sent ${targets.length} change(s) to Head Office for approval.`); setSelected(new Set()); loadItems() }
    }
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
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-2xl font-bold">Items Master</h1>
          {isHO && canEdit && (
            <button onClick={openCreate}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
              + Add Item
            </button>
          )}
        </div>
        {!isHO && canEdit && <p className="text-gray-500 text-sm mb-4">You can edit item fields — changes are sent to Head Office for approval.</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}
        {error && !showForm && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}

        {isHO && canEdit && (
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

        {showForm && (isHO || editing) && (
          <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{editing ? (isHO ? 'Edit Item' : 'Request item changes') : 'New Item'}</h2>
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
              <div>
                <label className="block text-sm font-medium mb-1">Pieces per roll <span className="text-gray-400 font-normal">(optional)</span></label>
                <input type="number" step="any" min="0" value={form.pcs_per_roll} onChange={e => setForm({ ...form, pcs_per_roll: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" placeholder="e.g. 1600 — for roll plastics" />
                <p className="text-xs text-gray-400 mt-1">For roll plastics: how many pieces are in one roll (e.g. 500m = 1600 pc → enter 1600). Stock is counted in pieces, but received and requested in whole rolls.</p>
              </div>
            </div>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded">{error}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={saving}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                {saving ? 'Saving...' : editing && !isHO ? 'Send for approval' : 'Save'}
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

        {canEdit && selected.size > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-3 flex flex-wrap items-end gap-3 text-sm">
            <span className="font-medium text-blue-800">{selected.size} selected — bulk set:</span>
            <div className="flex flex-col gap-1"><span className="text-xs text-gray-600">Field</span>
              <select value={bulkField} onChange={e => { setBulkField(e.target.value); setBulkValue('') }} className="border rounded px-2 py-1.5 bg-white">
                {ITEM_FIELDS.filter(f => f.key !== 'description').map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select></div>
            <div className="flex flex-col gap-1"><span className="text-xs text-gray-600">New value</span>
              {bulkField === 'type' ? (
                <select value={bulkValue} onChange={e => setBulkValue(e.target.value)} className="border rounded px-2 py-1.5 bg-white"><option value="">—</option><option value="Material">Material</option><option value="Manufactured">Manufactured</option></select>
              ) : bulkField === 'supplied_by_factory' ? (
                <select value={bulkValue} onChange={e => setBulkValue(e.target.value)} className="border rounded px-2 py-1.5 bg-white"><option value="">—</option><option value="true">🏭 Factory</option><option value="false">📦 Warehouse</option></select>
              ) : (bulkField === 'kg_per_bag' || bulkField === 'pcs_per_roll') ? (
                <input type="number" step="any" min="0" value={bulkValue} onChange={e => setBulkValue(e.target.value)} className="border rounded px-2 py-1.5" placeholder="blank = clear" />
              ) : (
                <input value={bulkValue} onChange={e => setBulkValue(e.target.value)} className="border rounded px-2 py-1.5" />
              )}
            </div>
            <button onClick={applyBulk} disabled={bulkEditBusy} className="bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{bulkEditBusy ? 'Working…' : isHO ? 'Apply to selected' : 'Request for selected'}</button>
            <button onClick={() => setSelected(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[30rem]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>
                {[...(canEdit ? [''] : []), 'Code', 'Description', 'Unit', 'Stock Group', 'Type', 'Source', ...(canEdit || canDelete ? ['Actions'] : [])].map((h, i) => (
                  <th key={i} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center py-8 text-gray-400">No items found</td></tr>
              )}
              {filtered.map(item => (
                <tr key={item.id} className="border-b last:border-0 hover:bg-gray-50">
                  {canEdit && <td className="px-4 py-3"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSel(item.id)} className="h-4 w-4" /></td>}
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
                  {(canEdit || canDelete) && (
                    <td className="px-4 py-3 flex gap-2 items-center">
                      {canEdit && <button onClick={() => openEdit(item)} className="text-blue-600 hover:underline text-xs">{isHO ? 'Edit' : 'Request edit'}</button>}
                      {canDelete && isHO && <button onClick={() => handleDelete(item.id)} className="text-red-500 hover:underline text-xs">Delete</button>}
                      {pendingItemIds.has(item.id) && <span className="text-amber-600 text-xs whitespace-nowrap">⏳ pending</span>}
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
