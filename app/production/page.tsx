'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface BatchItem { id: string; customer_name: string; so_number: string; quantity: number }
interface Batch {
  id: string
  batch_no: string
  item_code: string
  description: string
  delivery_date: string
  factory_code: string
  total_quantity: number
  status: string
  production_batch_items: BatchItem[]
}
interface Item { id: string; code: string; description: string; unit: string; type: string }
interface BomComp { parent_item_id: string; component_item_id: string; quantity: number; apply_allowance: boolean }

const STATUSES = ['Planned', 'Requested', 'In Progress', 'Completed'] as const
const FILTERS = ['All', ...STATUSES] as const
type Filter = typeof FILTERS[number]

const STATUS_STYLE: Record<string, string> = {
  Planned: 'bg-blue-100 text-blue-700',
  Requested: 'bg-indigo-100 text-indigo-700',
  'In Progress': 'bg-amber-100 text-amber-700',
  Completed: 'bg-green-100 text-green-700',
}

export default function ProductionPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [boms, setBoms] = useState<BomComp[]>([])
  const [stock, setStock] = useState<Record<string, number>>({}) // `${item_id}|${factory}` -> qty
  const [requestBatchIds, setRequestBatchIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('All')
  const [updating, setUpdating] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [selected, setSelected] = useState<Batch | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState<'date' | 'factory'>('date')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [factoryFilter, setFactoryFilter] = useState('')
  const [savingStock, setSavingStock] = useState('')
  const [raising, setRaising] = useState(false)

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) loadAll() }, [profile])

  async function loadAll() {
    const [{ data: b }, { data: f }, { data: it }, { data: bc }, { data: st }, { data: mr }] = await Promise.all([
      supabase.from('production_batches').select('*, production_batch_items(id, customer_name, so_number, quantity)').order('created_at', { ascending: false }),
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('items').select('id, code, description, unit, type'),
      supabase.from('bom_components').select('parent_item_id, component_item_id, quantity, apply_allowance'),
      supabase.from('item_stock').select('item_id, factory_code, quantity'),
      supabase.from('material_requests').select('batch_id'),
    ])
    setBatches((b as Batch[]) || [])
    setFactories(f || [])
    setItems(it || [])
    setBoms((bc as BomComp[]) || [])
    const sm: Record<string, number> = {}
    ;(st || []).forEach(r => { sm[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setStock(sm)
    setRequestBatchIds(new Set((mr || []).map(r => r.batch_id)))
  }

  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'
  // Trim floating-point noise (e.g. 0.0011250000000000001 -> 0.001125)
  const clean = (n: number) => Number(n.toPrecision(12))
  const BUFFER = 1.1 // request 10% more than the shortfall as a safety margin

  async function setStatus(b: Batch, status: string) {
    setUpdating(b.id); setError('')
    const { error: updErr } = await supabase.from('production_batches').update({ status }).eq('id', b.id)
    if (updErr) { setError(updErr.message); setUpdating(''); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, status } : x)))
    setUpdating('')
  }

  // --- material explosion ---
  function explode(batch: Batch) {
    const parent = items.find(i => i.code === batch.item_code)
    if (!parent) return { note: `Item ${batch.item_code} is not in Items Master.`, rows: [] }
    const comps = boms.filter(b => b.parent_item_id === parent.id)
    if (comps.length === 0) return { note: 'No BOM defined for this item. Add a recipe in BOM first.', rows: [] }
    const rows = comps.map(c => {
      const ci = items.find(i => i.id === c.component_item_id)
      const required = c.quantity * batch.total_quantity
      const key = `${c.component_item_id}|${batch.factory_code}`
      const st = stock[key] ?? 0
      const shortfall = Math.max(required - st, 0)
      const requested = c.apply_allowance ? Math.ceil(shortfall * BUFFER) : clean(shortfall)
      return {
        item_id: c.component_item_id, key,
        code: ci?.code || '—', description: ci?.description || '', unit: ci?.unit || '',
        required, stock: st, shortfall, requested,
      }
    })
    return { note: '', rows }
  }

  async function saveStock(itemId: string, factory: string, key: string, value: number) {
    setSavingStock(key); setError(''); setSuccess('')
    const { error: upErr } = await supabase.from('item_stock')
      .upsert({ item_id: itemId, factory_code: factory, quantity: value, updated_at: new Date().toISOString() }, { onConflict: 'item_id,factory_code' })
    if (upErr) { setError(`Stock save failed: ${upErr.message}`); setSavingStock(''); return }
    setStock(prev => ({ ...prev, [key]: value }))
    setSavingStock('')
    setSuccess('Stock updated.')
    reloadRequests() // an open request may have auto-refreshed (or cleared)
  }

  async function reloadRequests() {
    const { data } = await supabase.from('material_requests').select('batch_id')
    setRequestBatchIds(new Set((data || []).map(r => r.batch_id)))
  }

  async function raiseRequest(batch: Batch) {
    setRaising(true); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('raise_material_request', { p_batch_id: batch.id })
    if (rpcErr) { setError(rpcErr.message); setRaising(false); return }
    setSuccess(`Material request raised for ${batch.batch_no}.`)
    setRequestBatchIds(prev => new Set(prev).add(batch.id))
    setBatches(prev => prev.map(x => (x.id === batch.id && x.status === 'Planned' ? { ...x, status: 'Requested' } : x)))
    setRaising(false)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const dateKey = (d: string) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(d || '')
    return m ? new Date(2000 + +m[3], +m[2] - 1, +m[1]).getTime() : Number.MAX_SAFE_INTEGER
  }
  const fromTs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null
  const toTs = dateTo ? new Date(dateTo + 'T00:00:00').getTime() : null
  let shown = filter === 'All' ? batches : batches.filter(b => b.status === filter)
  if (fromTs !== null) shown = shown.filter(b => { const k = dateKey(b.delivery_date); return k !== Number.MAX_SAFE_INTEGER && k >= fromTs })
  if (toTs !== null) shown = shown.filter(b => { const k = dateKey(b.delivery_date); return k !== Number.MAX_SAFE_INTEGER && k <= toTs })
  if (isHO && factoryFilter) shown = shown.filter(b => b.factory_code === factoryFilter)
  const counts: Record<string, number> = { Planned: 0, Requested: 0, 'In Progress': 0, Completed: 0 }
  batches.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1 })

  const exploded = selected ? explode(selected) : null
  const totalShortfall = exploded ? exploded.rows.reduce((s, r) => s + r.shortfall, 0) : 0
  const hasRequest = selected ? requestBatchIds.has(selected.id) : false

  // Group batches by delivery date or factory
  const byFactory = isHO && groupBy === 'factory'
  const groupsMap: Record<string, Batch[]> = {}
  shown.forEach(b => {
    const k = byFactory ? (b.factory_code || 'Unassigned') : (b.delivery_date || 'No date')
    ;(groupsMap[k] = groupsMap[k] || []).push(b)
  })
  const groupKeys = Object.keys(groupsMap).sort((a, b) => byFactory ? a.localeCompare(b) : dateKey(a) - dateKey(b))
  const groupLabel = (k: string) => byFactory ? `🏭 ${factoryName(k)}` : `📅 ${k}`
  const toggleRow = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  // Which context column to show in rows: factory when grouping by date (HO), delivery date when grouping by factory
  const showFactoryCol = isHO && !byFactory
  const showDateCol = byFactory
  const expandSpan = 5 + (showFactoryCol ? 1 : 0) + (showDateCol ? 1 : 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Production Board</h1>
        <p className="text-gray-500 text-sm mb-5">
          Production batches generated from confirmed sales orders.
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>

        <div className="flex flex-wrap gap-2 items-center mb-4 text-sm">
          <span className="text-gray-500">Status:</span>
          <select value={filter} onChange={e => setFilter(e.target.value as Filter)} className="border rounded-lg px-2 py-1 bg-white">
            {FILTERS.map(f => <option key={f} value={f}>{f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}</option>)}
          </select>
          <span className="text-gray-500 ml-3">Delivery date:</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border rounded-lg px-2 py-1 bg-white" />
          <span className="text-gray-400">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border rounded-lg px-2 py-1 bg-white" />
          {isHO && (
            <>
              <span className="text-gray-500 ml-3">Factory:</span>
              <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-2 py-1 bg-white">
                <option value="">All factories</option>
                {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
              </select>
            </>
          )}
          {(dateFrom || dateTo || factoryFilter || filter !== 'All') && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setFactoryFilter(''); setFilter('All') }} className="text-blue-600 hover:underline ml-1">Clear filters</button>
          )}
        </div>

        {isHO && (
          <div className="flex gap-2 mb-5 items-center text-sm">
            <span className="text-gray-500">Group by:</span>
            {(['date', 'factory'] as const).map(g => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`px-3 py-1 rounded-lg font-medium border ${groupBy === g ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {g === 'date' ? 'Delivery date' : 'Factory'}
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No production batches{filter !== 'All' ? ` with status "${filter}"` : ''} yet.
            <br />Confirm a sales order document to generate production demand.
          </div>
        ) : (
          <div className="space-y-6">
            {groupKeys.map(date => (
              <div key={date}>
                <h3 className="font-semibold text-sm text-gray-700 mb-2">
                  {groupLabel(date)} <span className="text-gray-400 font-normal">· {groupsMap[date].length} batch(es)</span>
                </h3>
                <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="w-6"></th>
                        {['Batch', 'Item', 'Total qty', ...(showFactoryCol ? ['Factory'] : []), ...(showDateCol ? ['Delivery date'] : []), 'Status', ''].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {groupsMap[date].map(b => (
                        <Fragment key={b.id}>
                          <tr className={`border-b last:border-0 hover:bg-gray-50 cursor-pointer ${expanded.has(b.id) ? 'bg-blue-50/40' : ''}`} onClick={() => toggleRow(b.id)}>
                            <td className="pl-3 text-gray-400">{expanded.has(b.id) ? '▾' : '▸'}</td>
                            <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                            <td className="px-3 py-2">
                              <span className="font-medium">{b.item_code}</span>
                              <span className="block text-gray-500 text-xs">{b.description}</span>
                            </td>
                            <td className="px-3 py-2 font-semibold whitespace-nowrap">{b.total_quantity}</td>
                            {showFactoryCol && <td className="px-3 py-2 whitespace-nowrap">{factoryName(b.factory_code)}</td>}
                            {showDateCol && <td className="px-3 py-2 whitespace-nowrap">{b.delivery_date || '—'}</td>}
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              <select value={b.status} disabled={updating === b.id}
                                onChange={e => setStatus(b, e.target.value)}
                                className={`border rounded-lg px-2 py-1 text-xs ${STATUS_STYLE[b.status] || 'bg-white'}`}>
                                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-right">
                              {requestBatchIds.has(b.id) && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">MR</span>}
                            </td>
                          </tr>
                          {expanded.has(b.id) && (
                            <tr className="bg-gray-50/60 border-b last:border-0">
                              <td></td>
                              <td colSpan={expandSpan} className="px-3 py-3">
                                <div className="text-gray-400 text-xs mb-1">Per customer / order</div>
                                <ul className="space-y-1 mb-3 max-w-lg">
                                  {b.production_batch_items?.map(it => (
                                    <li key={it.id} className="flex justify-between items-baseline gap-2">
                                      <span className="text-gray-700 truncate min-w-0">{it.customer_name}</span>
                                      <span className="flex-shrink-0 flex items-baseline gap-2">
                                        {it.so_number && <span className="text-gray-400 font-mono text-xs">{it.so_number}</span>}
                                        <span className="font-medium">{it.quantity}</span>
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                <button onClick={() => { setSelected(b); setError(''); setSuccess('') }}
                                  className="border border-blue-600 text-blue-600 px-4 py-1.5 rounded-lg hover:bg-blue-50 text-sm font-medium">
                                  Materials
                                </button>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}

        {selected && exploded && (
          <div className="bg-white rounded-xl shadow-sm border mt-8 p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-lg">
                Material requirements — <span className="font-mono">{selected.batch_no}</span>
              </h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
            </div>
            <p className="text-gray-500 text-sm mb-4">
              To make <strong>{selected.total_quantity}</strong> of {selected.item_code} at {isHO ? factoryName(selected.factory_code) : (selected.factory_code || 'this factory')}.
              Enter current stock to see the shortfall.
            </p>

            {exploded.note ? (
              <p className="text-amber-600 text-sm bg-amber-50 p-3 rounded">{exploded.note}</p>
            ) : (
              <>
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>{['Material', 'Description', 'Unit', 'Required', 'Stock', 'Shortfall', 'Requested', ''].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {exploded.rows.map(r => (
                        <tr key={r.key} className={`border-b last:border-0 ${r.shortfall > 0 ? '' : 'bg-green-50/40'}`}>
                          <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{r.code}</td>
                          <td className="px-3 py-2 text-gray-600">{r.description}</td>
                          <td className="px-3 py-2 text-gray-500">{r.unit}</td>
                          <td className="px-3 py-2 text-right">{clean(r.required)}</td>
                          <td className="px-3 py-2">
                            <input type="number" step="any"
                              value={stock[r.key] ?? 0}
                              onChange={e => setStock(prev => ({ ...prev, [r.key]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                              className="w-24 border rounded px-2 py-1 text-right" />
                          </td>
                          <td className={`px-3 py-2 text-right font-semibold ${r.shortfall > 0 ? 'text-red-600' : 'text-green-600'}`}>{clean(r.shortfall)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-blue-700">{r.shortfall > 0 ? r.requested : 0}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <button onClick={() => saveStock(r.item_id, selected.factory_code, r.key, stock[r.key] ?? 0)}
                              disabled={savingStock === r.key}
                              className="text-blue-600 hover:underline text-xs disabled:opacity-50">Save stock</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between mt-4">
                  <div className="text-sm">
                    {hasRequest
                      ? <span className="text-purple-700">A material request is already open for this batch — its quantities update automatically as BOM/stock change (until receiving starts). See Material Requests.</span>
                      : totalShortfall > 0
                        ? <span className="text-red-600">Total shortfall across {exploded.rows.filter(r => r.shortfall > 0).length} material(s).</span>
                        : <span className="text-green-600">Enough stock on hand — no shortfall.</span>}
                  </div>
                  <button onClick={() => raiseRequest(selected)}
                    disabled={raising || hasRequest || totalShortfall <= 0}
                    className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                    {raising ? 'Raising…' : 'Raise Material Request'}
                  </button>
                </div>
                <p className="text-gray-400 text-xs mt-2">Tip: save your stock figures first, then raise the request — it captures the shortfall at that moment and adds a safety margin (rounded up) so the warehouse picks enough.</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
