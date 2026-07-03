'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, hasCap } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface Item { id: string; code: string; description: string; unit: string }
interface Lot { id: string; item_code: string; factory_code: string; batch_no: string | null; exp_date: string | null; qty_remaining: number }
interface Batch {
  id: string; batch_no: string | null; item_code: string; description: string | null
  factory_code: string; total_quantity: number; produced_qty: number | null
  dispatched_at: string | null; delivery_date: string | null; exp_date: string | null
  production_batch_items?: { so_number: string | null }[]
}
interface DOrder {
  id: string; do_number: string | null; factory_code: string; status: string
  created_by_name: string | null; created_at: string; vehicle: string | null; driver_name: string | null
  dispatch_order_lines?: { id: string; item_code: string; description: string | null; quantity: number; batch_no: string | null; exp_date: string | null; batch_id: string | null }[]
  material_returns?: { id: string; item_code: string; description: string | null; quantity: number; batch_no: string | null; exp_date: string | null; reason: string | null }[]
}
interface CartReturn { lotId: string; itemCode: string; description: string; unit: string; batchNo: string | null; expDate?: string | null; qty: number; reason: string; factory: string; factoryName: string; manual?: boolean }
interface SLine { id: string; so_number: string; customer_name: string | null; item_code: string; description: string | null; quantity: number | null; outstanding_qty: number | null; factory_code: string; delivered_qty: number | null }
interface MReturn {
  id: string; factory_code: string; item_code: string; description: string | null
  batch_no: string | null; exp_date: string | null; quantity: number; reason: string | null; created_by_name: string | null; created_at: string
  dispatch_orders?: { do_number: string | null } | null
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
  const [soByBatch, setSoByBatch] = useState<Record<string, string>>({})
  const [expByBatch, setExpByBatch] = useState<Record<string, string>>({})   // effective expiry: batch's own, else its label's
  const [soByDoItem, setSoByDoItem] = useState<Record<string, string>>({})   // `${do_number}|${item_code}` -> SO (bypass/direct deliveries)
  const [linkModal, setLinkModal] = useState<{ lineId: string; isReturn: boolean; itemCode: string; description: string | null; factory: string; qty: number } | null>(null)
  const [alloc, setAlloc] = useState<Record<string, string>>({})
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
  const [manBatch, setManBatch] = useState('')   // manual batch no
  const [manExp, setManExp] = useState('')        // manual expiry (batch or expiry required)
  const [qty, setQty] = useState('')
  const [issue, setIssue] = useState<'no' | 'yes'>('no')
  const [reason, setReason] = useState('')
  const [returnCart, setReturnCart] = useState<CartReturn[]>([])
  const [vehicleByFac, setVehicleByFac] = useState<Record<string, string>>({})   // vehicle no. keyed by factory, set before creating each DO
  const [lorryReqs, setLorryReqs] = useState<{ id: string; factory_code: string; lorry_type: string; note: string | null; requested_by_name: string | null; requested_at: string }[]>([])
  const [lrFactory, setLrFactory] = useState('')     // which factory to request a lorry for
  const [lrType, setLrType] = useState('any')        // small | big | any
  const [lrNote, setLrNote] = useState('')
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
  const [editNewItem, setEditNewItem] = useState('')   // '' = keep same item; otherwise the new item code
  const [editBatch, setEditBatch] = useState('')
  const [editExp, setEditExp] = useState('')
  const [editNewReason, setEditNewReason] = useState('')
  const [editWhy, setEditWhy] = useState('')
  const [editPending, setEditPending] = useState<Set<string>>(new Set())
  // Finished-goods line edit (delivery-note correction, HO approval)
  type FgLine = { id: string; item_code: string; description: string | null; quantity: number; batch_no: string | null; exp_date: string | null }
  const [fgEdit, setFgEdit] = useState<{ line: FgLine; doNumber: string | null; dispatchId: string; factory: string } | null>(null)
  const [fgItem, setFgItem] = useState('')     // 'CODE — desc' of the (possibly new) item
  const [fgQty, setFgQty] = useState('')
  const [fgBatch, setFgBatch] = useState('')
  const [fgExp, setFgExp] = useState('')
  const [fgWhy, setFgWhy] = useState('')
  const [fgEditPending, setFgEditPending] = useState<Set<string>>(new Set())

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
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, dispatched_at, delivery_date, exp_date, production_batch_items(so_number)')
      .is('dispatched_at', null).gt('produced_qty', 0).neq('status', 'Bypassed').order('delivery_date')
    setBatches((b as Batch[]) || [])
    const { data: o } = await supabase.from('dispatch_orders')
      .select('id, do_number, factory_code, status, created_by_name, created_at, vehicle, driver_name, dispatch_order_lines(id, item_code, description, quantity, batch_no, exp_date, batch_id), material_returns(id, item_code, description, quantity, batch_no, exp_date, reason)')
      .order('created_at', { ascending: false }).limit(50)
    setOrders((o as DOrder[]) || [])
    // Open lorry requests (raised before a DO exists).
    const { data: lr } = await supabase.from('lorry_requests')
      .select('id, factory_code, lorry_type, note, requested_by_name, requested_at').eq('status', 'open')
      .order('requested_at', { ascending: false })
    setLorryReqs(lr || [])
    // SO number(s) per dispatched batch, so each delivery line can show its order.
    const batchIds = [...new Set(((o as DOrder[]) || []).flatMap(d => (d.dispatch_order_lines || []).map(l => l.batch_id).filter(Boolean)))] as string[]
    const sob: Record<string, string> = {}
    for (let i = 0; i < batchIds.length; i += 200) {
      const { data: pbi } = await supabase.from('production_batch_items').select('batch_id, so_number').in('batch_id', batchIds.slice(i, i + 200))
      ;(pbi || []).forEach(r => { if (!r.batch_id || !r.so_number) return; sob[r.batch_id] = sob[r.batch_id] ? (sob[r.batch_id].includes(r.so_number) ? sob[r.batch_id] : sob[r.batch_id] + ', ' + r.so_number) : r.so_number })
    }
    setSoByBatch(sob)
    // Effective expiry per batch: the batch's own exp_date, else the expiry printed on its label.
    const rtsIds = ((b as Batch[]) || []).map(x => x.id)
    const allBids = [...new Set([...rtsIds, ...batchIds])]
    const bexp: Record<string, { exp: string | null; mr: string | null }> = {}
    for (let i = 0; i < allBids.length; i += 200) {
      const { data: bb } = await supabase.from('production_batches').select('id, exp_date, material_request_id').in('id', allBids.slice(i, i + 200))
      ;(bb || []).forEach(r => { bexp[r.id] = { exp: r.exp_date, mr: r.material_request_id } })
    }
    const mrIds = [...new Set(Object.values(bexp).filter(x => !x.exp && x.mr).map(x => x.mr as string))]
    const lblExp: Record<string, string> = {}
    for (let i = 0; i < mrIds.length; i += 200) {
      const { data: mi } = await supabase.from('material_request_items').select('request_id, label_exp_date').in('request_id', mrIds.slice(i, i + 200))
      ;(mi || []).forEach(r => { if (!r.label_exp_date) return; if (!lblExp[r.request_id] || r.label_exp_date > lblExp[r.request_id]) lblExp[r.request_id] = r.label_exp_date })
    }
    const eb: Record<string, string> = {}
    Object.entries(bexp).forEach(([id, x]) => { const e = x.exp || (x.mr ? lblExp[x.mr] : null); if (e) eb[id] = e })
    setExpByBatch(eb)
    // SOs delivered against each DO via bypass/direct delivery (sales line stamped with the DO number).
    const doNos = [...new Set(((o as DOrder[]) || []).map(d => d.do_number).filter(Boolean))] as string[]
    const sdi: Record<string, string> = {}
    for (let i = 0; i < doNos.length; i += 100) {
      const { data: dl } = await supabase.from('sales_order_lines').select('so_number, item_code, delivered_do').in('delivered_do', doNos.slice(i, i + 100))
      ;(dl || []).forEach(r => { if (!r.delivered_do || !r.so_number) return; const k = `${r.delivered_do}|${r.item_code}`; sdi[k] = sdi[k] ? (sdi[k].includes(r.so_number) ? sdi[k] : sdi[k] + ', ' + r.so_number) : r.so_number })
    }
    setSoByDoItem(sdi)
    const { data: pe } = await supabase.from('return_edit_requests').select('return_id').eq('status', 'Pending')
    setEditPending(new Set((pe || []).map(x => x.return_id).filter(Boolean)))
    const { data: fpe } = await supabase.from('dispatch_line_edit_requests').select('line_id').eq('status', 'Pending')
    setFgEditPending(new Set((fpe || []).map(x => x.line_id).filter(Boolean)))
    // Sales-order lines (for direct delivery). Limit to the factories the user can act on.
    const facCodes = isHO ? null : codes
    const sLines: SLine[] = []
    for (let from = 0; ; from += 1000) {
      let q = supabase.from('sales_order_lines').select('id, so_number, customer_name, item_code, description, quantity, outstanding_qty, factory_code, delivered_qty')
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
      // Item not in stock — keyed in by hand. Batch OR expiry is required for traceability.
      const mc = code.trim()
      if (!mc) { setError('Pick an item from the list.'); return }
      if (!manBatch.trim() && !manExp) { setError('Enter a batch number or an expiry date (at least one is required).'); return }
      const known = resolve(mc)
      setReturnCart(c => [...c, { lotId: '', itemCode: known?.code || mc.toUpperCase(), description: known?.description || '', unit: known?.unit || '', batchNo: manBatch.trim() || null, expDate: manExp || null, qty: num, reason: note, factory, factoryName: factoryName(factory), manual: true }])
      setCode(''); setManBatch(''); setManExp(''); setQty(''); setIssue('no'); setReason('')
      return
    }
    const it = resolve(code)
    if (!it) { setError('Pick a valid raw-material code from the list.'); return }
    if (!lot) { setError('Pick the batch you are returning.'); return }
    if (!lot.batch_no && !lot.exp_date) { setError('This batch has no batch number or expiry — it cannot be returned. Fix the stock record first.'); return }
    const already = returnCart.filter(r => r.lotId === lot.id).reduce((s, r) => s + r.qty, 0)
    if (already + num > lot.qty_remaining) { setError(`Batch ${lot.batch_no || '—'} only has ${lot.qty_remaining} ${it.unit} left${already ? ` (you already added ${already})` : ''}.`); return }
    setReturnCart(c => [...c, { lotId: lot.id, itemCode: it.code, description: it.description, unit: it.unit, batchNo: lot.batch_no, expDate: lot.exp_date, qty: num, reason: note, factory, factoryName: factoryName(factory) }])
    setCode(''); setLotId(''); setQty(''); setIssue('no'); setReason('')
  }

  // ---- Direct delivery from a sales order (bypass production) ----
  const remainingOf = (l: SLine) => Math.max(0, Number(l.outstanding_qty ?? l.quantity ?? 0) - Number(l.delivered_qty || 0))
  const cartLineIds = new Set(directCart.map(c => c.lineId))   // already added → drop from the picker
  const availLine = (l: SLine) => remainingOf(l) > 0 && !cartLineIds.has(l.id)
  const openSOs = [...new Set(salesLines.filter(availLine).map(l => l.so_number))].sort()
  const linesForSO = salesLines.filter(l => l.so_number === dSo && availLine(l))
  // Pending SOs for an item at a factory — used to warn/link a delivery line that has no SO.
  const pendingSOsForItem = (itemCode: string, factory: string) => [...new Set(salesLines.filter(l => l.item_code === itemCode && l.factory_code === factory && remainingOf(l) > 0).map(l => l.so_number))].sort()
  // Detailed pending orders for an item: SO + customer + how much is still needed.
  const pendingDetailForItem = (itemCode: string, factory: string) => {
    const m = new Map<string, { so: string; customer: string | null; remaining: number }>()
    salesLines.filter(l => l.item_code === itemCode && l.factory_code === factory && remainingOf(l) > 0).forEach(l => {
      const e = m.get(l.so_number) || { so: l.so_number, customer: l.customer_name, remaining: 0 }
      e.remaining += remainingOf(l); if (!e.customer) e.customer = l.customer_name; m.set(l.so_number, e)
    })
    return [...m.values()].sort((a, b) => a.so.localeCompare(b.so))
  }
  function openLink(lineId: string, isReturn: boolean, itemCode: string, description: string | null, factory: string, qty: number) {
    setLinkModal({ lineId, isReturn, itemCode, description, factory, qty }); setAlloc({}); setError(''); setSuccess('')
  }
  async function submitLink() {
    if (!linkModal) return
    const entries = Object.entries(alloc).map(([so, v]) => ({ so, qty: Number(v) })).filter(x => x.qty > 0)
    if (entries.length === 0) { setError('Enter a quantity for at least one order.'); return }
    setBusy(true); setError(''); setSuccess('')
    for (const e of entries) {
      const { error: er } = await supabase.rpc('link_line_to_so', { p_line_id: linkModal.lineId, p_is_return: linkModal.isReturn, p_so: e.so, p_qty: e.qty })
      if (er) { setError(/link_line_to_so/.test(er.message) ? 'Linking needs a database update — run the latest catch-up SQL.' : er.message); setBusy(false); return }
    }
    setBusy(false); setLinkModal(null)
    setSuccess(`Linked ${entries.length} order(s) and marked delivered.`); load()
  }
  function addDirect(e: React.FormEvent) {
    e.preventDefault(); setError(''); setSuccess('')
    const line = salesLines.find(l => l.id === dLineId)
    if (!line) { setError('Pick a sales-order item line.'); return }
    if (!line.factory_code) { setError('This line has no factory/location set — set it on the Sales Orders page first.'); return }
    const n = Number(dQty)
    if (!(n > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (!dBatch.trim() && !dExp) { setError('Enter a batch number or an expiry date (at least one).'); return }
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
  async function requestLorry() {
    const fac = lrFactory || myFactories[0]?.code
    if (!fac) { setError('Pick a factory to request a lorry for.'); return }
    setBusy(true); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('request_lorry', { p_factory: fac, p_type: lrType, p_note: lrNote.trim() || null })
    setBusy(false)
    if (e) { setError(e.message); return }
    setLrNote(''); setLrType('any')
    setSuccess(`Lorry requested for ${factoryName(fac)} — the warehouse has been notified.`)
    load()
  }
  async function cancelLorryReq(id: string) {
    if (!confirm('Cancel this lorry request?')) return
    const { error: e } = await supabase.rpc('cancel_lorry_request', { p_id: id })
    if (e) { setError(e.message); return }
    setLorryReqs(prev => prev.filter(r => r.id !== id))
  }

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
        ? { manual: true, item_code: r.itemCode, description: r.description, batch_no: r.batchNo, exp_date: r.expDate || null, qty: r.qty, reason: r.reason, factory_code: r.factory }
        : { lot_id: r.lotId, qty: r.qty, reason: r.reason }),
      p_vehicle: (vehicleByFac[fac] || '').trim() || null,
    })
    if (e) { setError(e.message); setBusy(false); return }
    setSuccess(`Delivery order ${data} created — ${count} item(s) sent to warehouse.`)
    // Clear only this factory's items; keep the rest of the cart for its own DO.
    setPicked(p => { const n = new Set(p); batchIds.forEach(id => n.delete(id)); return n })
    setReturnCart(c => c.filter(r => r.factory !== fac))
    setVehicleByFac(v => { const n = { ...v }; delete n[fac]; return n })
    setBusy(false); load()
  }

  // Print a delivery order on half-A4 (A5): item code, name, qty, batch, exp — finished goods + returns.
  async function printDO(o: DOrder) {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ format: 'a5' })
    const W = doc.internal.pageSize.getWidth()
    // ── Company letterhead ──
    doc.setFontSize(13); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN. BHD.', W / 2, 11, { align: 'center' })
    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal')
    doc.text('(157367-T)', W / 2, 14.5, { align: 'center' })
    doc.text('15, Jalan Anggerik Mokara 31/62, Kota Kemuning, Sek. 31,', W / 2, 18, { align: 'center' })
    doc.text('40460 Shah Alam, Selangor Darul Ehsan, Malaysia', W / 2, 21, { align: 'center' })
    doc.text('Tel: 03-51220304   Fax: 03-51221505   E-mail: admin@easwarimills.com   Website: www.easwarimills.com', W / 2, 24, { align: 'center' })
    doc.setLineWidth(0.4); doc.line(10, 27, W - 10, 27)
    // ── Document title + meta ──
    doc.setFontSize(11); doc.setFont('helvetica', 'bold')
    doc.text('DELIVERY ORDER', W / 2, 33, { align: 'center' })
    doc.setFontSize(8); doc.setFont('helvetica', 'normal')
    doc.text(`DO No: ${o.do_number || '—'}`, 10, 40)
    doc.text(`Factory: ${factoryName(o.factory_code)}`, 10, 44.5)
    doc.text(`Vehicle: ${o.vehicle || '—'}    Driver: ${o.driver_name || '—'}`, 10, 49)
    doc.text(`Date: ${fmt(o.created_at)}`, W - 10, 40, { align: 'right' })
    doc.text(`By: ${o.created_by_name || '—'}`, W - 10, 44.5, { align: 'right' })
    const fg = o.dispatch_order_lines || [], rt = o.material_returns || []
    const body = [
      ...fg.map((l, i) => { const ex = l.exp_date || (l.batch_id ? expByBatch[l.batch_id] : ''); const so = (l.batch_id && soByBatch[l.batch_id]) || soByDoItem[`${o.do_number}|${l.item_code}`] || '—'; return [String(i + 1), so, l.item_code, l.description || '', String(l.quantity), l.batch_no || '—', ex ? fmtD(ex) : '⚠ none'] }),
      ...rt.map((l, i) => [String(fg.length + i + 1), soByDoItem[`${o.do_number}|${l.item_code}`] || 'Return', l.item_code, l.description || '', String(l.quantity), l.batch_no || '—', l.exp_date ? fmtD(l.exp_date) : '—']),
    ]
    autoTable(doc, {
      startY: 53, head: [['#', 'SO', 'Code', 'Item name', 'Qty', 'Batch', 'Exp']], body,
      styles: { fontSize: 8, cellPadding: 1.4 }, headStyles: { fillColor: [30, 58, 138] },
      columnStyles: { 0: { cellWidth: 7 }, 4: { halign: 'right' } }, margin: { left: 10, right: 10 },
    })
    const endY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || 40
    doc.setFontSize(8)
    doc.text('Received by: ______________________     Date: __________', 10, endY + 12)
    doc.autoPrint()
    window.open(doc.output('bloburl'), '_blank')
  }

  function openRetEdit(r: MReturn) {
    setEditRet(r); setEditQty(String(r.quantity)); setEditNewItem(''); setEditBatch(r.batch_no || ''); setEditExp(r.exp_date || ''); setEditNewReason(r.reason || ''); setEditWhy(''); setError(''); setSuccess('')
  }
  function openFgEdit(line: FgLine, o: DOrder) {
    setFgEdit({ line, doNumber: o.do_number, dispatchId: o.id, factory: o.factory_code })
    setFgItem(`${line.item_code}${line.description ? ' — ' + line.description : ''}`)
    setFgQty(String(line.quantity)); setFgBatch(line.batch_no || ''); setFgExp(line.exp_date || ''); setFgWhy(''); setError(''); setSuccess('')
  }
  // Request an edit to a finished-goods delivery line (item/qty/batch/exp). HO approval applies it.
  async function submitFgEdit() {
    if (!fgEdit || !profile) return
    const nq = Number(fgQty)
    if (!(nq > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (!fgWhy.trim()) { setError('Please give a reason for the edit.'); return }
    const newCode = fgItem.split(' — ')[0].trim() || fgEdit.line.item_code
    setBusy(true); setError(''); setSuccess('')
    const { data, error: e } = await supabase.from('dispatch_line_edit_requests').insert({
      line_id: fgEdit.line.id, dispatch_id: fgEdit.dispatchId, do_number: fgEdit.doNumber, factory_code: fgEdit.factory,
      old_item_code: fgEdit.line.item_code, new_item_code: newCode,
      old_qty: fgEdit.line.quantity, new_qty: nq,
      old_batch_no: fgEdit.line.batch_no, new_batch_no: fgBatch.trim() || null,
      old_exp_date: fgEdit.line.exp_date, new_exp_date: fgExp || null,
      reason: fgWhy.trim(), requested_by: profile.id, requested_by_name: profile.full_name || null,
    }).select('id').single()
    if (e || !data) {
      const msg = e?.message || 'Could not send request'
      setError(/dispatch_line_edit_requests/.test(msg) ? 'This needs a database update — run the latest catch-up SQL first.' : msg)
      setBusy(false); return
    }
    if (isHO) {
      const { error: apErr } = await supabase.rpc('approve_dispatch_line_edit', { p_id: data.id })
      if (apErr) { setError(`Saved, but could not apply: ${apErr.message}`); setBusy(false); setFgEdit(null); load(); return }
    }
    setBusy(false); setFgEdit(null)
    setSuccess(isHO ? 'Delivery line updated.' : 'Edit request sent to Head Office for approval.')
    load()
  }
  // Request an edit to a past return (qty/reason). HO approval applies the stock change.
  async function submitRetEdit() {
    if (!editRet || !profile) return
    const nq = Number(editQty)
    if (!(nq > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (!editWhy.trim()) { setError('Please give a reason for the edit.'); return }
    setBusy(true); setError(''); setSuccess('')
    const newItem = editNewItem && editNewItem !== editRet.item_code ? editNewItem : null
    const payload: Record<string, unknown> = {
      return_id: editRet.id, factory_code: editRet.factory_code, item_code: editRet.item_code, batch_no: editRet.batch_no,
      old_qty: editRet.quantity, new_qty: nq, old_reason: editRet.reason, new_reason: editNewReason.trim() || null,
      reason: editWhy.trim(), requested_by: profile.id, requested_by_name: profile.full_name || null,
    }
    if (newItem) payload.new_item_code = newItem   // only sent when the item is actually changed
    const newBatch = editBatch.trim() || null
    const newExp = editExp || null
    if (newBatch !== (editRet.batch_no || null)) payload.new_batch_no = newBatch
    if (newExp !== (editRet.exp_date || null)) payload.new_exp_date = newExp
    const { data, error: e } = await supabase.from('return_edit_requests').insert(payload).select('id').single()
    if (e || !data) {
      const msg = e?.message || 'Could not send request'
      setError(/new_item_code|new_batch_no|new_exp_date/.test(msg) ? 'This edit needs a database update — run the latest catch-up SQL first.' : msg)
      setBusy(false); return
    }
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

        {/* ---- Request a lorry (before a DO exists) ---- */}
        {canEdit && (
          <div className="bg-white border rounded-xl shadow-sm p-4 mb-6">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <div className="font-medium text-sm mb-0.5">🚚 Request a lorry</div>
                <p className="text-xs text-gray-500">Call the warehouse for a lorry before making the DO — load &amp; recheck, then create it.</p>
              </div>
              <div className="flex flex-wrap items-end gap-2 ml-auto">
                {myFactories.length > 1 && (
                  <label className="text-xs text-gray-600">Factory
                    <select value={lrFactory || myFactories[0]?.code || ''} onChange={e => setLrFactory(e.target.value)} className="block mt-0.5 border rounded-lg px-2 py-1.5 text-sm">
                      {myFactories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                    </select>
                  </label>
                )}
                <label className="text-xs text-gray-600">Lorry type
                  <select value={lrType} onChange={e => setLrType(e.target.value)} className="block mt-0.5 border rounded-lg px-2 py-1.5 text-sm">
                    <option value="any">Any</option>
                    <option value="small">Small</option>
                    <option value="big">Big</option>
                  </select>
                </label>
                <label className="text-xs text-gray-600">Note (optional)
                  <input value={lrNote} onChange={e => setLrNote(e.target.value)} placeholder="e.g. for Kelana Jaya run" className="block mt-0.5 border rounded-lg px-2 py-1.5 text-sm w-48" />
                </label>
                <button onClick={requestLorry} disabled={busy} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">📞 Request lorry</button>
              </div>
            </div>
            {lorryReqs.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <div className="text-xs font-medium text-gray-500 mb-1">Open lorry requests</div>
                <ul className="space-y-1">
                  {lorryReqs.map(r => (
                    <li key={r.id} className="flex items-center gap-2 text-sm">
                      <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 rounded-full px-2.5 py-0.5 text-xs">🚚 {r.lorry_type === 'any' ? 'Any' : r.lorry_type} lorry</span>
                      <span className="text-gray-600">{factoryName(r.factory_code)}</span>
                      {r.note && <span className="text-gray-400 text-xs truncate">· {r.note}</span>}
                      <span className="text-gray-400 text-xs">· {r.requested_by_name || '—'}, {fmt(r.requested_at)}</span>
                      {canFac(r.factory_code) && <button onClick={() => cancelLorryReq(r.id)} className="text-red-500 hover:underline text-xs ml-auto shrink-0">Cancel</button>}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-gray-400 mt-1">The warehouse assigns the lorry to a site on the Transport page; once it&apos;s parked here you can create the DO and pick it.</p>
              </div>
            )}
          </div>
        )}

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
                      <td className="px-3 py-2"><span className="font-mono font-medium">{b.item_code}</span><span className="block text-gray-400">{b.description}</span>{(() => { const sos = [...new Set((b.production_batch_items || []).map(i => i.so_number).filter(Boolean))]; if (sos.length) return <span className="block text-gray-400 text-xs font-mono">{sos.join(', ')}</span>; const cands = pendingDetailForItem(b.item_code, b.factory_code); return cands.length ? <span className="block text-amber-700 text-xs">⚠ no SO · pending: {cands.slice(0, 3).map(c => `${c.so}${c.customer ? ' (' + c.customer + ')' : ''} need ${c.remaining}`).join('; ')} — link on the DO after sending</span> : null })()}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{b.batch_no || '—'}{(() => { const e = expByBatch[b.id]; return e ? <span className="block text-gray-400 text-xs">exp {fmtD(e)}</span> : <span className="block text-amber-700 text-xs">⚠ no expiry</span> })()}</td>
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
                  <ItemPicker items={items} value={item ? `${item.code} — ${item.description}` : ''} onPick={it => setCode(it.code)} placeholder="Type a code or name…" />
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
                <>
                  <div className="flex flex-col gap-1 min-w-[130px]"><span className="text-xs font-medium text-gray-600">Batch <span className="text-gray-400">(batch or exp)</span></span>
                    <input value={manBatch} onChange={e => setManBatch(e.target.value)} placeholder="Batch no" className="border rounded px-2 py-1.5 text-sm" /></div>
                  <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Expiry</span>
                    <input type="date" value={manExp} onChange={e => setManExp(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
                </>
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
                <div className="flex flex-col gap-1 w-32"><span className="text-xs font-medium text-gray-600">Batch <span className="text-gray-400 font-normal">or expiry</span></span>
                  <input value={dBatch} onChange={e => setDBatch(e.target.value)} placeholder="Batch no" className="border rounded px-2 py-1.5 text-sm" /></div>
                <div className="flex flex-col gap-1 w-36"><span className="text-xs font-medium text-gray-600">Expiry <span className="text-gray-400 font-normal">or batch</span></span>
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
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="font-semibold">🏭 {factoryName(fac)} <span className="text-gray-400 font-normal text-sm">· {count} item(s)</span></h3>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600">🚚 Vehicle
                        <input value={vehicleByFac[fac] || ''} onChange={e => setVehicleByFac(v => ({ ...v, [fac]: e.target.value }))}
                          placeholder="Lorry / plate no." className="ml-2 border rounded-lg px-2 py-1.5 text-sm w-40" />
                      </label>
                      <button onClick={() => createDO(fac)} disabled={busy} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">{busy ? 'Creating…' : 'Create delivery order'}</button>
                    </div>
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
            <thead className="bg-gray-50 border-b sticky top-0 z-10"><tr>{['DO No.', ...(multiFac ? ['Factory'] : []), 'Items', 'By', 'When', ''].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No delivery orders yet.</td></tr>}
              {orders.map(o => (
                <tr key={o.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{o.do_number}</td>
                  {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(o.factory_code)}</td>}
                  <td className="px-3 py-2 text-gray-600">
                    {(o.dispatch_order_lines || []).map((l, i) => (
                      <span key={`f${i}`} className="block mb-1">
                        📦 <span className="font-mono">{l.item_code}</span>{l.description ? ` — ${l.description}` : ''} × {l.quantity}
                        {fgEditPending.has(l.id)
                          ? <span className="ml-2 text-amber-600 text-xs">⏳ edit pending approval</span>
                          : canFac(o.factory_code) && hasCap(profile, 'request_return_edit')
                            ? <button onClick={() => openFgEdit(l, o)} className="ml-2 text-blue-600 hover:underline text-xs">Edit</button>
                            : null}
                        {(() => {
                          const so = (l.batch_id && soByBatch[l.batch_id]) || soByDoItem[`${o.do_number}|${l.item_code}`] || ''
                          const exp = l.exp_date || (l.batch_id ? expByBatch[l.batch_id] : '')
                          const parts: React.ReactNode[] = []
                          if (so) parts.push(`SO ${so}`)
                          if (l.batch_no) parts.push(`batch ${l.batch_no}`)
                          parts.push(exp ? `exp ${fmtD(exp)}` : '⚠ no expiry')
                          return <span className={`block ml-5 text-xs ${exp ? 'text-gray-400' : 'text-amber-700'}`}>{parts.join(' · ')}</span>
                        })()}
                        {!((l.batch_id && soByBatch[l.batch_id]) || soByDoItem[`${o.do_number}|${l.item_code}`]) && canFac(o.factory_code) && (() => {
                          const cands = pendingDetailForItem(l.item_code, o.factory_code)
                          return cands.length ? <span className="block ml-5 text-xs text-amber-700">⚠ no SO linked · {cands.length} pending order(s) for this item <button onClick={() => openLink(l.id, false, l.item_code, l.description, o.factory_code, l.quantity)} disabled={busy} className="text-blue-600 hover:underline disabled:opacity-50 font-medium">🔗 Link to order(s)</button></span> : null
                        })()}
                      </span>
                    ))}
                    {(o.material_returns || []).map((l, i) => (
                      <span key={`r${i}`} className="block mb-1 text-orange-600">
                        ↩ <span className="font-mono">{l.item_code}</span>{l.description ? ` — ${l.description}` : ''} × {l.quantity}
                        {editPending.has(l.id)
                          ? <span className="ml-2 text-amber-600 text-xs">⏳ edit pending approval</span>
                          : canFac(o.factory_code) && hasCap(profile, 'request_return_edit')
                            ? <button onClick={() => openRetEdit({ id: l.id, factory_code: o.factory_code, item_code: l.item_code, description: l.description, batch_no: l.batch_no, exp_date: l.exp_date, quantity: l.quantity, reason: l.reason, created_by_name: null, created_at: o.created_at })} className="ml-2 text-blue-600 hover:underline text-xs">Edit</button>
                            : null}
                        {(() => { const so = soByDoItem[`${o.do_number}|${l.item_code}`]; const bits = [so ? `SO ${so}` : '', l.batch_no ? `batch ${l.batch_no}` : '', l.exp_date ? `exp ${fmtD(l.exp_date)}` : ''].filter(Boolean); return bits.length ? <span className="block ml-5 text-xs text-orange-400">{bits.join(' · ')}</span> : null })()}
                        {!soByDoItem[`${o.do_number}|${l.item_code}`] && canFac(o.factory_code) && (() => { const cands = pendingDetailForItem(l.item_code, o.factory_code); return cands.length ? <span className="block ml-5 text-xs text-amber-700">⚠ {cands.length} pending order(s) for this item <button onClick={() => openLink(l.id, true, l.item_code, l.description, o.factory_code, l.quantity)} disabled={busy} className="text-blue-600 hover:underline disabled:opacity-50 font-medium">🔗 Link to order(s)</button></span> : null })()}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.created_by_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(o.created_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><button onClick={() => printDO(o)} className="text-blue-600 hover:underline">🖨 Print</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-2">📦 = finished goods · ↩ = raw-material return. Returns can be edited here — the change is sent to Head Office for approval before it takes effect.</p>
      </div>

      {/* Edit-a-return modal (HO approval) */}
      {editRet && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setEditRet(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">Edit return</h2>
            <p className="text-gray-500 text-sm mb-4"><span className="font-mono">{editRet.item_code}</span> · batch {editRet.batch_no || '—'} · {factoryName(editRet.factory_code)}. {isHO ? 'Applies immediately and adjusts stock.' : 'Goes to Head Office for approval; stock changes when approved.'}</p>
            <div className="space-y-3">
              <div><label className="block text-sm font-medium mb-1">Item</label>
                <ItemPicker items={items} value={editNewItem ? (() => { const it = items.find(i => i.code === editNewItem); return it ? `${it.code} — ${it.description}` : editNewItem })() : `${editRet.item_code}${editRet.description ? ' — ' + editRet.description : ''}`} onPick={it => setEditNewItem(it.code)} placeholder="Type a code or name…" />
                {editNewItem && editNewItem !== editRet.item_code
                  ? <span className="text-xs text-amber-600">Changing item: <span className="font-mono">{editRet.item_code}</span> qty goes back to stock, new item is deducted.</span>
                  : <span className="text-xs text-gray-500">Leave as-is to keep the same item.</span>}</div>
              <div><label className="block text-sm font-medium mb-1">Quantity returned</label>
                <input type="number" step="any" min="0" value={editQty} onChange={e => setEditQty(e.target.value)} className="w-full border rounded-lg px-3 py-2" />
                <span className="text-xs text-gray-500">Was {editRet.quantity}. Increasing returns more (reduces stock further); decreasing adds stock back.</span></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-sm font-medium mb-1">Batch <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input value={editBatch} onChange={e => setEditBatch(e.target.value)} placeholder="Batch no." className="w-full border rounded-lg px-3 py-2" /></div>
                <div><label className="block text-sm font-medium mb-1">Expiry <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input type="date" value={editExp} onChange={e => setEditExp(e.target.value)} className="w-full border rounded-lg px-3 py-2" /></div>
              </div>
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

      {/* Edit a finished-goods delivery line (HO approval) */}
      {fgEdit && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setFgEdit(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">Edit delivery line</h2>
            <p className="text-gray-500 text-sm mb-4">DO <span className="font-mono">{fgEdit.doNumber || '—'}</span> · {factoryName(fgEdit.factory)}. {isHO ? 'Applies immediately.' : 'Goes to Head Office for approval.'} This corrects the delivery record; it does not change stock.</p>
            <div className="space-y-3">
              <div><label className="block text-sm font-medium mb-1">Item</label>
                <ItemPicker items={items} value={fgItem} onPick={it => setFgItem(`${it.code} — ${it.description}`)} placeholder="Type a code or name…" /></div>
              <div><label className="block text-sm font-medium mb-1">Quantity</label>
                <input type="number" step="any" min="0" value={fgQty} onChange={e => setFgQty(e.target.value)} className="w-full border rounded-lg px-3 py-2" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-sm font-medium mb-1">Batch <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input value={fgBatch} onChange={e => setFgBatch(e.target.value)} placeholder="Batch no." className="w-full border rounded-lg px-3 py-2" /></div>
                <div><label className="block text-sm font-medium mb-1">Expiry <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input type="date" value={fgExp} onChange={e => setFgExp(e.target.value)} className="w-full border rounded-lg px-3 py-2" /></div>
              </div>
              <div><label className="block text-sm font-medium mb-1">Reason for this edit</label>
                <input value={fgWhy} onChange={e => setFgWhy(e.target.value)} placeholder="Why are you changing it?" className="w-full border rounded-lg px-3 py-2" /></div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={submitFgEdit} disabled={busy} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{busy ? 'Saving…' : isHO ? 'Apply' : 'Send for approval'}</button>
              <button onClick={() => setFgEdit(null)} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Link a delivery/return line to one or more pending sales orders */}
      {linkModal && (() => {
        const cands = pendingDetailForItem(linkModal.itemCode, linkModal.factory)
        const allocated = cands.reduce((s, c) => s + (Number(alloc[c.so]) || 0), 0)
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setLinkModal(null)}>
            <div className="bg-white rounded-xl shadow-xl border w-full max-w-lg my-8 p-6" onClick={e => e.stopPropagation()}>
              <h2 className="font-semibold text-lg mb-1">Link to order(s)</h2>
              <p className="text-gray-500 text-sm mb-1"><span className="font-mono">{linkModal.itemCode}</span>{linkModal.description ? ` — ${linkModal.description}` : ''} · delivered <strong>{linkModal.qty}</strong></p>
              <p className="text-gray-400 text-xs mb-3">Give each order the quantity to fulfil from this delivery. Each order it&apos;s allocated to is marked delivered and cleared.</p>
              <div className="border rounded-lg divide-y max-h-72 overflow-auto mb-2">
                {cands.length === 0 && <p className="text-gray-400 text-sm text-center py-6">No pending orders for this item.</p>}
                {cands.map(c => (
                  <div key={c.so} className="flex items-center gap-3 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono font-medium text-sm">{c.so}</div>
                      <div className="text-gray-500 text-xs truncate">{c.customer || '—'} · need {c.remaining}</div>
                    </div>
                    <input type="number" step="any" min="0" max={c.remaining} value={alloc[c.so] || ''} onChange={e => setAlloc(p => ({ ...p, [c.so]: e.target.value }))} placeholder="0" className="w-24 border rounded-lg px-2 py-1.5 text-sm text-right" />
                  </div>
                ))}
              </div>
              <p className={`text-xs mb-3 ${allocated > linkModal.qty ? 'text-red-600 font-medium' : 'text-gray-500'}`}>Allocated {Number(allocated.toFixed(3))} of {linkModal.qty}{allocated > linkModal.qty ? ' — more than delivered!' : ''}</p>
              <div className="flex gap-2">
                <button onClick={submitLink} disabled={busy || allocated <= 0} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{busy ? 'Linking…' : 'Link & mark delivered'}</button>
                <button onClick={() => setLinkModal(null)} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
