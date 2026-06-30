'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, hasCap } from '@/lib/permissions'

interface Item { id: string; code: string; description: string; unit: string }
interface Lot { id: string; item_code: string; factory_code: string; batch_no: string | null; exp_date: string | null; qty_remaining: number }
interface Batch {
  id: string; batch_no: string | null; item_code: string; description: string | null
  factory_code: string; total_quantity: number; produced_qty: number | null
  dispatched_at: string | null; delivery_date: string | null
}
interface DOrder {
  id: string; do_number: string | null; factory_code: string; status: string
  created_by_name: string | null; created_at: string
  dispatch_order_lines?: { item_code: string; description: string | null; quantity: number }[]
  material_returns?: { item_code: string; description: string | null; quantity: number; batch_no: string | null }[]
}
interface CartReturn { lotId: string; itemCode: string; description: string; unit: string; batchNo: string | null; qty: number; reason: string; factory: string; factoryName: string; manual?: boolean }
interface SLine { id: string; so_number: string; item_code: string; description: string | null; quantity: number | null; outstanding_qty: number | null; factory_code: string; delivered_qty: number | null }
interface MReturn {
  id: string; factory_code: string; item_code: string; description: string | null
  batch_no: string | null; quantity: number; reason: string | null; created_by_name: string | null; created_at: string
}

