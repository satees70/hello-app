'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase, fetchAll } from '@/lib/supabase'

interface Item { id: string; code: string; description: string; unit: string; type: string }
interface BomComponent { id: string; parent_item_id: string; component_item_id: string; quantity: number; apply_allowance: boolean }

// Type-to-search item picker (replaces a huge native dropdown)
function ItemCombo({ items, value, onChange, placeholder }: {
  items: Item[]; value: string; onChange: (id: string) => void; placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const selected = items.find(i => i.id === value)
  const text = open ? q : (selected ? `${selected.code} — ${selected.description}` : '')
  const matches = (open && q.trim()
    ? items.filter(i => `${i.code} ${i.description}`.toLowerCase().includes(q.toLowerCase()))
    : items).slice(0, 50)
  return (
    <div className="relative">
      <input value={text} placeholder={placeholder}
        onChange={e => { setQ(e.target.value); setOpen(true); if (value) onChange('') }}
        onFocus={() => { setOpen(true); setQ('') }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full border rounded-lg px-3 py-2 text-sm bg-white" />
      {open && (
        <ul className="absolute z-20 mt-1 w-full max-h-64 overflow-auto bg-white border rounded-lg shadow-lg text-sm">
          {matches.length === 0 && <li className="px-3 py-2 text-gray-400">No matches</li>}
          {matches.map(i => (
            <li key={i.id} onMouseDown={() => { onChange(i.id); setOpen(false) }}
              className="px-3 py-2 hover:bg-blue-50 cursor-pointer">
              <span className="font-mono">{i.code}</span> <span className="text-gray-500">— {i.description}{i.type === 'Manufactured' ? ' (Manufactured)' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function BomPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const [items, setItems] = useState<Item[]>([])
  const [parentId, setParentId] = useState('')
  const [components, setComponents] = useState<BomComponent[]>([])
  const [addComponentId, setAddComponentId] = useState('')
  const [addQty, setAddQty] = useState('1')
  const [copyFromId, setCopyFromId] = useState('')
  const [copying, setCopying] = useState(false)
  const [bomParents, setBomParents] = useState<Set<string>>(new Set())
  const [editRowId, setEditRowId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const bulkRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!profile) return
    if (profile.factory_code !== 'HEAD_OFFICE') { router.replace('/dashboard'); return }
    loadItems(); loadBomParents()
  }, [profile])

  async function loadBomParents() {
    const rows = await fetchAll<{ parent_item_id: string }>('bom_components', 'parent_item_id')
    setBomParents(new Set(rows.map(r => r.parent_item_id)))
  }

  useEffect(() => {
    if (parentId) loadComponents(); else setComponents([])
  }, [parentId])

  // Pre-select a manufactured item when arriving from "Create BOM →" (?item=CODE)
  useEffect(() => {
    if (items.length === 0) return
    const code = new URLSearchParams(window.location.search).get('item')
    if (code) { const it = items.find(i => i.code === code); if (it) setParentId(it.id) }
  }, [items])

  async function loadItems() {
    setItems(await fetchAll<Item>('items', 'id, code, description, unit, type', 'code'))
  }

  async function loadComponents() {
    const { data } = await supabase.from('bom_components').select('*').eq('parent_item_id', parentId)
    setComponents(data || [])
    setDirty(false)
  }

  const itemById = (id: string) => items.find(i => i.id === id)
  const manufactured = items.filter(i => i.type === 'Manufactured')
  const parent = itemById(parentId)

  function downloadBomTemplate() {
    const csv = 'parent_code,component_code,quantity,allowance\nA0501-40PKT,BK1055-H,20,yes\nA0501-40PKT,P95337,0.015,yes\nA0501-40PKT,PA0501,40,no\n'
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'bom-template.csv'; a.click(); URL.revokeObjectURL(url)
  }

  function handleBulkUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBulkBusy(true); setBulkMsg(''); setError('')
    const byCode = new Map(items.map(i => [i.code, i]))
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: true,
      complete: async (res) => {
        const pick = (r: Record<string, string>, ...keys: string[]) => {
          for (const k of Object.keys(r)) { if (keys.includes(k.trim().toLowerCase())) return (r[k] || '').trim() }
          return ''
        }
        const valid: { parent_item_id: string; component_item_id: string; quantity: number; apply_allowance: boolean }[] = []
        const unknown = new Set<string>()
        let selfRef = 0, badQty = 0
        res.data.forEach(r => {
          const pc = pick(r, 'parent_code', 'parent', 'manufactured_code', 'manufactured item code')
          const cc = pick(r, 'component_code', 'component', 'material_code')
          if (!pc || !cc) return
          const p = byCode.get(pc); const c = byCode.get(cc)
          if (!p) { unknown.add(pc); return }
          if (!c) { unknown.add(cc); return }
          if (p.id === c.id) { selfRef++; return }
          const qty = Number(pick(r, 'quantity', 'qty', 'qty per unit'))
          if (!qty || qty <= 0) { badQty++; return }
          const a = pick(r, 'allowance', 'apply_allowance').toLowerCase()
          const apply_allowance = !(a === 'no' || a === 'n' || a === 'false' || a === '0' || a === 'none' || a === 'off')
          valid.push({ parent_item_id: p.id, component_item_id: c.id, quantity: qty, apply_allowance })
        })
        // de-dup by parent+component (keep last)
        const seen = new Map<string, typeof valid[number]>()
        const dups = new Set<string>()
        valid.forEach(v => { const k = `${v.parent_item_id}|${v.component_item_id}`; if (seen.has(k)) dups.add(k); seen.set(k, v) })
        const rows = [...seen.values()]
        if (rows.length === 0) {
          setBulkMsg(`No valid recipe rows found.${unknown.size ? ` Unknown item codes: ${[...unknown].slice(0, 8).join(', ')}.` : ''}`)
          setBulkBusy(false); if (bulkRef.current) bulkRef.current.value = ''; return
        }
        let ok = 0; let firstErr = ''
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500)
          const { error: upErr } = await supabase.from('bom_components').upsert(chunk, { onConflict: 'parent_item_id,component_item_id' })
          if (upErr) { if (!firstErr) firstErr = upErr.message } else ok += chunk.length
        }
        setBulkBusy(false); if (bulkRef.current) bulkRef.current.value = ''
        const notes = [
          unknown.size ? `${unknown.size} unknown item code(s) skipped: ${[...unknown].slice(0, 8).join(', ')}${unknown.size > 8 ? '…' : ''}` : '',
          selfRef ? `${selfRef} row(s) skipped (item listed as its own component)` : '',
          badQty ? `${badQty} row(s) skipped (missing/invalid quantity)` : '',
          dups.size ? `${dups.size} duplicate recipe line(s) merged` : '',
        ].filter(Boolean).join('. ')
        if (firstErr) setBulkMsg(`Error during import: ${firstErr}`)
        else setBulkMsg(`Imported ${ok} recipe line(s).${notes ? ' ⚠ ' + notes + '.' : ''}`)
        if (parentId) loadComponents()
      },
      error: (err) => { setBulkMsg(`Could not read file: ${err.message}`); setBulkBusy(false) },
    })
  }

  // Items that can still be added (not the parent, not already a component)
  const usedIds = new Set(components.map(c => c.component_item_id))
  const available = items.filter(i => i.id !== parentId && !usedIds.has(i.id))

  async function addComponent() {
    setError(''); setSuccess('')
    if (!parentId) { setError('Select a manufactured item first.'); return }
    if (!addComponentId) { setError('Choose a component item.'); return }
    const qty = Number(addQty)
    if (!qty || qty <= 0) { setError('Enter a quantity greater than 0.'); return }
    const { data: inserted, error: insErr } = await supabase.from('bom_components').insert({
      parent_item_id: parentId, component_item_id: addComponentId, quantity: qty,
    }).select().single()
    if (insErr || !inserted) { setError(insErr?.message || 'Could not add component.'); return }
    setComponents(prev => [...prev, inserted])
    setAddComponentId(''); setAddQty('1')
    setSuccess('Component added.')
  }

  function setRowQty(id: string, value: string) {
    setComponents(prev => prev.map(c => (c.id === id ? { ...c, quantity: value === '' ? 0 : Number(value) } : c)))
    setDirty(true)
  }

  function setRowAllowance(id: string) {
    setComponents(prev => prev.map(c => (c.id === id ? { ...c, apply_allowance: !c.apply_allowance } : c)))
    setDirty(true)
  }

  function setRowComponent(id: string, newComponentId: string) {
    if (!newComponentId) return
    if (components.some(c => c.id !== id && c.component_item_id === newComponentId)) {
      setError('That component is already in this recipe.'); return
    }
    setComponents(prev => prev.map(c => (c.id === id ? { ...c, component_item_id: newComponentId } : c)))
    setDirty(true); setEditRowId(''); setError('')
  }

  async function saveAll() {
    setError(''); setSuccess(''); setSaving(true)
    const results = await Promise.all(components.map(c =>
      supabase.from('bom_components').update({ component_item_id: c.component_item_id, quantity: Number(c.quantity) || 0, apply_allowance: c.apply_allowance }).eq('id', c.id)
    ))
    const failed = results.find(r => r.error)
    if (failed?.error) { setError(failed.error.message); setSaving(false); return }
    setDirty(false); setSaving(false)
    setSuccess('All changes saved.')
    loadBomParents()
  }

  async function copyRecipe() {
    if (!parentId || !copyFromId) { setError('Pick an item to copy the recipe from.'); return }
    if (copyFromId === parentId) { setError('Choose a different item to copy from.'); return }
    setCopying(true); setError(''); setSuccess('')
    const { data: src } = await supabase.from('bom_components').select('component_item_id, quantity, apply_allowance').eq('parent_item_id', copyFromId)
    if (!src || src.length === 0) { setError('That item has no recipe to copy.'); setCopying(false); return }
    const rows = src.map(s => ({ parent_item_id: parentId, component_item_id: s.component_item_id, quantity: s.quantity, apply_allowance: s.apply_allowance }))
    const { error: upErr } = await supabase.from('bom_components').upsert(rows, { onConflict: 'parent_item_id,component_item_id' })
    if (upErr) { setError(upErr.message); setCopying(false); return }
    setCopyFromId(''); setCopying(false)
    setSuccess(`Copied ${rows.length} component(s) from ${itemById(copyFromId)?.code}. Adjust below, then Save all changes.`)
    loadComponents(); loadBomParents()
  }

  async function removeRow(id: string) {
    if (!confirm('Remove this component from the recipe?')) return
    setError(''); setSuccess('')
    const { error: delErr } = await supabase.from('bom_components').delete().eq('id', id)
    if (delErr) { setError(delErr.message); return }
    setComponents(prev => prev.filter(c => c.id !== id))
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (!profile) return null

  const parentUnit = parent?.unit || 'unit'

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Bill of Materials</h1>
        <p className="text-gray-500 text-sm mb-6">Define the recipe for each manufactured item — the components and quantity needed to make one unit.</p>

        <div className="bg-white rounded-xl shadow-sm border p-5 mb-6">
          <h2 className="font-semibold mb-1">Bulk upload recipes from CSV</h2>
          <p className="text-gray-500 text-sm mb-3">
            Set up many recipes at once. One row per component. Columns: <span className="font-mono text-xs">parent_code, component_code, quantity, allowance</span> (allowance = yes/no for the 10% buffer).
            Item codes must already exist in Items Master. Re-uploading a recipe line updates its quantity/allowance.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={downloadBomTemplate} className="border px-4 py-2 rounded-lg hover:bg-gray-50 text-sm">Download template</button>
            <input ref={bulkRef} type="file" accept=".csv,text/csv" disabled={bulkBusy} onChange={handleBulkUpload}
              className="block text-sm text-gray-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium hover:file:bg-blue-100" />
            {bulkBusy && <span className="text-blue-600 text-sm">Importing…</span>}
          </div>
          {bulkMsg && <p className="text-sm mt-3 bg-gray-50 border rounded p-2">{bulkMsg}</p>}
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <label className="block text-sm font-medium mb-1">Manufactured item</label>
          <div className="w-full sm:w-[28rem]">
            <ItemCombo items={manufactured} value={parentId} placeholder="Type a manufactured item code or name…"
              onChange={id => { setParentId(id); setError(''); setSuccess('') }} />
          </div>
          {manufactured.length === 0 && (
            <p className="text-gray-400 text-sm mt-2">No items are flagged &quot;Manufactured&quot; yet. Set an item&apos;s type to Manufactured in Items Master first.</p>
          )}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {parent && (
          <>
            <div className="mb-3">
              <h2 className="font-semibold text-lg">Recipe for <span className="font-mono">{parent.code}</span></h2>
              <p className="text-gray-500 text-sm">Components needed to make <strong>1 {parentUnit}</strong> of {parent.description}.</p>
            </div>

            <div className="bg-white rounded-xl shadow-sm border p-5 mb-6">
              <h3 className="font-medium mb-1 text-sm">Copy recipe from another item</h3>
              <p className="text-gray-400 text-xs mb-3">Start from an existing recipe, then adjust the components below.</p>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <ItemCombo items={manufactured.filter(i => i.id !== parentId && bomParents.has(i.id))} value={copyFromId} onChange={setCopyFromId} placeholder="Type an item that already has a recipe…" />
                </div>
                <button onClick={copyRecipe} disabled={copying || !copyFromId}
                  className="bg-gray-800 text-white px-5 py-2 rounded-lg hover:bg-gray-900 disabled:opacity-50 text-sm font-medium">
                  {copying ? 'Copying…' : 'Copy recipe'}
                </button>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border p-5 mb-6">
              <h3 className="font-medium mb-3 text-sm">Add a component</h3>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium mb-1">Component item</label>
                  <ItemCombo items={available} value={addComponentId} onChange={setAddComponentId} placeholder="Type a code or name…" />
                </div>
                <div className="w-32">
                  <label className="block text-xs font-medium mb-1">Qty per unit</label>
                  <input type="number" step="any" value={addQty} onChange={e => setAddQty(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm bg-white text-right" />
                </div>
                <button onClick={addComponent}
                  className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
                  Add
                </button>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    {['Component Code', 'Description', 'Type', 'Unit', 'Qty per unit', 'Allowance', 'Actions'].map(h => (
                      <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {components.length === 0 && (
                    <tr><td colSpan={7} className="text-center py-8 text-gray-400">No components yet. Add the first one above.</td></tr>
                  )}
                  {components.map(c => {
                    const ci = itemById(c.component_item_id)
                    return (
                      <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50">
                        {editRowId === c.id ? (
                          <td className="px-4 py-3" colSpan={2}>
                            <div className="flex items-center gap-2">
                              <div className="flex-1 min-w-[16rem]">
                                <ItemCombo
                                  items={items.filter(i => i.id !== parentId && (i.id === c.component_item_id || !usedIds.has(i.id)))}
                                  value={c.component_item_id}
                                  onChange={newId => setRowComponent(c.id, newId)}
                                  placeholder="Type the replacement item…" />
                              </div>
                              <button onClick={() => setEditRowId('')} className="text-gray-500 hover:underline text-xs">Cancel</button>
                            </div>
                          </td>
                        ) : (
                          <>
                            <td className="px-4 py-3 font-mono font-medium">
                              {ci?.code || '—'}
                              <button onClick={() => { setEditRowId(c.id); setError('') }} className="ml-2 text-blue-600 hover:underline text-xs font-sans font-normal">change</button>
                            </td>
                            <td className="px-4 py-3 text-gray-700">{ci?.description || '(item not found)'}</td>
                          </>
                        )}
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ci?.type === 'Manufactured' ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'}`}>
                            {ci?.type || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{ci?.unit || '—'}</td>
                        <td className="px-4 py-3 w-32">
                          <input type="number" step="any" value={c.quantity}
                            onChange={e => setRowQty(c.id, e.target.value)}
                            className="w-24 border rounded px-2 py-1 text-right" />
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={c.apply_allowance} onChange={() => setRowAllowance(c.id)} className="h-4 w-4" />
                            <span className="text-xs text-gray-500">{c.apply_allowance ? '+10%' : 'none'}</span>
                          </label>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <button onClick={() => removeRow(c.id)} className="text-red-500 hover:underline text-xs">Remove</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {components.length > 0 && (
              <div className="flex items-center gap-3 mt-4">
                <button onClick={saveAll} disabled={!dirty || saving}
                  className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                  {saving ? 'Saving…' : 'Save all changes'}
                </button>
                {dirty
                  ? <span className="text-amber-600 text-sm">You have unsaved changes.</span>
                  : <span className="text-green-600 text-sm">All changes saved.</span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
