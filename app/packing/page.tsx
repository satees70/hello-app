'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, hasCap } from '@/lib/permissions'

interface PBItem { customer_name: string; quantity: number }
interface Batch {
  id: string
  batch_no: string
  item_code: string
  description: string
  factory_code: string
  total_quantity: number
  produced_qty: number
  material_request_id: string | null
  pack_line: string | null
  pack_date: string | null
  run_mode: string | null
  delivery_date: string | null
  production_batch_items: PBItem[]
}
interface PackLine { factory_code: string; name: string; active: boolean; line_mode: string | null }
interface Item { id: string; code: string; description: string; unit: string }
interface BomComp { parent_item_id: string; component_item_id: string; quantity: number; use_mode: string }

const STATUS_STYLE: Record<string, string> = {
  Planned: 'bg-blue-100 text-blue-700',
  Requested: 'bg-indigo-100 text-indigo-700',
  'In Progress': 'bg-amber-100 text-amber-700',
  Completed: 'bg-green-100 text-green-700',
}

export default function PackingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'packing')
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [packLines, setPackLines] = useState<PackLine[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [boms, setBoms] = useState<BomComp[]>([])
  const [stock, setStock] = useState<Record<string, number>>({}) // item_id|factory -> qty
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })() // local date (not UTC)
  const [date, setDate] = useState(today)
  const [factoryFilter, setFactoryFilter] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [packEdit, setPackEdit] = useState<Record<string, { line: string; date: string; mode: string }>>({})
  const [collapsedFacs, setCollapsedFacs] = useState<Set<string>>(new Set())
  const toggleFac = (fc: string) => setCollapsedFacs(p => { const n = new Set(p); n.has(fc) ? n.delete(fc) : n.add(fc); return n })
  const [openMat, setOpenMat] = useState<Set<string>>(new Set())
  const toggleMat = (id: string) => setOpenMat(p => { const x = new Set(p); x.has(id) ? x.delete(id) : x.add(id); return x })
  const [savingId, setSavingId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const multiFac = isHO || (profile?.factory_codes?.length || 0) > 1   // sees more than one factory
  const canEdit = can(profile, 'packing', 'edit')
  const canEditFac = (fc: string) => can(profile, 'packing', 'edit', fc)   // honours per-factory view-only

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, material_request_id, pack_line, pack_date, run_mode, delivery_date, production_batch_items(customer_name, quantity)')
      .order('delivery_date')
    setBatches((data as Batch[]) || [])
    const { data: pl } = await supabase.from('packing_lines').select('factory_code, name, active, line_mode').order('name')
    setPackLines((pl as PackLine[]) || [])
    setItems(await fetchAll<Item>('items', 'id, code, description, unit'))
    setBoms(await fetchAll<BomComp>('bom_components', 'parent_item_id, component_item_id, quantity, use_mode'))
    const { data: st } = await supabase.from('item_stock').select('item_id, factory_code, quantity')
    const sm: Record<string, number> = {}; (st || []).forEach(r => { sm[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setStock(sm)
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const status = (b: Batch) => {
    const p = Number(b.produced_qty || 0)
    if (p >= b.total_quantity && b.total_quantity > 0) return 'Completed'
    if (p > 0) return 'In Progress'
    if (b.material_request_id) return 'Requested'
    return 'Planned'
  }
  const n = (x: number) => Number(Number(x).toPrecision(12))
  const itemOf = (id: string) => items.find(i => i.id === id)
  // How many units we can make from current system stock, plus the per-material breakdown.
  const availability = (b: Batch): { hasBom: boolean; units: number; comps: { code: string; description: string; unit: string; required: number; avail: number; shortfall: number }[] } => {
    const parent = items.find(i => i.code === b.item_code)
    if (!parent) return { hasBom: false, units: 0, comps: [] }
    const mode = b.run_mode || 'auto'
    const comps0 = boms.filter(c => c.parent_item_id === parent.id && ((c.use_mode || 'any') === 'any' || (c.use_mode || 'any') === mode))
    if (comps0.length === 0) return { hasBom: false, units: 0, comps: [] }
    let units = Infinity
    const comps = comps0.map(c => {
      const ci = itemOf(c.component_item_id)
      const avail = stock[`${c.component_item_id}|${b.factory_code}`] ?? 0
      const per = Number(c.quantity) || 0
      if (per > 0) units = Math.min(units, Math.floor(avail / per))
      const required = per * b.total_quantity
      return { code: ci?.code || '—', description: ci?.description || '', unit: ci?.unit || '', required, avail, shortfall: Math.max(required - avail, 0) }
    })
    return { hasBom: true, units: units === Infinity ? b.total_quantity : units, comps }
  }
  // Ready only when we can make at least one unit from real stock. No BOM = can't confirm = waiting.
  const materialsReady = (b: Batch) => availability(b).units >= 1
  const partial = (b: Batch) => { const a = availability(b); return a.units >= 1 && a.units < b.total_quantity }
  const waitReason = (b: Batch) => {
    const a = availability(b)
    if (!a.hasBom) return 'No BOM set — add a recipe first'
    const short = a.comps.filter(c => c.shortfall > 0)
    return short.length ? 'Short: ' + short.map(c => `${c.code} (${n(c.avail)}/${n(c.required)})`).join(', ') : 'Not enough material in stock'
  }
  // The material table for a batch — same columns as the Order Board popup
  const MaterialTable = ({ b }: { b: Batch }) => {
    const a = availability(b)
    if (!a.hasBom) return <p className="text-amber-600 text-xs">No BOM defined for this item — add a recipe in BOM first.</p>
    return (
      <div className="overflow-x-auto border rounded-lg max-w-3xl">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b">
            <tr>{['Material', 'Description', 'Unit', 'Required', 'Stock (system)', 'Shortfall'].map(h => (
              <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
          </thead>
          <tbody>
            {a.comps.map(c => (
              <tr key={c.code} className={`border-b last:border-0 ${c.shortfall > 0 ? '' : 'bg-green-50/40'}`}>
                <td className="px-3 py-1.5 font-mono font-medium whitespace-nowrap">{c.code}</td>
                <td className="px-3 py-1.5 text-gray-600">{c.description}</td>
                <td className="px-3 py-1.5 text-gray-500">{c.unit}</td>
                <td className="px-3 py-1.5 text-right">{n(c.required)}</td>
                <td className="px-3 py-1.5 text-right font-medium">{n(c.avail)}</td>
                <td className={`px-3 py-1.5 text-right font-semibold ${c.shortfall > 0 ? 'text-red-600' : 'text-green-600'}`}>{n(c.shortfall)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  async function savePack(b: Batch) {
    if (!canEditFac(b.factory_code)) { setError('You have view-only access at this factory.'); return }
    const e = packEdit[b.id] ?? { line: b.pack_line || '', date: b.pack_date || '', mode: b.run_mode || 'auto' }
    if (!e.line || !e.date) { setError('Pick a pack line and a pack date first.'); return }
    setSavingId(b.id); setError(''); setSuccess('')
    // run mode is decided at the material stage — not changed here
    const { error: upErr } = await supabase.from('production_batches').update({ pack_line: e.line, pack_date: e.date }).eq('id', b.id)
    if (upErr) { setError(upErr.message); setSavingId(''); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, pack_line: e.line, pack_date: e.date } : x)))
    setSavingId(''); setSuccess(`${b.batch_no} scheduled to ${e.line} on ${e.date.split('-').reverse().join('/')}.`)
  }

  async function requestRunModeChange(b: Batch) {
    const to = (b.run_mode || 'auto') === 'auto' ? 'manual' : 'auto'
    const reason = window.prompt(`Change ${b.batch_no} run mode from ${b.run_mode === 'manual' ? 'Manual' : 'Auto'} to ${to === 'manual' ? 'Manual' : 'Auto'}?\n\nThis changes the materials needed (roll vs pieces) and goes to Head Office for approval — on approval the open material request is recalculated.\n\nReason (optional):`, '')
    if (reason === null) return
    setError(''); setSuccess('')
    const { error: insErr } = await supabase.from('run_mode_requests').insert({
      batch_id: b.id, factory_code: b.factory_code, batch_no: b.batch_no, item_code: b.item_code,
      from_mode: b.run_mode || 'auto', to_mode: to, reason: reason || null,
      requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    })
    if (insErr) { setError(insErr.message); alert('Could not request:\n\n' + insErr.message); return }
    setSuccess(`Run-mode change requested for ${b.batch_no} — waiting for Head Office approval.`)
    alert(`Requested to change ${b.batch_no} to ${to === 'manual' ? 'Manual' : 'Auto'}.\nGo to Pending Changes for Head Office to approve.`)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const fmtDate = (d: string) => d.split('-').reverse().join('/')
  const facFilter = (b: Batch) => !factoryFilter || b.factory_code === factoryFilter

  // Unscheduled, still-to-produce batches split by whether materials are in
  const unscheduled = batches.filter(b => !b.pack_date && status(b) !== 'Completed' && facFilter(b))
  const readyToPack = unscheduled.filter(materialsReady)
  const waiting = unscheduled.filter(b => !materialsReady(b))

  // The day schedule (existing) — scheduled batches on the chosen date
  let shown = batches.filter(b => b.pack_date === date && facFilter(b))
  if (hideDone) shown = shown.filter(b => status(b) !== 'Completed')
  const byFactory: Record<string, Record<string, Batch[]>> = {}
  shown.forEach(b => {
    const f = (byFactory[b.factory_code] = byFactory[b.factory_code] || {})
    const line = b.pack_line || '(no line set)'
    ;(f[line] = f[line] || []).push(b)
  })
  const facs = Object.keys(byFactory).sort()

  function PackForm({ b }: { b: Batch }) {
    const cur = packEdit[b.id]?.line ?? b.pack_line ?? ''
    const bMode = b.run_mode || 'auto'
    const opts = packLines.filter(p => p.factory_code === b.factory_code && (p.active || p.name === cur) && (!p.line_mode || p.line_mode === 'any' || p.line_mode === bMode || p.name === cur)).map(p => p.name)
    const setField = (patch: Partial<{ line: string; date: string; mode: string }>) =>
      setPackEdit(p => ({ ...p, [b.id]: { line: p[b.id]?.line ?? b.pack_line ?? '', date: p[b.id]?.date ?? b.pack_date ?? today, mode: p[b.id]?.mode ?? b.run_mode ?? 'auto', ...patch } }))
    return (
      <div className="flex flex-wrap items-end gap-2 justify-end">
        <select value={cur} onChange={e => setField({ line: e.target.value })} className="border rounded px-2 py-1 text-xs bg-white min-w-[110px]">
          <option value="">— Line —</option>
          {opts.map(n => <option key={n} value={n}>{n}</option>)}
          {opts.length === 0 && <option value="" disabled>Add in Setup → Packing Lines</option>}
        </select>
        <input type="date" value={packEdit[b.id]?.date ?? b.pack_date ?? today} onChange={e => setField({ date: e.target.value })} className="border rounded px-2 py-1 text-xs" />
        <div className="flex flex-col items-start text-xs">
          <span className="px-2 py-1 rounded bg-gray-100 text-gray-700 whitespace-nowrap">{(b.run_mode || 'auto') === 'manual' ? 'Manual' : 'Auto'}</span>
          {hasCap(profile, 'request_run_mode') && <button type="button" onClick={() => requestRunModeChange(b)} className="text-blue-600 hover:underline mt-0.5 whitespace-nowrap">change (needs approval)</button>}
        </div>
        <button onClick={() => savePack(b)} disabled={savingId === b.id} className="bg-teal-600 text-white px-3 py-1 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-xs font-medium">{savingId === b.id ? 'Saving…' : 'Schedule'}</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Packing Schedule</h1>
        <p className="text-gray-500 text-sm mb-5">Schedule a batch to a pack line &amp; date once its materials are received, then open the Packing &amp; Finished Goods Inspection Record to record production.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {multiFac && (
          <div className="flex flex-wrap gap-2 items-center mb-5 text-sm">
            <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
              <option value="">All factories</option>
              {(isHO ? factories : factories.filter(f => (profile.factory_codes || [profile.factory_code]).includes(f.code))).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
            </select>
          </div>
        )}

        {/* Ready to pack — materials received, not yet scheduled */}
        <h2 className="font-semibold text-gray-800 mb-2">✅ Ready to pack <span className="text-gray-400 font-normal text-sm">· {readyToPack.length} waiting to schedule</span></h2>
        {/* Mobile: cards */}
        <div className="md:hidden space-y-3 mb-6">
          {readyToPack.length === 0 && <p className="text-center py-6 text-gray-400 border rounded-lg bg-white text-sm">No batches with materials ready.</p>}
          {readyToPack.map(b => (
            <div key={`mr|${b.id}`} className="bg-white rounded-xl shadow-sm border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-semibold">{b.batch_no}{partial(b) && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700">make {availability(b).units} now</span>}</span>
                {isHO && <span className="text-xs text-gray-500">{factoryName(b.factory_code)}</span>}
              </div>
              <div className="mt-1"><span className="font-medium">{b.item_code}</span> <span className="text-gray-500 text-sm">×{b.total_quantity}</span><span className="block text-gray-500 text-xs">{b.description}</span></div>
              <button onClick={() => toggleMat(b.id)} className="text-blue-600 hover:underline text-xs mt-1">{openMat.has(b.id) ? '▾ hide materials' : '▸ show materials'}</button>
              {openMat.has(b.id) && <div className="mt-2"><MaterialTable b={b} /></div>}
              <div className="mt-3 pt-2 border-t">{canEditFac(b.factory_code) ? <PackForm b={b} /> : <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${partial(b) ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{partial(b) ? `Enough for ${availability(b).units}` : 'Materials ready'}</span>}</div>
            </div>
          ))}
        </div>
        {/* Desktop: table */}
        <div className="hidden md:block bg-white rounded-xl shadow-sm border overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{[...(multiFac ? ['Factory'] : []), 'Batch', 'Item', 'Qty', 'Delivery', canEdit ? 'Schedule to' : 'Status'].map(h => (
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {readyToPack.length === 0 && <tr><td colSpan={multiFac ? 6 : 5} className="text-center py-6 text-gray-400">No batches with materials ready. They appear here once a batch has a BOM and enough stock to make at least one unit.</td></tr>}
              {readyToPack.map(b => (
                <Fragment key={b.id}>
                  <tr className="border-b last:border-0 hover:bg-gray-50">
                    {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(b.factory_code)}</td>}
                    <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}{partial(b) && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 align-middle">make {availability(b).units} now</span>}</td>
                    <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span>
                      <button onClick={() => toggleMat(b.id)} className="text-blue-600 hover:underline text-xs mt-0.5">{openMat.has(b.id) ? '▾ hide materials' : '▸ show materials'}</button></td>
                    <td className="px-3 py-2 text-right font-semibold">{b.total_quantity}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? fmtDate(b.delivery_date) : '—'}</td>
                    <td className="px-3 py-2">{canEditFac(b.factory_code) ? <PackForm b={b} /> : <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${partial(b) ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{partial(b) ? `Enough for ${availability(b).units}` : 'Materials ready'}</span>}</td>
                  </tr>
                  {openMat.has(b.id) && (
                    <tr className="bg-gray-50/60 border-b"><td colSpan={multiFac ? 6 : 5} className="px-3 py-3">
                      <div className="text-gray-500 text-xs mb-1">To make <strong>{b.total_quantity}</strong> of {b.item_code} at {factoryName(b.factory_code)} — stock is the live system on-hand.</div>
                      <MaterialTable b={b} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Waiting for materials — cannot be scheduled yet */}
        <h2 className="font-semibold text-gray-800 mb-2">⏳ Waiting for materials <span className="text-gray-400 font-normal text-sm">· {waiting.length}</span></h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mb-8">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{[...(multiFac ? ['Factory'] : []), 'Batch', 'Item', 'Qty', 'Delivery', 'Why not yet'].map(h => (
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {waiting.length === 0 && <tr><td colSpan={multiFac ? 6 : 5} className="text-center py-6 text-gray-400">Nothing waiting — every planned batch has its materials.</td></tr>}
              {waiting.map(b => (
                <Fragment key={b.id}>
                  <tr className="border-b last:border-0 hover:bg-gray-50">
                    {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(b.factory_code)}</td>}
                    <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                    <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span>
                      <button onClick={() => toggleMat(b.id)} className="text-blue-600 hover:underline text-xs mt-0.5">{openMat.has(b.id) ? '▾ hide materials' : '▸ show materials'}</button></td>
                    <td className="px-3 py-2 text-right font-semibold">{b.total_quantity}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? fmtDate(b.delivery_date) : '—'}</td>
                    <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{waitReason(b)}</span></td>
                  </tr>
                  {openMat.has(b.id) && (
                    <tr className="bg-gray-50/60 border-b"><td colSpan={multiFac ? 6 : 5} className="px-3 py-3">
                      <div className="text-gray-500 text-xs mb-1">To make <strong>{b.total_quantity}</strong> of {b.item_code} at {factoryName(b.factory_code)} — stock is the live system on-hand.</div>
                      <MaterialTable b={b} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Scheduled — what each line packs on the chosen day */}
        <h2 className="font-semibold text-gray-800 mb-2">📅 Scheduled to pack</h2>
        <div className="flex flex-wrap gap-2 items-center mb-4 text-sm">
          <span className="text-gray-500">Pack date:</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
          <button onClick={() => setDate(today)} className="text-blue-600 hover:underline">Today</button>
          <label className="flex items-center gap-2 cursor-pointer ml-2"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} className="h-4 w-4" /><span className="text-gray-700">Hide completed</span></label>
        </div>

        {facs.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            Nothing scheduled to pack on {fmtDate(date)}.
            <br />Schedule a batch from “Ready to pack” above.
          </div>
        ) : (
          <div className="space-y-6">
            {facs.map(fc => (
              <div key={fc}>
                {(isHO || facs.length > 1) && <button onClick={() => toggleFac(fc)} className="flex items-center gap-1 font-semibold text-gray-700 mb-2 hover:text-gray-900"><span className="text-gray-400 w-3 inline-block">{collapsedFacs.has(fc) ? '▸' : '▾'}</span> 🏭 {factoryName(fc)}</button>}
                {!collapsedFacs.has(fc) && <div className="space-y-4">
                  {Object.keys(byFactory[fc]).sort().map(line => (
                    <div key={line} className="bg-white rounded-xl shadow-sm border p-4">
                      <div className="font-semibold mb-2">📅 {fmtDate(date)} · <span className="text-teal-700">{line}</span> <span className="text-gray-400 font-normal text-sm">· {byFactory[fc][line].length} item(s)</span></div>
                      <div className="overflow-x-auto border rounded-lg">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b">
                            <tr>{['Batch', 'Item', 'To pack', 'Produced', 'Backorder', 'Status', ''].map(h => (
                              <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                          </thead>
                          <tbody>
                            {byFactory[fc][line].map(b => {
                              const backorder = Math.max(0, b.total_quantity - (b.produced_qty || 0))
                              return (
                                <tr key={b.id} className="border-b last:border-0">
                                  <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                                  <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span></td>
                                  <td className="px-3 py-2 text-right font-semibold">{b.total_quantity}</td>
                                  <td className="px-3 py-2 text-right text-green-700">{b.produced_qty || 0}</td>
                                  <td className={`px-3 py-2 text-right font-semibold ${backorder > 0 ? 'text-red-600' : 'text-green-600'}`}>{backorder}</td>
                                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[status(b)] || 'bg-gray-100 text-gray-700'}`}>{status(b)}</span></td>
                                  <td className="px-3 py-2 whitespace-nowrap text-right">
                                    <a href={`/inspection?batch=${b.id}`} className="border border-green-600 text-green-700 px-3 py-1 rounded-lg hover:bg-green-50 text-xs font-medium">📋 Packing &amp; Finished Goods Inspection Record</a>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