export default function DispatchPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'dispatch')
  const [items, setItems] = useState<Item[]>([])
  const [lots, setLots] = useState<Lot[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [onHand, setOnHand] = useState<Record<string, number>>({})
  const [batches, setBatches] = useState<Batch[]>([])
  const [orders, setOrders] = useState<DOrder[]>([])
  const [returns, setReturns] = useState<MReturn[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleFac = (fc: string) => setCollapsed(p => { const n = new Set(p); n.has(fc) ? n.delete(fc) : n.add(fc); return n })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'dispatch', 'edit')

  // return form
  const [factory, setFactory] = useState('')
  const [code, setCode] = useState('')
  const [lotId, setLotId] = useState('')
  const [manual, setManual] = useState(false)   // type an item not in stock
  const [manBatch, setManBatch] = useState('')   // manual batch no (optional)
  const [qty, setQty] = useState('')
  const [issue, setIssue] = useState<'no' | 'yes'>('no')
  const [reason, setReason] = useState('')
  const [returnCart, setReturnCart] = useState<CartReturn[]>([])
  const [salesLines, setSalesLines] = useState<SLine[]>([])
  const [directCart, setDirectCart] = useState<{ lineId: string; so: string; itemCode: string; description: string; qty: number; batchNo: string; expDate: string; factory: string; factoryName: string }[]>([])
  const [dSo, setDSo] = useState('')
  const [dLineId, setDLineId] = useState('')
  const [dQty, setDQty] = useState('')
  const [dBatch, setDBatch] = useState('')
  const [dExp, setDExp] = useState('')
  // Edit-a-return modal (needs HO approval)
  const [editRet, setEditRet] = useState<MReturn | null>(null)
  const [editQty, setEditQty] = useState('')
  const [editNewReason, setEditNewReason] = useState('')
  const [editWhy, setEditWhy] = useState('')
  const [editPending, setEditPending] = useState<Set<string>>(new Set())

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    setItems(await fetchAll<Item>('items', 'id, code, description, unit', 'code'))
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    // Default to the first factory the user may actually act on (edit) at.
    const codes = profile?.factory_codes?.length ? profile.factory_codes : [profile?.factory_code || '']
    const editable = (f || []).filter(x => isHO || (codes.includes(x.code) && can(profile, 'dispatch', 'edit', x.code)))
    if (!isHO) setFactory(editable[0]?.code || '')
    else if (f && f.length && !factory) setFactory(f[0].code)
    const { data: st } = await supabase.from('item_stock').select('item_id, factory_code, quantity')
    const m: Record<string, number> = {}; (st || []).forEach(r => { m[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setOnHand(m)
    const { data: lt } = await supabase.from('stock_lots').select('id, item_code, factory_code, batch_no, exp_date, qty_remaining')
      .gt('qty_remaining', 0).order('exp_date', { ascending: true, nullsFirst: false }).order('received_at', { ascending: true })
    setLots((lt as Lot[]) || [])
    const { data: b } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, dispatched_at, delivery_date')
      .is('dispatched_at', null).gt('produced_qty', 0).order('delivery_date')
    setBatches((b as Batch[]) || [])
    const { data: o } = await supabase.from('dispatch_orders')
      .select('id, do_number, factory_code, status, created_by_name, created_at, dispatch_order_lines(item_code, description, quantity), material_returns(item_code, description, quantity, batch_no)')
      .order('created_at', { ascending: false }).limit(50)
    setOrders((o as DOrder[]) || [])
    const { data: r } = await supabase.from('material_returns').select('*').order('created_at', { ascending: false }).limit(50)
    setReturns((r as MReturn[]) || [])
    const { data: pe } = await supabase.from('return_edit_requests').select('return_id').eq('status', 'Pending')
    setEditPending(new Set((pe || []).map(x => x.return_id).filter(Boolean)))
    // Sales-order lines (for direct delivery). Limit to the factories the user can act on.
    const facCodes = isHO ? null : codes
    const sLines: SLine[] = []
    for (let from = 0; ; from += 1000) {
      let q = supabase.from('sales_order_lines').select('id, so_number, item_code, description, quantity, outstanding_qty, factory_code, delivered_qty')
      if (facCodes) q = q.in('factory_code', facCodes)
      const { data: sl } = await q.range(from, from + 999)
      const page = (sl as SLine[]) || []
      sLines.push(...page)
      if (page.length < 1000) break
    }
    setSalesLines(sLines)
  }

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'
  const status = (b: Batch) => (Number(b.produced_qty || 0) >= b.total_quantity && b.total_quantity > 0) ? 'Completed' : 'In Progress'
  const resolve = (c: string) => items.find(i => i.code.toLowerCase() === c.trim().toLowerCase())
  const item = resolve(code)
  const inStock = items.filter(i => (onHand[`${i.id}|${factory}`] ?? 0) > 0)
  const itemLots = item ? lots.filter(l => l.item_code === item.code && l.factory_code === factory) : []
  const lot = itemLots.find(l => l.id === lotId)
  const onHandQty = lot ? lot.qty_remaining : (item ? (onHand[`${item.id}|${factory}`] ?? 0) : null)
  const fmtD = (d: string | null) => d ? d.split('-').reverse().join('/') : 'no expiry'

  const toggle = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  const cartFactories = new Set<string>([...batches.filter(b => picked.has(b.id)).map(b => b.factory_code), ...returnCart.map(r => r.factory)])
  const cartCount = picked.size + returnCart.length

  // Add a raw-material return to the delivery-order cart (stock isn't reduced until the DO is created).
  function addReturn(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setSuccess('')
    const num = Number(qty)
    if (!(num > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (issue === 'yes' && !reason.trim()) { setError('Please give the reason for the issue.'); return }
    const note = issue === 'yes' ? reason.trim() : ''
    if (manual) {
      // Item not in stock — keyed in by hand. No batch check (there's no lot in the system).
      const mc = code.trim()
      if (!mc) { setError('Pick an item from the list.'); return }
      const known = resolve(mc)
      setReturnCart(c => [...c, { lotId: '', itemCode: known?.code || mc.toUpperCase(), description: known?.description || '', unit: known?.unit || '', batchNo: manBatch.trim() || null, qty: num, reason: note, factory, factoryName: factoryName(factory), manual: true }])
      setCode(''); setManBatch(''); setQty(''); setIssue('no'); setReason('')
      return
    }
    const it = resolve(code)
    if (!it) { setError('Pick a valid raw-material code from the list.'); return }
    if (!lot) { setError('Pick the batch you are returning.'); return }
    const already = returnCart.filter(r => r.lotId === lot.id).reduce((s, r) => s + r.qty, 0)
    if (already + num > lot.qty_remaining) { setError(`Batch ${lot.batch_no || '—'} only has ${lot.qty_remaining} ${it.unit} left${already ? ` (you already added ${already})` : ''}.`); return }
    setReturnCart(c => [...c, { lotId: lot.id, itemCode: it.code, description: it.description, unit: it.unit, batchNo: lot.batch_no, qty: num, reason: note, factory, factoryName: factoryName(factory) }])
    setCode(''); setLotId(''); setQty(''); setIssue('no'); setReason('')
  }

  // ---- Direct delivery from a sales order (bypass production) ----
  const remainingOf = (l: SLine) => Math.max(0, Number(l.outstanding_qty ?? l.quantity ?? 0) - Number(l.delivered_qty || 0))
  const openSOs = [...new Set(salesLines.filter(remainingOf).map(l => l.so_number))].sort()
  const linesForSO = salesLines.filter(l => l.so_number === dSo && remainingOf(l) > 0)
  function addDirect(e: React.FormEvent) {
    e.preventDefault(); setError(''); setSuccess('')
    const line = salesLines.find(l => l.id === dLineId)
    if (!line) { setError('Pick a sales-order item line.'); return }
    if (!line.factory_code) { setError('This line has no factory/location set — set it on the Sales Orders page first.'); return }
    const n = Number(dQty)
    if (!(n > 0)) { setError('Enter a quantity greater than zero.'); return }
    const left = remainingOf(line) - directCart.filter(c => c.lineId === line.id).reduce((s, c) => s + c.qty, 0)
    if (n > left) { setError(`Only ${left} left to deliver on this line.`); return }
    setDirectCart(c => [...c, { lineId: line.id, so: line.so_number, itemCode: line.item_code, description: line.description || '', qty: n, batchNo: dBatch.trim(), expDate: dExp, factory: line.factory_code, factoryName: factoryName(line.factory_code) }])
    setDLineId(''); setDQty(''); setDBatch(''); setDExp('')
  }
  async function createDirect() {
    if (directCart.length === 0) return
    if (!confirm(`Deliver ${directCart.length} item(s) directly to the warehouse (bypassing production)?`)) return
    setBusy(true); setError(''); setSuccess('')
    const facs = [...new Set(directCart.map(c => c.factory))]
    const dos: string[] = []
    for (const fac of facs) {
      const lines = directCart.filter(c => c.factory === fac).map(c => ({ line_id: c.lineId, qty: c.qty, batch_no: c.batchNo || null, exp_date: c.expDate || null }))
      const { data, error: e } = await supabase.rpc('create_direct_delivery', { p_lines: lines })
      if (e) { setError(e.message); setBusy(false); return }
      dos.push(data as string)
    }
    setSuccess(`Direct delivery created — ${dos.join(', ')}.`)
    setDirectCart([]); setBusy(false); load()
  }

  // Create ONE delivery order for a single factory's items (finished goods + returns).
  // A multi-factory user builds a mixed cart; each factory gets its own DO.
  async function createDO(fac: string) {
    const batchIds = batches.filter(b => picked.has(b.id) && b.factory_code === fac).map(b => b.id)
    const facReturns = returnCart.filter(r => r.factory === fac)
    const count = batchIds.length + facReturns.length
    if (count === 0) return
    if (!confirm(`Create a delivery order for ${factoryName(fac)} with ${count} item(s) and send to the warehouse?`)) return
    setBusy(true); setError(''); setSuccess('')
    const { data, error: e } = await supabase.rpc('create_delivery_order', {
      p_batch_ids: batchIds,
      p_returns: facReturns.map(r => r.manual
        ? { manual: true, item_code: r.itemCode, description: r.description, batch_no: r.batchNo, qty: r.qty, reason: r.reason, factory_code: r.factory }
        : { lot_id: r.lotId, qty: r.qty, reason: r.reason }),
    })
    if (e) { setError(e.message); setBusy(false); return }
    setSuccess(`Delivery order ${data} created — ${count} item(s) sent to warehouse.`)
    // Clear only this factory's items; keep the rest of the cart for its own DO.
    setPicked(p => { const n = new Set(p); batchIds.forEach(id => n.delete(id)); return n })
    setReturnCart(c => c.filter(r => r.factory !== fac))
    setBusy(false); load()
  }

  function openRetEdit(r: MReturn) {
    setEditRet(r); setEditQty(String(r.quantity)); setEditNewReason(r.reason || ''); setEditWhy(''); setError(''); setSuccess('')
  }
  // Request an edit to a past return (qty/reason). HO approval applies the stock change.
  async function submitRetEdit() {
    if (!editRet || !profile) return
    const nq = Number(editQty)
    if (!(nq > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (!editWhy.trim()) { setError('Please give a reason for the edit.'); return }
    setBusy(true); setError(''); setSuccess('')
    const { data, error: e } = await supabase.from('return_edit_requests').insert({
      return_id: editRet.id, factory_code: editRet.factory_code, item_code: editRet.item_code, batch_no: editRet.batch_no,
      old_qty: editRet.quantity, new_qty: nq, old_reason: editRet.reason, new_reason: editNewReason.trim() || null,
      reason: editWhy.trim(), requested_by: profile.id, requested_by_name: profile.full_name || null,
    }).select('id').single()
    if (e || !data) { setError(e?.message || 'Could not send request'); setBusy(false); return }
    // Head Office applies immediately; others wait for approval.
    if (isHO) {
      const { error: apErr } = await supabase.rpc('approve_return_edit', { p_id: data.id })
      if (apErr) { setError(`Saved, but could not apply: ${apErr.message}`); setBusy(false); setEditRet(null); load(); return }
    }
    setBusy(false); setEditRet(null)
    setSuccess(isHO ? 'Return updated — stock adjusted.' : 'Edit request sent to Head Office for approval.')
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const myCodes = profile.factory_codes && profile.factory_codes.length ? profile.factory_codes : [profile.factory_code]
  const canFac = (fc: string) => can(profile, 'dispatch', 'edit', fc)   // honours per-factory view-only
  const myFactories = isHO ? factories : factories.filter(f => myCodes.includes(f.code) && canFac(f.code))
  const facList = [...new Set(batches.map(b => b.factory_code))]
  const multiFac = isHO || facList.length > 1

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Delivery Orders</h1>
        <p className="text-gray-500 text-sm mb-5">Tick finished goods and/or add raw-material returns, then create one delivery order to the warehouse.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {/* ---- Finished goods to deliver ---- */}
        <h2 className="text-lg font-semibold mb-2">Finished goods ready to send</h2>

        {/* mobile cards */}
        <div className="md:hidden space-y-2 mb-8">
          {batches.length === 0 && <p className="text-gray-400 text-sm bg-white border rounded-xl p-6 text-center">Nothing produced yet to send.</p>}
          {batches.map(b => (
            <label key={b.id} className="flex gap-3 bg-white border rounded-xl p-3 shadow-sm">
              {canEdit && canFac(b.factory_code) && <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} className="mt-1 h-4 w-4" />}
              <div className="flex-1 text-sm">
                <div className="font-mono font-medium">{b.item_code}</div>
                <div className="text-gray-500">{b.description}</div>
                <div className="text-gray-500 mt-1">Qty: <strong>{b.produced_qty}</strong> · <span className={status(b) === 'Completed' ? 'text-green-700' : 'text-amber-600'}>{status(b)}</span></div>
                <div className="text-gray-400 text-xs mt-0.5">{b.batch_no || '—'}{multiFac ? ` · ${factoryName(b.factory_code)}` : ''}</div>
              </div>
            </label>
          ))}
        </div>

        {/* desktop table */}
        <div className="hidden md:block bg-white rounded-xl shadow-sm border overflow-auto max-h-[24rem] mb-8">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['', 'Item', 'Batch', 'Produced', 'Status', ...(multiFac ? ['Factory'] : []), 'Delivery date'].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">Nothing produced yet to send.</td></tr>}
              {facList.map(fc => (
                <Fragment key={fc}>
                  {multiFac && (
                    <tr className="bg-gray-50 border-b cursor-pointer hover:bg-gray-100" onClick={() => toggleFac(fc)}>
                      <td colSpan={7} className="px-3 py-1.5 font-semibold text-gray-700"><span className="text-gray-400 mr-1">{collapsed.has(fc) ? '▸' : '▾'}</span>🏭 {factoryName(fc)} <span className="text-gray-400 font-normal">· {batches.filter(b => b.factory_code === fc).length}</span></td>
                    </tr>
                  )}
                  {!collapsed.has(fc) && batches.filter(b => b.factory_code === fc).map(b => (
                    <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2">{canEdit && canFac(b.factory_code) && <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} className="h-4 w-4" />}</td>
                      <td className="px-3 py-2"><span className="font-mono font-medium">{b.item_code}</span><span className="block text-gray-400">{b.description}</span></td>
                      <td className="px-3 py-2 whitespace-nowrap">{b.batch_no || '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold">{b.produced_qty}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{status(b) === 'Completed' ? <span className="text-green-700 font-medium">Completed</span> : <span className="text-amber-600">In Progress</span>}</td>
                      {multiFac && <td className="px-3 py-2 whitespace-nowrap text-gray-600">{factoryName(b.factory_code)}</td>}
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? b.delivery_date.split('-').reverse().join('/') : '—'}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* ---- Raw material return ---- */}
        <h2 className="text-lg font-semibold mb-2">Return raw material</h2>
        <p className="text-gray-500 text-xs mb-3">Pick a batch and add it to the delivery order below. Stock is reduced when the order is created.</p>
        {canEdit && (
          <form onSubmit={addReturn} className="bg-white border rounded-xl shadow-sm p-4 mb-8">
            <div className="flex flex-wrap gap-4 items-end">
              {myFactories.length > 1 ? (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory (location)</span>
                  <select value={factory} onChange={e => { setFactory(e.target.value); setCode(''); setLotId('') }} className="border rounded px-2 py-1.5 text-sm bg-white">
                    {myFactories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                  </select></div>
              ) : (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory (location)</span>
                  <div className="border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-700 min-w-[140px]">{factoryName(factory)}</div></div>
              )}
              <div className="flex flex-col gap-1 min-w-[220px] flex-1">
                <span className="text-xs font-medium text-gray-600 flex items-center justify-between gap-2">Material
                  <label className="font-normal text-[11px] text-blue-600 inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={manual} onChange={e => { setManual(e.target.checked); setCode(''); setLotId(''); setManBatch('') }} className="h-3.5 w-3.5" /> Not in stock? Pick from all items</label>
                </span>
                {manual ? (
                  <select value={code} onChange={e => setCode(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-white">
                    <option value="">Choose any item…</option>
                    {items.map(i => <option key={i.id} value={i.code}>{i.code} — {i.description}</option>)}
                  </select>
                ) : inStock.length > 0 ? (
                  <select value={code} onChange={e => { setCode(e.target.value); setLotId('') }} className="border rounded px-2 py-1.5 text-sm bg-white">
                    <option value="">Choose a material…</option>
                    {inStock.map(i => <option key={i.id} value={i.code}>{i.code} — {i.description} · {onHand[`${i.id}|${factory}`]} {i.unit}</option>)}
                  </select>
                ) : (
                  <div className="border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-400">No materials in stock — tick &quot;Enter manually&quot; to key one in.</div>
                )}
              </div>
              {manual && (
                <div className="flex flex-col gap-1 min-w-[140px]"><span className="text-xs font-medium text-gray-600">Batch (optional)</span>
                  <input value={manBatch} onChange={e => setManBatch(e.target.value)} placeholder="Batch no" className="border rounded px-2 py-1.5 text-sm" /></div>
              )}
              {!manual && item && (
                <div className="flex flex-col gap-1 min-w-[180px]"><span className="text-xs font-medium text-gray-600">Batch</span>
                  <select value={lotId} onChange={e => setLotId(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-white">
                    <option value="">Choose a batch…</option>
                    {itemLots.map(l => <option key={l.id} value={l.id}>{l.batch_no || '(no batch)'} · {l.qty_remaining} {item.unit} · exp {fmtD(l.exp_date)}</option>)}
                  </select>
                  {lot ? <span className="text-xs text-gray-500">In this batch: <strong>{onHandQty}</strong> {item.unit}</span> : null}
                </div>
              )}
              <div className="flex flex-col gap-1 w-28"><span className="text-xs font-medium text-gray-600">Quantity {item ? `(${item.unit})` : ''}</span>
                <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
              <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Stock has an issue?</span>
                <select value={issue} onChange={e => setIssue(e.target.value as 'no' | 'yes')} className="border rounded px-2 py-1.5 text-sm bg-white">
                  <option value="no">No</option>
                  <option value="yes">Yes — has a problem</option>
                </select></div>
              {issue === 'yes' && (
                <div className="flex flex-col gap-1 min-w-[220px] flex-1"><span className="text-xs font-medium text-gray-600">Reason</span>
                  <input value={reason} onChange={e => setReason(e.target.value)} placeholder="What is the problem?" className="border rounded px-2 py-1.5 text-sm" /></div>
              )}
              <button className="bg-orange-600 text-white px-5 py-2 rounded-lg hover:bg-orange-700 text-sm font-medium">Add to delivery order</button>
            </div>
            {lot && Number(qty) > lot.qty_remaining && <p className="text-amber-600 text-xs mt-2">⚠ Only {lot.qty_remaining} {item?.unit} left in this batch.</p>}
          </form>
        )}

        {/* ---- Direct delivery from a sales order (bypass production) ---- */}
        {canEdit && (
          <>
            <h2 className="text-lg font-semibold mb-2">Deliver directly from a sales order <span className="text-gray-400 font-normal text-sm">· bypasses production</span></h2>
            <p className="text-gray-500 text-xs mb-3">Send a sales-order item straight to the warehouse without producing it. The sales line is marked delivered with the DO number. Stock is reduced (it may go negative — producing the item later brings it back toward zero).</p>
            <form onSubmit={addDirect} className="bg-white border rounded-xl shadow-sm p-4 mb-4">
              <div className="flex flex-wrap gap-4 items-end">
                <div className="flex flex-col gap-1 min-w-[160px]"><span className="text-xs font-medium text-gray-600">Sales order</span>
                  <select value={dSo} onChange={e => { setDSo(e.target.value); setDLineId(''); setDQty('') }} className="border rounded px-2 py-1.5 text-sm bg-white">
                    <option value="">Choose a sales order…</option>
                    {openSOs.map(so => <option key={so} value={so}>{so}</option>)}
                  </select></div>
                {dSo && (
                  <div className="flex flex-col gap-1 min-w-[280px] flex-1"><span className="text-xs font-medium text-gray-600">Item</span>
                    <select value={dLineId} onChange={e => { setDLineId(e.target.value); const l = salesLines.find(x => x.id === e.target.value); setDQty(l ? String(remainingOf(l)) : '') }} className="border rounded px-2 py-1.5 text-sm bg-white">
                      <option value="">Choose an item…</option>
                      {linesForSO.map(l => <option key={l.id} value={l.id}>{l.item_code} — {l.description} · {remainingOf(l)} left · {factoryName(l.factory_code)}</option>)}
                    </select></div>
                )}
                <div className="flex flex-col gap-1 w-24"><span className="text-xs font-medium text-gray-600">Quantity</span>
                  <input type="number" step="any" min="0" value={dQty} onChange={e => setDQty(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
                <div className="flex flex-col gap-1 w-32"><span className="text-xs font-medium text-gray-600">Batch (optional)</span>
                  <input value={dBatch} onChange={e => setDBatch(e.target.value)} placeholder="Batch no" className="border rounded px-2 py-1.5 text-sm" /></div>
                <div className="flex flex-col gap-1 w-36"><span className="text-xs font-medium text-gray-600">Expiry (optional)</span>
                  <input type="date" value={dExp} onChange={e => setDExp(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
                <button className="bg-orange-600 text-white px-5 py-2 rounded-lg hover:bg-orange-700 text-sm font-medium">Add</button>
              </div>
            </form>
            {directCart.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-8">
                <div className="font-medium mb-2">Direct delivery — {directCart.length} item(s)</div>
                <ul className="space-y-1 mb-3">
                  {directCart.map((c, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 text-sm border-b border-amber-100 py-1">
                      <span><span className="font-mono">{c.itemCode}</span> {c.description && <span className="text-gray-500">{c.description}</span>} · {c.qty} · {c.so} · {c.factoryName}{c.batchNo && <span className="text-gray-500"> · batch {c.batchNo}</span>}{c.expDate && <span className="text-gray-500"> · exp {c.expDate.split('-').reverse().join('/')}</span>}</span>
                      <button onClick={() => setDirectCart(cart => cart.filter((_, j) => j !== i))} className="text-red-500 hover:text-red-700 text-xs shrink-0">Remove</button>
                    </li>
                  ))}
                </ul>
                <button onClick={createDirect} disabled={busy} className="bg-gray-800 text-white px-5 py-2 rounded-lg hover:bg-gray-900 text-sm font-medium disabled:opacity-50">Create direct delivery order</button>
              </div>
            )}
          </>
        )}

        {/* ---- Delivery-order cart, grouped by factory (one DO per factory) ---- */}
        {canEdit && cartCount > 0 && (
          <div className="space-y-4 mb-8">
            <h2 className="text-lg font-semibold">This delivery order <span className="text-gray-400 font-normal text-sm">· {cartCount} item(s){cartFactories.size > 1 ? ` across ${cartFactories.size} factories` : ''}</span></h2>
            {[...cartFactories].sort().map(fac => {
              const facBatches = batches.filter(b => picked.has(b.id) && b.factory_code === fac)
              const facReturns = returnCart.map((r, i) => ({ r, i })).filter(x => x.r.factory === fac)
              const count = facBatches.length + facReturns.length
              return (
                <div key={fac} className="bg-white border-2 border-teal-300 rounded-xl shadow-sm p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold">🏭 {factoryName(fac)} <span className="text-gray-400 font-normal text-sm">· {count} item(s)</span></h3>
                    <button onClick={() => createDO(fac)} disabled={busy} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">{busy ? 'Creating…' : 'Create delivery order'}</button>
                  </div>
                  <div className="text-sm divide-y">
                    {facBatches.map(b => (
                      <div key={b.id} className="flex items-center gap-2 py-1.5">
                        <span title="Finished goods">📦</span>
                        <span className="font-mono">{b.item_code}</span>
                        <span className="text-gray-400 flex-1 truncate">{b.description}{b.batch_no ? ` · ${b.batch_no}` : ''}</span>
                        <span className="font-medium whitespace-nowrap">× {b.produced_qty}</span>
                        <button onClick={() => toggle(b.id)} className="text-red-500 text-xs hover:underline">remove</button>
                      </div>
                    ))}
                    {facReturns.map(({ r, i }) => (
                      <div key={i} className="flex items-center gap-2 py-1.5">
                        <span title="Raw-material return" className="text-orange-600">↩</span>
                        <span className="font-mono">{r.itemCode}</span>
                        <span className="text-gray-400 flex-1 truncate">{r.description} · batch {r.batchNo || '—'}{r.reason ? ` · ${r.reason}` : ''}</span>
                        <span className="font-medium whitespace-nowrap">× {r.qty} {r.unit}</span>
                        <button onClick={() => setReturnCart(c => c.filter((_, j) => j !== i))} className="text-red-500 text-xs hover:underline">remove</button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ---- History ---- */}
        <h2 className="text-lg font-semibold mb-2">Recent delivery orders</h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[20rem] mb-8">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10"><tr>{['DO No.', ...(multiFac ? ['Factory'] : []), 'Items', 'By', 'When'].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">No delivery orders yet.</td></tr>}
              {orders.map(o => (
                <tr key={o.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{o.do_number}</td>
                  {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(o.factory_code)}</td>}
                  <td className="px-3 py-2 text-gray-600">
                    {(o.dispatch_order_lines || []).map((l, i) => <span key={`f${i}`} className="block">📦 <span className="font-mono">{l.item_code}</span> × {l.quantity}</span>)}
                    {(o.material_returns || []).map((l, i) => <span key={`r${i}`} className="block text-orange-600">↩ <span className="font-mono">{l.item_code}</span> × {l.quantity}</span>)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.created_by_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="text-lg font-semibold mb-2">Recent material returns</h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[20rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10"><tr>{[...(multiFac ? ['Factory'] : []), 'Material', 'Batch', 'Qty', 'Reason', 'By', 'When', ''].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {returns.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-gray-400">No returns yet.</td></tr>}
              {returns.map(r => (
                <tr key={r.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(r.factory_code)}</td>}
                  <td className="px-3 py-2"><span className="font-mono font-medium">{r.item_code}</span><span className="block text-gray-400">{r.description}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.batch_no || '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold">{r.quantity}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{r.reason || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.created_by_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(r.created_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {editPending.has(r.id) ? <span className="text-amber-600">⏳ edit pending</span>
                      : canFac(r.factory_code) && hasCap(profile, 'request_return_edit') ? <button onClick={() => openRetEdit(r)} className="text-blue-600 hover:underline">Edit</button>
                        : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit-a-return modal (HO approval) */}
      {editRet && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setEditRet(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">Edit return</h2>
            <p className="text-gray-500 text-sm mb-4"><span className="font-mono">{editRet.item_code}</span> · batch {editRet.batch_no || '—'} · {factoryName(editRet.factory_code)}. {isHO ? 'Applies immediately and adjusts stock.' : 'Goes to Head Office for approval; stock changes when approved.'}</p>
            <div className="space-y-3">
              <div><label className="block text-sm font-medium mb-1">Quantity returned</label>
                <input type="number" step="any" min="0" value={editQty} onChange={e => setEditQty(e.target.value)} className="w-full border rounded-lg px-3 py-2" />
                <span className="text-xs text-gray-500">Was {editRet.quantity}. Increasing returns more (reduces stock further); decreasing adds stock back.</span></div>
              <div><label className="block text-sm font-medium mb-1">Reason on the return <span className="text-gray-400 font-normal">(optional)</span></label>
                <input value={editNewReason} onChange={e => setEditNewReason(e.target.value)} className="w-full border rounded-lg px-3 py-2" /></div>
              <div><label className="block text-sm font-medium mb-1">Reason for this edit</label>
                <input value={editWhy} onChange={e => setEditWhy(e.target.value)} placeholder="Why are you changing it?" className="w-full border rounded-lg px-3 py-2" /></div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={submitRetEdit} disabled={busy} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{busy ? 'Saving…' : isHO ? 'Apply' : 'Send for approval'}</button>
              <button onClick={() => setEditRet(null)} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
