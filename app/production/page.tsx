'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'

interface BatchItem { id: string; customer_name: string; so_number: string; quantity: number }
interface Batch {
  id: string
  batch_no: string
  item_code: string
  description: string
  delivery_date: string
  factory_code: string
  total_quantity: number
  produced_qty: number
  status: string
  material_request_id: string | null
  pack_line: string | null
  pack_date: string | null
  run_mode: string | null
  no_combine?: boolean
  production_batch_items: BatchItem[]
}
interface ConsRow { id: string; item_code: string; description: string | null; batch_no: string | null; exp_date: string | null; qty_consumed: number; consumed_at: string }
interface Item { id: string; code: string; description: string; unit: string; type: string }
interface BomComp { parent_item_id: string; component_item_id: string; quantity: number; apply_allowance: boolean; use_mode: string }

// A materials target: a single batch or a combined group of batches (same item + factory)
interface MatTarget { label: string; item_code: string; factory_code: string; total: number; batchIds: string[]; mode: string }

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
  useRequireView(profile, 'order_board')
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [boms, setBoms] = useState<BomComp[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<Filter>('All')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [selected, setSelected] = useState<MatTarget | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [factoryFilter, setFactoryFilter] = useState('')
  const [savingStock, setSavingStock] = useState('')
  const [raising, setRaising] = useState(false)
  const [expDate, setExpDate] = useState('')
  const [combineOn, setCombineOn] = useState(true)
  const [sortBy, setSortBy] = useState<'due_asc' | 'due_desc' | 'batch'>('due_asc')
  const [consumption, setConsumption] = useState<Record<string, ConsRow[]>>({}) // batch id -> consumed lots
  const [packEdit, setPackEdit] = useState<Record<string, { line: string; date: string; mode?: string }>>({}) // batch id -> pack plan being edited
  const [savingPlan, setSavingPlan] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) loadAll() }, [profile])

  async function loadAll() {
    const [{ data: b }, { data: f }, it, bc, { data: st }] = await Promise.all([
      supabase.from('production_batches').select('*, production_batch_items(id, customer_name, so_number, quantity)').order('created_at', { ascending: false }),
      supabase.from('factories').select('code, name').order('code'),
      fetchAll<Item>('items', 'id, code, description, unit, type'),
      fetchAll<BomComp>('bom_components', 'parent_item_id, component_item_id, quantity, apply_allowance, use_mode'),
      supabase.from('item_stock').select('item_id, factory_code, quantity'),
    ])
    setBatches((b as Batch[]) || [])
    setFactories(f || [])
    setItems(it)
    setBoms(bc)
    const sm: Record<string, number> = {}
    ;(st || []).forEach(r => { sm[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setStock(sm)
  }

  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'
  const clean = (n: number) => Number(n.toPrecision(12))
  const BUFFER = 1.1

  async function makeManufactured(it: Item) {
    if (!confirm(`Change ${it.code} to a Manufactured item? You can then set its BOM recipe.`)) return
    setError(''); setSuccess('')
    const { error: upErr } = await supabase.from('items').update({ type: 'Manufactured' }).eq('id', it.id)
    if (upErr) { setError(upErr.message); return }
    setItems(prev => prev.map(x => (x.id === it.id ? { ...x, type: 'Manufactured' } : x)))
    setSuccess(`${it.code} is now Manufactured — add its BOM next (Create BOM).`)
  }

  // Flag batches whose item can't be exploded into materials, with HO quick-actions
  function bomBadge(itemCode: string) {
    const it = items.find(i => i.code === itemCode)
    if (!it) return <span className="inline-block mt-0.5 bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-[11px] font-medium">⚠ Not in Items Master</span>
    if (it.type !== 'Manufactured') {
      if (!isHO) return null
      return <button onClick={() => makeManufactured(it)} className="mt-0.5 inline-block text-blue-600 hover:underline text-[11px]">Set as Manufactured</button>
    }
    if (boms.some(b => b.parent_item_id === it.id)) return null
    return (
      <span className="mt-0.5 inline-flex items-center gap-2">
        <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[11px] font-medium">⚠ No BOM set</span>
        {isHO && <a href={`/admin/bom?item=${encodeURIComponent(it.code)}`} className="text-blue-600 hover:underline text-[11px]">Create BOM →</a>}
      </span>
    )
  }

  // Status is automatic — derived from the workflow, never set by hand:
  // produced fully → Completed; some produced → In Progress; request raised → Requested; else Planned.
  function derivedStatus(b: Batch): string {
    const produced = Number(b.produced_qty || 0)
    if (produced >= b.total_quantity && b.total_quantity > 0) return 'Completed'
    if (produced > 0) return 'In Progress'
    if (b.material_request_id) return 'Requested'
    return 'Planned'
  }

  // Explode a BOM for a given item/factory/quantity
  function explode(itemCode: string, factoryCode: string, total: number, mode = 'auto') {
    const parent = items.find(i => i.code === itemCode)
    if (!parent) return { note: `Item ${itemCode} is not in Items Master.`, rows: [] }
    const comps = boms.filter(b => b.parent_item_id === parent.id && ((b.use_mode || 'any') === 'any' || (b.use_mode || 'any') === mode))
    if (comps.length === 0) return { note: 'No BOM defined for this item. Add a recipe in BOM first.', rows: [] }
    const rows = comps.map(c => {
      const ci = items.find(i => i.id === c.component_item_id)
      const required = c.quantity * total
      const key = `${c.component_item_id}|${factoryCode}`
      const st = stock[key] ?? 0
      const shortfall = Math.max(required - st, 0)
      const requested = c.apply_allowance ? Math.ceil(shortfall * BUFFER) : clean(shortfall)
      return { item_id: c.component_item_id, key, code: ci?.code || '—', description: ci?.description || '', unit: ci?.unit || '', required, stock: st, shortfall, requested }
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
  }

  async function raiseTarget(t: MatTarget) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expDate) || expDate < '2020-01-01' || expDate > '2100-12-31') {
      setError('Enter a valid expiry date (year between 2020 and 2100).'); return
    }
    setRaising(true); setError(''); setSuccess('')
    // Save the product expiry date onto the batch(es) first — it flows to the factory/label list
    const { error: expErr } = await supabase.from('production_batches')
      .update({ exp_date: expDate || null }).in('id', t.batchIds)
    if (expErr) { setError(expErr.message); setRaising(false); return }
    const { error: rpcErr } = t.batchIds.length === 1
      ? await supabase.rpc('raise_material_request', { p_batch_id: t.batchIds[0] })
      : await supabase.rpc('raise_combined_material_request', { p_batch_ids: t.batchIds })
    if (rpcErr) { setError(rpcErr.message); setRaising(false); return }
    setSuccess(`Material request raised for ${t.label}.`)
    setRaising(false)
    setSelected(null)
    setExpDate('')
    await loadAll()
  }

  const toggleRow = (id: string) => setExpanded(prev => {
    const n = new Set(prev); const had = n.has(id); had ? n.delete(id) : n.add(id)
    if (!had && !id.startsWith('combo:') && !consumption[id]) loadConsumption(id) // load consumed batches on expand
    return n
  })
  async function requestUncombine(m: Batch) {
    const reason = window.prompt(`Run ${m.batch_no} (${m.item_code} · qty ${m.total_quantity}) on its own, separate from the combined group?\n\nThis goes to Pending Changes for Head Office approval.\n\nReason (optional):`, '')
    if (reason === null) return
    setError(''); setSuccess('')
    const { error: insErr } = await supabase.from('split_requests').insert({
      kind: 'uncombine', batch_id: m.id, factory_code: m.factory_code,
      label: `Un-combine ${m.batch_no} · ${m.item_code} · qty ${m.total_quantity}`,
      reason: reason || null, requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    })
    if (insErr) { setError(insErr.message); alert('Could not request:\n\n' + insErr.message); return }
    setSuccess(`Requested to run ${m.batch_no} on its own — waiting for Head Office approval.`)
    alert(`Requested to run ${m.batch_no} on its own.\nGo to Pending Changes → Batch splits for Head Office to approve.`)
  }

  async function recombine(b: Batch) {
    if (!confirm(`Re-combine ${b.batch_no} back into its group for material picking?`)) return
    setError(''); setSuccess('')
    const { error: e } = await supabase.from('production_batches').update({ no_combine: false }).eq('id', b.id)
    if (e) { setError(e.message); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, no_combine: false } : x)))
    setSuccess(`${b.batch_no} re-combined.`)
  }

  // Save the pack plan (line + date) for a batch
  async function savePackPlan(b: Batch) {
    const e = packEdit[b.id] ?? { line: b.pack_line || '', date: b.pack_date || '', mode: b.run_mode || 'auto' }
    const mode = e.mode || b.run_mode || 'auto'
    setSavingPlan(b.id); setError(''); setSuccess('')
    const { error: upErr } = await supabase.from('production_batches').update({ pack_line: e.line || null, pack_date: e.date || null, run_mode: mode }).eq('id', b.id)
    if (upErr) { setError(upErr.message); setSavingPlan(''); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, pack_line: e.line || null, pack_date: e.date || null, run_mode: mode } : x)))
    setSavingPlan(''); setSuccess(`Pack plan saved for ${b.batch_no}.`)
  }

  async function requestSplit(b: Batch, it: BatchItem) {
    const reason = window.prompt(`Split "${it.customer_name}" (${it.so_number || ''} · qty ${it.quantity}) out of ${b.batch_no} into its own batch?\n\nThis goes to Pending Changes for Head Office approval.\n\nReason (optional):`, '')
    if (reason === null) return
    setError(''); setSuccess('')
    const { error: insErr } = await supabase.from('split_requests').insert({
      batch_item_id: it.id, batch_id: b.id, factory_code: b.factory_code,
      label: `${b.batch_no} · ${b.item_code} — ${it.customer_name}${it.so_number ? ' · ' + it.so_number : ''} · qty ${it.quantity}`,
      reason: reason || null, requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    })
    if (insErr) { setError(insErr.message); alert('Could not request split:\n\n' + insErr.message); return }
    setSuccess(`Split requested for ${it.customer_name} — waiting for Head Office approval.`)
    alert(`Split requested for ${it.customer_name}.\nGo to Pending Changes → Batch splits for Head Office to approve.`)
  }

  async function loadConsumption(batchId: string) {
    const { data } = await supabase.from('production_consumption')
      .select('id, item_code, description, batch_no, exp_date, qty_consumed, consumed_at')
      .eq('production_batch_id', batchId).order('consumed_at')
    setConsumption(prev => ({ ...prev, [batchId]: (data as ConsRow[]) || [] }))
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
  let shown = filter === 'All' ? batches : batches.filter(b => derivedStatus(b) === filter)
  if (fromTs !== null) shown = shown.filter(b => { const k = dateKey(b.delivery_date); return k !== Number.MAX_SAFE_INTEGER && k >= fromTs })
  if (toTs !== null) shown = shown.filter(b => { const k = dateKey(b.delivery_date); return k !== Number.MAX_SAFE_INTEGER && k <= toTs })
  if (isHO && factoryFilter) shown = shown.filter(b => b.factory_code === factoryFilter)
  const counts: Record<string, number> = { Planned: 0, Requested: 0, 'In Progress': 0, Completed: 0 }
  batches.forEach(b => { const st = derivedStatus(b); counts[st] = (counts[st] || 0) + 1 })

  const exploded = selected ? explode(selected.item_code, selected.factory_code, selected.total, selected.mode) : null
  const totalShortfall = exploded ? exploded.rows.reduce((s, r) => s + r.shortfall, 0) : 0
  const hasRequest = selected ? selected.batchIds.some(id => batches.find(b => b.id === id)?.material_request_id) : false

  // Sort comparator for batches within a factory
  const cmp = (a: Batch, b: Batch) => {
    if (sortBy === 'batch') return a.batch_no.localeCompare(b.batch_no)
    const d = dateKey(a.delivery_date) - dateKey(b.delivery_date)
    return sortBy === 'due_desc' ? -d : d
  }

  // Factories present in the current view (for the combined, factory-grouped layout)
  const factoriesInView = [...new Set(shown.map(b => b.factory_code))].sort()
  const singleTarget = (b: Batch): MatTarget => ({ label: b.batch_no, item_code: b.item_code, factory_code: b.factory_code, total: b.total_quantity, batchIds: [b.id], mode: b.run_mode || 'auto' })

  // Build display units for a factory's batches when Combine is on
  function buildUnits(fb: Batch[]) {
    const combinable = fb.filter(b => derivedStatus(b) === 'Planned' && !b.material_request_id && !b.no_combine)
    const byItem: Record<string, Batch[]> = {}
    combinable.forEach(b => { (byItem[b.item_code] = byItem[b.item_code] || []).push(b) })
    const combos = Object.values(byItem).filter(m => m.length >= 2)
    const comboIds = new Set(combos.flat().map(b => b.id))
    const singles = fb.filter(b => !comboIds.has(b.id))
    return { combos, singles }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Order Board</h1>
        <p className="text-gray-500 text-sm mb-5">
          Orders from confirmed sales orders. Once materials are received, plan which line packs each item and when.
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
          <span className="text-gray-500 ml-3">Sort:</span>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'due_asc' | 'due_desc' | 'batch')} className="border rounded-lg px-2 py-1 bg-white">
            <option value="due_asc">Due date (earliest)</option>
            <option value="due_desc">Due date (latest)</option>
            <option value="batch">Batch number</option>
          </select>
          {(dateFrom || dateTo || factoryFilter || filter !== 'All') && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setFactoryFilter(''); setFilter('All') }} className="text-blue-600 hover:underline ml-1">Clear filters</button>
          )}
        </div>

        <label className="flex items-center gap-2 mb-5 text-sm cursor-pointer w-fit">
          <input type="checkbox" checked={combineOn} onChange={e => setCombineOn(e.target.checked)} className="h-4 w-4" />
          <span className="text-gray-700 font-medium">Combine same item to run together</span>
          <span className="text-gray-400">(Planned batches not yet requested, grouped by factory)</span>
        </label>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No production batches{filter !== 'All' ? ` with status "${filter}"` : ''} yet.
            <br />Confirm a sales order document to generate production demand.
          </div>
        ) : (
          <div className="space-y-6">
            {factoriesInView.map(fc => {
              const fb = [...shown.filter(b => b.factory_code === fc)].sort(cmp)
              const { combos, singles } = buildUnits(fb)
              return (
                <div key={fc}>
                  {isHO && <h3 className="font-semibold text-sm text-gray-700 mb-2">🏭 {factoryName(fc)} <span className="text-gray-400 font-normal">· {fb.length} batch(es)</span></h3>}
                  <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="w-6"></th>
                          {['Batch', 'Item', 'Total qty', 'Delivery date', 'Status', ''].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {/* Combined units (only when Combine is on) */}
                        {combineOn && combos.map(members => {
                          const item = members[0].item_code
                          const key = `combo:${fc}:${item}`
                          const total = members.reduce((s, m) => s + m.total_quantity, 0)
                          const dates = [...new Set(members.map(m => m.delivery_date))]
                          const dateLabel = dates.length === 1 ? dates[0] : 'Multiple'
                          const target: MatTarget = { label: `${item} (combined ${members.length})`, item_code: item, factory_code: fc, total, batchIds: members.map(m => m.id), mode: members[0].run_mode || 'auto' }
                          return (
                            <Fragment key={key}>
                              <tr className={`border-b last:border-0 hover:bg-amber-50/40 cursor-pointer ${expanded.has(key) ? 'bg-amber-50/60' : 'bg-amber-50/20'}`} onClick={() => toggleRow(key)}>
                                <td className="pl-3 text-gray-400">{expanded.has(key) ? '▾' : '▸'}</td>
                                <td className="px-3 py-2 whitespace-nowrap"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-200 text-amber-800">Combined ×{members.length}</span></td>
                                <td className="px-3 py-2"><span className="font-medium">{item}</span><span className="block text-gray-500 text-xs">{members[0].description}</span>{bomBadge(item)}</td>
                                <td className="px-3 py-2 font-semibold whitespace-nowrap">{total}</td>
                                <td className="px-3 py-2 whitespace-nowrap">{dateLabel}</td>
                                <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Planned</span></td>
                                <td className="px-3 py-2 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                                  <button onClick={() => { setSelected(target); setError(''); setSuccess('') }} className="text-blue-600 hover:underline text-xs font-medium">Materials</button>
                                </td>
                              </tr>
                              {expanded.has(key) && (
                                <tr className="bg-amber-50/30 border-b last:border-0">
                                  <td></td>
                                  <td colSpan={6} className="px-3 py-3">
                                    <div className="text-gray-500 text-xs mb-2">{members.length} orders combined — remove any to produce it separately:</div>
                                    <div className="space-y-2 max-w-2xl">
                                      {members.map(m => (
                                        <div key={m.id} className="border rounded-lg bg-white p-2">
                                          <div className="flex justify-between items-center mb-1">
                                            <span className="text-xs"><span className="font-mono font-semibold">{m.batch_no}</span> · due {m.delivery_date || '—'} · qty <strong>{m.total_quantity}</strong></span>
                                            <button onClick={() => requestUncombine(m)}
                                              title="Request to run this batch on its own — Head Office must approve" className="text-red-600 hover:underline text-xs font-medium whitespace-nowrap">✕ Run on its own (needs approval)</button>
                                          </div>
                                          <ul className="space-y-0.5 pl-1">
                                            {m.production_batch_items?.map(it => (
                                              <li key={it.id} className="flex justify-between items-baseline gap-2 text-xs">
                                                <span className="text-gray-600 truncate min-w-0">{it.customer_name}</span>
                                                <span className="flex-shrink-0 flex items-baseline gap-2">
                                                  {it.so_number && <span className="text-gray-400 font-mono">{it.so_number}</span>}
                                                  <span className="font-medium">{it.quantity}</span>
                                                </span>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}

                        {/* Individual batches */}
                        {singles.map(b => (
                          <Fragment key={b.id}>
                            <tr className={`border-b last:border-0 hover:bg-gray-50 cursor-pointer ${expanded.has(b.id) ? 'bg-blue-50/40' : ''}`} onClick={() => toggleRow(b.id)}>
                              <td className="pl-3 text-gray-400">{expanded.has(b.id) ? '▾' : '▸'}</td>
                              <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                              <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span>{bomBadge(b.item_code)}{(b.pack_line || b.pack_date) && <span className="mt-0.5 inline-block bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded text-[11px] font-medium">📅 {b.pack_line || 'line ?'}{b.pack_date ? ` · ${b.pack_date.split('-').reverse().join('/')}` : ''}</span>}</td>
                              <td className="px-3 py-2 font-semibold whitespace-nowrap">{b.total_quantity}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{b.delivery_date || '—'}</td>
                              <td className="px-3 py-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[derivedStatus(b)] || 'bg-gray-100 text-gray-700'}`}>{derivedStatus(b)}</span>
                              </td>
                              <td className="px-3 py-2 text-right whitespace-nowrap">
                                {combineOn && b.no_combine && isHO && <button onClick={e => { e.stopPropagation(); recombine(b) }} className="text-blue-600 hover:underline text-xs mr-2">↩ Re-combine</button>}
                                {b.material_request_id && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">MR</span>}
                              </td>
                            </tr>
                            {expanded.has(b.id) && (
                              <tr className="bg-gray-50/60 border-b last:border-0">
                                <td></td>
                                <td colSpan={6} className="px-3 py-3">
                                  <div className="text-gray-400 text-xs mb-1">Per customer / order</div>
                                  <ul className="space-y-1 mb-3 max-w-lg">
                                    {b.production_batch_items?.map(it => (
                                      <li key={it.id} className="flex justify-between items-baseline gap-2">
                                        <span className="text-gray-700 truncate min-w-0">{it.customer_name}</span>
                                        <span className="flex-shrink-0 flex items-baseline gap-2">
                                          {it.so_number && <span className="text-gray-400 font-mono text-xs">{it.so_number}</span>}
                                          <span className="font-medium">{it.quantity}</span>
                                          {b.status === 'Planned' && !b.material_request_id && (b.production_batch_items?.length || 0) > 1 && (
                                            <button onClick={() => requestSplit(b, it)} title="Request to split this order into its own batch — Head Office must approve"
                                              className="text-red-600 hover:underline text-xs font-medium whitespace-nowrap">✕ Split (needs approval)</button>
                                          )}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                  <div className="flex flex-wrap items-end gap-3 mb-3 bg-teal-50/50 border border-teal-100 rounded-lg p-3">
                                    <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Pack line</span>
                                      <input value={packEdit[b.id]?.line ?? b.pack_line ?? ''} onChange={e => setPackEdit(p => ({ ...p, [b.id]: { line: e.target.value, date: p[b.id]?.date ?? b.pack_date ?? '', mode: p[b.id]?.mode ?? b.run_mode ?? 'auto' } }))} placeholder="e.g. Line 1" className="border rounded px-2 py-1 text-sm" /></div>
                                    <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Pack date</span>
                                      <input type="date" value={packEdit[b.id]?.date ?? b.pack_date ?? ''} onChange={e => setPackEdit(p => ({ ...p, [b.id]: { line: p[b.id]?.line ?? b.pack_line ?? '', date: e.target.value, mode: p[b.id]?.mode ?? b.run_mode ?? 'auto' } }))} className="border rounded px-2 py-1 text-sm" /></div>
                                    <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Run mode</span>
                                      <select value={packEdit[b.id]?.mode ?? b.run_mode ?? 'auto'} onChange={e => setPackEdit(p => ({ ...p, [b.id]: { line: p[b.id]?.line ?? b.pack_line ?? '', date: p[b.id]?.date ?? b.pack_date ?? '', mode: e.target.value } }))} className="border rounded px-2 py-1 text-sm bg-white">
                                        <option value="auto">Auto machine</option>
                                        <option value="manual">Manual</option>
                                      </select></div>
                                    <button onClick={() => savePackPlan(b)} disabled={savingPlan === b.id} className="bg-teal-600 text-white px-4 py-1.5 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">{savingPlan === b.id ? 'Saving…' : 'Save pack plan'}</button>
                                    <span className="text-gray-400 text-xs">line, date &amp; run mode (auto/manual)</span>
                                  </div>

                                  <button onClick={() => { setSelected(singleTarget(b)); setError(''); setSuccess('') }}
                                    className="border border-blue-600 text-blue-600 px-4 py-1.5 rounded-lg hover:bg-blue-50 text-sm font-medium">Materials</button>
                                  <a href={`/inspection?batch=${b.id}`}
                                    className="ml-2 border border-green-600 text-green-700 px-4 py-1.5 rounded-lg hover:bg-green-50 text-sm font-medium inline-block">📋 Inspection Record</a>

                                  <div className="mt-4 border-t pt-3">
                                    <div className="flex flex-wrap items-center gap-4 text-sm mb-2">
                                      <span className="text-gray-500">Planned: <strong className="text-gray-800">{b.total_quantity}</strong></span>
                                      <span className="text-gray-500">Produced: <strong className="text-green-700">{clean(b.produced_qty || 0)}</strong></span>
                                      <span className="text-gray-500">Backorder: <strong className={b.total_quantity - (b.produced_qty || 0) > 0 ? 'text-red-600' : 'text-green-600'}>{clean(Math.max(0, b.total_quantity - (b.produced_qty || 0)))}</strong></span>
                                    </div>
                                    <p className="text-gray-400 text-xs mb-3">Production is recorded in the <strong>Inspection Record</strong> (start/end + actual quantity produced). Recording there consumes raw materials (earliest expiry / oldest batch first) from {factoryName(b.factory_code)} stock.</p>
                                    {consumption[b.id] && consumption[b.id].length > 0 && (
                                      <div className="overflow-x-auto border rounded-lg bg-white max-w-3xl">
                                        <table className="w-full text-xs">
                                          <thead className="bg-gray-50 border-b">
                                            <tr>{['Material', 'Batch', 'Expiry', 'Consumed', 'When'].map(h => <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
                                          </thead>
                                          <tbody>
                                            {consumption[b.id].map(cn => (
                                              <tr key={cn.id} className="border-b last:border-0">
                                                <td className="px-3 py-1.5 font-mono">{cn.item_code}<span className="text-gray-400 font-sans ml-1">{cn.description}</span></td>
                                                <td className="px-3 py-1.5 font-mono">{cn.batch_no || '—'}</td>
                                                <td className="px-3 py-1.5">{cn.exp_date ? cn.exp_date.split('-').reverse().join('/') : '—'}</td>
                                                <td className="px-3 py-1.5 text-right font-semibold">{clean(cn.qty_consumed)}</td>
                                                <td className="px-3 py-1.5 text-gray-400 whitespace-nowrap">{new Date(cn.consumed_at).toLocaleDateString()}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {selected && exploded && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-4xl my-8 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-lg">Material requirements — <span className="font-mono">{selected.label}</span></h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
            </div>
            <p className="text-gray-500 text-sm mb-4">
              To make <strong>{selected.total}</strong> of {selected.item_code} at {isHO ? factoryName(selected.factory_code) : (selected.factory_code || 'this factory')}.
              {selected.batchIds.length > 1 && ` (combined from ${selected.batchIds.length} batches)`} Enter current stock to see the shortfall.
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
                            <input type="number" step="any" value={stock[r.key] ?? 0}
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

                <div className="flex flex-wrap items-end justify-between gap-3 mt-4">
                  <div className="text-sm">
                    {hasRequest
                      ? <span className="text-purple-700">A material request is already open — see Material Requests.</span>
                      : totalShortfall > 0
                        ? <span className="text-red-600">Total shortfall across {exploded.rows.filter(r => r.shortfall > 0).length} material(s).</span>
                        : <span className="text-green-600">Enough stock on hand — no shortfall.</span>}
                  </div>
                  <div className="flex items-end gap-3">
                    <label className="text-sm">
                      <span className="block text-gray-600 mb-1">Product expiry date <span className="text-red-500">*required</span></span>
                      <input type="date" value={expDate} min="2020-01-01" max="2100-12-31" onChange={e => setExpDate(e.target.value)}
                        className={`border rounded-lg px-2 py-1.5 ${!expDate && !hasRequest ? 'border-red-400 bg-red-50' : ''}`} />
                    </label>
                    <button onClick={() => raiseTarget(selected)} disabled={raising || hasRequest || totalShortfall <= 0 || !expDate}
                      className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                      {raising ? 'Raising…' : 'Raise Material Request'}
                    </button>
                  </div>
                </div>
                {!expDate && !hasRequest && totalShortfall > 0 && (
                  <p className="text-red-600 text-xs mt-2">Enter the product expiry date before raising — it prints on the labels.</p>
                )}
                <p className="text-gray-400 text-xs mt-2">Tip: save your stock figures first, then raise the request — it captures the shortfall at that moment and adds a safety margin (rounded up) so the warehouse picks enough.</p>
              </>
            )}
          </div>
          </div>
        )}
      </div>
    </div>
  )
}
