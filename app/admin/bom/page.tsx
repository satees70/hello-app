'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Item { id: string; code: string; description: string; unit: string; type: string }
interface BomComponent { id: string; parent_item_id: string; component_item_id: string; quantity: number; apply_allowance: boolean }

export default function BomPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const [items, setItems] = useState<Item[]>([])
  const [parentId, setParentId] = useState('')
  const [components, setComponents] = useState<BomComponent[]>([])
  const [addComponentId, setAddComponentId] = useState('')
  const [addQty, setAddQty] = useState('1')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile) return
    if (profile.factory_code !== 'HEAD_OFFICE') { router.replace('/dashboard'); return }
    loadItems()
  }, [profile])

  useEffect(() => {
    if (parentId) loadComponents(); else setComponents([])
  }, [parentId])

  async function loadItems() {
    const { data } = await supabase.from('items').select('id, code, description, unit, type').order('code')
    setItems(data || [])
  }

  async function loadComponents() {
    const { data } = await supabase.from('bom_components').select('*').eq('parent_item_id', parentId)
    setComponents(data || [])
    setDirty(false)
  }

  const itemById = (id: string) => items.find(i => i.id === id)
  const manufactured = items.filter(i => i.type === 'Manufactured')
  const parent = itemById(parentId)

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

  async function saveAll() {
    setError(''); setSuccess(''); setSaving(true)
    const results = await Promise.all(components.map(c =>
      supabase.from('bom_components').update({ quantity: Number(c.quantity) || 0, apply_allowance: c.apply_allowance }).eq('id', c.id)
    ))
    const failed = results.find(r => r.error)
    if (failed?.error) { setError(failed.error.message); setSaving(false); return }
    setDirty(false); setSaving(false)
    setSuccess('All changes saved.')
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

        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <label className="block text-sm font-medium mb-1">Manufactured item</label>
          <select value={parentId} onChange={e => { setParentId(e.target.value); setError(''); setSuccess('') }}
            className="w-full sm:w-[28rem] border rounded-lg px-3 py-2 bg-white">
            <option value="">-- Select a manufactured item --</option>
            {manufactured.map(i => <option key={i.id} value={i.id}>{i.code} — {i.description}</option>)}
          </select>
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
              <h3 className="font-medium mb-3 text-sm">Add a component</h3>
              <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium mb-1">Component item</label>
                  <select value={addComponentId} onChange={e => setAddComponentId(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="">-- Choose item --</option>
                    {available.map(i => <option key={i.id} value={i.id}>{i.code} — {i.description}{i.type === 'Manufactured' ? ' (Manufactured)' : ''}</option>)}
                  </select>
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
                        <td className="px-4 py-3 font-mono font-medium">{ci?.code || '—'}</td>
                        <td className="px-4 py-3 text-gray-700">{ci?.description || '(item not found)'}</td>
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
