'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, hasCap } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface MRItem {
  id: string
  item_code: string
  description: string
  unit: string
  required_qty: number
  stock_qty: number
  shortfall_qty: number
  requested_qty: number
  received_qty: number
  label_batch_no?: string | null
  label_exp_date?: string | null
  label_print_qty?: number | null
  label_photo_path?: string | null
  label_received_at?: string | null
}
interface MaterialRequest {
  id: string
  request_no: string
  factory_code: string
  status: string
  created_at: string
  released_at: string | null
  pick_run_no: string | null
  warehouse_so_no: string | null
  so_set_by_name: string | null
  so_set_at: string | null
  batch_id: string
  production_batches: { batch_no: string; item_code: string; description: string; exp_date: string | null } | null
  material_request_items: MRItem[]
}

// 'Labels' moved to its own /labels page — kept in the type for the shared rendering, but hidden from the tab bar.
const FILTERS = ['Open', 'Partially Received', 'Fulfilled', 'All', 'Combined picking', 'Labels', 'Not requested'] as const
const TAB_FILTERS = FILTERS.filter(f => f !== 'Labels')
interface PlannedBatch { id: string; batch_no: string; item_code: string; description: string; factory_code: string; total_quantity: number; produced_qty: number; delivery_date: string | null }
type Filter = typeof FILTERS[number]

// Statuses that still need picking — pooled into the combined list
const ACTIVE = ['Open', 'Partially Received']

const STATUS_STYLE: Record<string, string> = {
  Open: 'bg-amber-100 text-amber-700',
  'Partially Received': 'bg-blue-100 text-blue-700',
  Fulfilled: 'bg-green-100 text-green-700',
}

export default function MaterialRequestsPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'material_requests')
  const canEdit = profile ? can(profile, 'material_requests', 'edit') : false
  // Warehouse staff record receipts/SO for every released run they see, so they're
  // never treated as view-only here; everyone else honours per-factory view-only.
  const canEditFac = (fc: string) => isWarehouse || can(profile, 'material_requests', 'edit', fc)
  const [requests, setRequests] = useState<MaterialRequest[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<Filter>('Open')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [factoryItems, setFactoryItems] = useState<Set<string>>(new Set()) // item codes supplied by the factory
  const [grnSet, setGrnSet] = useState<Set<string>>(new Set()) // `${factory}|${code}` that appear on an uploaded Goods Received doc
  const [notReq, setNotReq] = useState<PlannedBatch[]>([]) // batches with no material request raised yet
  const [pcsPerRoll, setPcsPerRoll] = useState<Record<string, number>>({}) // roll items: code -> pieces per roll
  const [soEdits, setSoEdits] = useState<Record<string, string>>({}) // run no -> SO number being typed
  // Move-received-qty modal
  const [moveSrc, setMoveSrc] = useState<{ it: MRItem; r: MaterialRequest } | null>(null)
  const [moveQty, setMoveQty] = useState('')
  const [moveTargetId, setMoveTargetId] = useState('')
  const [moveReason, setMoveReason] = useState('')
  const [movePending, setMovePending] = useState<Set<string>>(new Set())
  const [labelEdits, setLabelEdits] = useState<Record<string, { batch: string; exp: string; qty: string }>>({}) // item id -> label batch/exp/print-qty being typed
  const [selLabels, setSelLabels] = useState<Set<string>>(new Set())   // labels ticked to send
  // Manual request (raise an item by hand while the system is new)
  const [itemsMaster, setItemsMaster] = useState<{ code: string; description: string; unit: string }[]>([])
  const [showManual, setShowManual] = useState(false)
  const [manFac, setManFac] = useState('')
  const [manItem, setManItem] = useState<{ code: string; description: string; unit: string } | null>(null)
  const [manQty, setManQty] = useState('')
  const [manLines, setManLines] = useState<{ code: string; description: string; unit: string; qty: number }[]>([])   // items staged for one manual request
  const toggleLabel = (id: string) => setSelLabels(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const isWarehouse = !!profile?.warehouse_user   // warehouse staff: only released pick runs + SO entry
  // Warehouse staff land straight on the released pick runs and can't see the other tabs.
  useEffect(() => { if (profile?.warehouse_user) setFilter('Combined picking') }, [profile])
  const multiFac = isHO || (profile?.factory_codes?.length || 0) > 1   // sees more than one factory

  useEffect(() => { if (profile) { load(); loadFactories(); loadFactoryItems(); loadRolls(); loadGrn(); loadNotReq(); loadItemsMaster() } }, [profile])

  async function loadItemsMaster() {
    setItemsMaster(await fetchAll<{ code: string; description: string; unit: string }>('items', 'code, description, unit'))
  }
  function addManualLine() {
    if (!manItem) { setError('Pick an item.'); return }
    const q = Number(manQty)
    if (!(q > 0)) { setError('Enter a quantity greater than zero.'); return }
    setError('')
    setManLines(prev => { const i = prev.findIndex(l => l.code === manItem.code); if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], qty: n[i].qty + q }; return n } return [...prev, { code: manItem.code, description: manItem.description, unit: manItem.unit, qty: q }] })
    setManItem(null); setManQty('')
  }
  async function submitManualRequest() {
    const facOpts = (isHO ? factories.map(f => f.code) : (profile?.factory_codes?.length ? profile.factory_codes : [profile?.factory_code || ''])).filter(c => c && canEditFac(c))
    const fac = facOpts.includes(manFac) ? manFac : (facOpts[0] || '')
    if (!fac) { setError('You are not allowed to request for any location.'); return }
    if (!canEditFac(fac)) { setError('You have view-only access at this factory.'); return }
    // Include a line still being typed but not yet added
    const pending = manItem && Number(manQty) > 0 ? [{ code: manItem.code, description: manItem.description, unit: manItem.unit, qty: Number(manQty) }] : []
    const lines = [...manLines, ...pending]
    if (lines.length === 0) { setError('Add at least one item.'); return }
    setBusy('manual'); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('raise_manual_material_request', { p_factory: fac, p_items: lines })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Manual request added (${lines.length} item${lines.length > 1 ? 's' : ''}) — waiting to release for ${factoryName(fac)}.`)
    setManItem(null); setManQty(''); setManLines([]); setShowManual(false)
    load()
  }

  // Planned batches that have NOT had a material request raised yet
  async function loadNotReq() {
    const { data } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, delivery_date')
      .is('material_request_id', null).order('factory_code').order('delivery_date')
    setNotReq(((data as PlannedBatch[]) || []).filter(b => Number(b.produced_qty || 0) < b.total_quantity))
  }
  async function loadRolls() {
    const { data } = await supabase.from('items').select('code, pcs_per_roll').not('pcs_per_roll', 'is', null)
    const m: Record<string, number> = {}; (data || []).forEach(r => { if (r.pcs_per_roll) m[r.code] = Number(r.pcs_per_roll) }); setPcsPerRoll(m)
  }
  // Roll items are picked in whole rolls (round up); everything else in its own unit.
  const pickDisplay = (code: string, pcQty: number, unit: string) => {
    const per = pcsPerRoll[code]
    if (per) return { qty: Math.ceil(pcQty / per), unit: 'roll' }
    return { qty: Number(Number(pcQty).toPrecision(12)), unit }
  }

  async function load() {
    const { data } = await supabase
      .from('material_requests')
      .select('*, production_batches!batch_id(batch_no, item_code, description, exp_date), material_request_items(*)')
      .order('created_at', { ascending: false })
    setRequests((data as MaterialRequest[]) || [])
    const { data: mv } = await supabase.from('mr_qty_move_requests').select('from_item_id').eq('status', 'Pending')
    setMovePending(new Set((mv || []).map(x => x.from_item_id).filter(Boolean)))
  }

  // Candidate target request-items to move received qty INTO: same material, a
  // different request, still needing some (released requests only).
  function moveTargets(it: MRItem, r: MaterialRequest) {
    const out: { id: string; label: string; remaining: number }[] = []
    requests.forEach(r2 => {
      if (r2.id === r.id || !r2.released_at) return
      ;(r2.material_request_items || []).forEach(t => {
        if (t.item_code !== it.item_code) return
        out.push({ id: t.id, label: `${r2.pick_run_no || r2.request_no} · ${r2.production_batches?.batch_no || ''}`, remaining: Math.max(0, t.requested_qty - t.received_qty) })
      })
    })
    return out
  }
  function openMove(it: MRItem, r: MaterialRequest) {
    setMoveSrc({ it, r }); setMoveQty(''); setMoveTargetId(''); setMoveReason(''); setError(''); setSuccess('')
  }
  async function submitMove() {
    if (!moveSrc || !profile) return
    const { it, r } = moveSrc
    const q = Number(moveQty)
    if (!(q > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (q > it.received_qty) { setError(`Only ${it.received_qty} ${it.unit} received on this request.`); return }
    if (!moveTargetId) { setError('Pick the request to move it to.'); return }
    if (!moveReason.trim()) { setError('Please give a reason.'); return }
    const tgt = moveTargets(it, r).find(t => t.id === moveTargetId)
    setBusy('move'); setError(''); setSuccess('')
    const { error: e } = await supabase.from('mr_qty_move_requests').insert({
      from_item_id: it.id, to_item_id: moveTargetId, factory_code: r.factory_code, item_code: it.item_code, qty: q, reason: moveReason.trim(),
      from_label: `${r.pick_run_no || r.request_no} · ${r.production_batches?.batch_no || ''}`, to_label: tgt?.label || '',
      requested_by: profile.id, requested_by_name: profile.full_name || null,
    })
    setBusy('')
    if (e) { setError(e.message); return }
    setMoveSrc(null); setSuccess('Move request sent to Head Office for approval.'); load()
  }
  async function loadFactoryItems() {
    const { data } = await supabase.from('items').select('code').eq('supplied_by_factory', true)
    setFactoryItems(new Set((data || []).map(r => r.code)))
  }
  // Item codes (per factory) that appear on any uploaded Goods Received doc — once a
  // GRN is uploaded for a material, its labels unlock (no need to QC/Receive first).
  async function loadGrn() {
    const [{ data: dos }, { data: dls }] = await Promise.all([
      supabase.from('delivery_orders').select('id, factory_code'),
      supabase.from('delivery_order_lines').select('do_id, item_code'),
    ])
    const fac: Record<string, string> = {}; (dos || []).forEach(d => { fac[d.id] = d.factory_code })
    const s = new Set<string>()
    ;(dls || []).forEach(l => { const f = fac[l.do_id]; if (!f || !l.item_code) return; s.add(`${f}|${l.item_code}`); s.add(`${f}|${grnBase(l.item_code)}`) })
    setGrnSet(s)
  }
  // Strip a trailing pack-size suffix ("D955-15KG/BAG" -> "D955") but keep variant codes ("P93541-3000")
  const grnBase = (code: string) => code.replace(/-\d+(?:KG|UN|UNIT|PKT|PACK|G|CTN|BAG|ML|L)\b.*$/i, '')
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'
  // Show stored dates (YYYY-MM-DD) as DD/MM/YYYY
  const fmtExp = (d: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || '')
  }

  // Release the waiting (unreleased) requests of a factory to the warehouse as one pick run,
  // stamping them with the same released_at so they group together and stop growing.
  async function release(factory: string) {
    if (!canEditFac(factory)) { setError("You have view-only access at this factory."); return }
    const key = `release|${factory}`
    setBusy(key); setError(''); setSuccess('')
    const { data, error: relErr } = await supabase.rpc('release_pick_run', { p_factory: factory })
    if (relErr) { setError(relErr.message); setBusy(''); return }
    setSuccess(`Released to the warehouse as pick run ${data}.`)
    setBusy('')
    load()
  }

  // Save an expiry date entered inline on the factory list (writes to the product's batch)

  async function cancelRequest(r: MaterialRequest) {
    if (!canEditFac(r.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!confirm(`Cancel ${r.request_no}? This frees its batch(es) so you can re-raise (e.g. combined). Nothing has been received yet.`)) return
    setBusy(`cancel|${r.id}`); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('cancel_material_request', { p_id: r.id })
    if (e) { setError(e.message); setBusy(''); return }
    setSuccess(`${r.request_no} cancelled — its batch(es) are back on the Order Board.`)
    setBusy('')
    load()
  }

  // Released to the warehouse already → cancelling needs Head Office approval
  async function requestMrCancel(r: MaterialRequest) {
    if (!canEditFac(r.factory_code)) { setError("You have view-only access at this factory."); return }
    const reason = window.prompt(`Request to cancel ${r.request_no}?\n\nIt has already been sent to the warehouse, so Head Office must approve. On approval its batch(es) are freed.\n\nReason (optional):`, '')
    if (reason === null) return
    setBusy(`reqcancel|${r.id}`); setError(''); setSuccess('')
    const { error: e } = await supabase.from('mr_cancel_requests').insert({
      material_request_id: r.id, request_no: r.request_no, factory_code: r.factory_code,
      reason: reason || null, requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Cancel request sent for ${r.request_no} — waiting for Head Office approval.`)
  }

  // Has a Goods Received Note been uploaded covering this request's raw materials?
  // Labels unlock once the GRN is uploaded — no need to QC-tick / Receive first.
  function rawFraction(r: MaterialRequest) {
    const raw = (r.material_request_items || []).filter(it => !factoryItems.has(it.item_code))
    if (raw.length === 0) return 1
    const covered = raw.some(it => grnSet.has(`${r.factory_code}|${it.item_code}`) || grnSet.has(`${r.factory_code}|${grnBase(it.item_code)}`))
    return covered ? 1 : 0
  }
  // Labels printable once unlocked — full requested quantity (the user can lower the Print qty)
  const labelAvail = (r: MaterialRequest, it: MRItem) => Math.floor(rawFraction(r) * it.requested_qty)
  // Save a label item's batch no. / expiry / print qty (at least batch or expiry required)
  async function saveLabel(it: MRItem, r: MaterialRequest) {
    if (!canEditFac(r.factory_code)) { setError("You have view-only access at this factory."); return }
    const e = labelEdits[it.id] ?? { batch: it.label_batch_no ?? '', exp: it.label_exp_date ?? '', qty: String(it.label_print_qty ?? labelAvail(r, it)) }
    const batch = e.batch.trim()
    if (!batch && !e.exp) { setError('Enter a batch number or an expiry date (at least one) for the label.'); return }
    const qty = e.qty === '' ? labelAvail(r, it) : Number(e.qty)
    if (qty > labelAvail(r, it)) { setError(`Only ${labelAvail(r, it)} can be printed now (that's all the received materials cover).`); return }
    setBusy(`label|${it.id}`); setError(''); setSuccess('')
    const { error: er } = await supabase.from('material_request_items').update({ label_batch_no: batch || null, label_exp_date: e.exp || null, label_print_qty: qty }).eq('id', it.id)
    if (er) { setError(er.message); setBusy(''); return }
    setSuccess(`Label details saved for ${it.item_code}.`)
    setBusy('')
    setLabelEdits(prev => { const n = { ...prev }; delete n[it.id]; return n })
    load()
  }
  // Printer attaches a photo of the printed label
  async function uploadLabelPhoto(it: MRItem, r: MaterialRequest, file: File) {
    if (!canEditFac(r.factory_code)) { setError("You have view-only access at this factory."); return }
    setBusy(`lphoto|${it.id}`); setError('')
    const path = `labels/${it.id}.jpg`
    const { error: upErr } = await supabase.storage.from('delivery-orders').upload(path, file, { upsert: true, contentType: file.type || 'image/jpeg' })
    if (upErr) { setError(`Photo upload failed: ${upErr.message}`); setBusy(''); return }
    await supabase.from('material_request_items').update({ label_photo_path: path }).eq('id', it.id)
    setBusy(''); setSuccess(`Photo attached for ${it.item_code}.`); load()
  }
  async function viewLabelPhoto(path: string) {
    const { data } = await supabase.storage.from('delivery-orders').createSignedUrl(path, 120)
    if (data) window.open(data.signedUrl, '_blank')
  }
  // Send the ticked labels into stock (each needs a saved print qty + a photo)
  async function sendLabels(run: { runNo: string; reqs: MaterialRequest[] }) {
    if (!canEditFac(run.reqs[0]?.factory_code || '')) { setError("You have view-only access at this factory."); return }
    const labels = run.reqs.flatMap(r => (r.material_request_items || []).filter(it => factoryItems.has(it.item_code) && selLabels.has(it.id) && !it.label_received_at))
    if (labels.length === 0) { setError('Tick at least one label to send.'); return }
    for (const it of labels) {
      if (!it.label_photo_path) { setError(`Attach a photo for ${it.item_code} before sending.`); return }
      if (!(Number(it.label_print_qty) > 0)) { setError(`Save a print quantity for ${it.item_code} before sending.`); return }
    }
    if (!confirm(`Send ${labels.length} label(s) into stock?`)) return
    setBusy(`sendlabels|${run.runNo}`); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('receive_labels', { p_item_ids: labels.map(l => l.id) })
    if (e) { setError(e.message); setBusy(''); return }
    setSuccess(`${labels.length} label(s) sent into stock.`); setBusy(''); setSelLabels(new Set()); load()
  }

  async function requestRunCancel(run: { runNo: string; reqs: MaterialRequest[] }) {
    if (!canEditFac(run.reqs[0]?.factory_code || '')) { setError("You have view-only access at this factory."); return }
    if (!confirm(`Request to cancel released pick run ${run.runNo} (${run.reqs.length} request(s))?\n\nIt has been sent to the warehouse, so Head Office must approve. On approval the batches are freed.`)) return
    const reason = window.prompt('Reason (optional):', '') ?? ''
    setBusy(`runcancel|${run.runNo}`); setError(''); setSuccess('')
    const rows = run.reqs.map(r => ({ material_request_id: r.id, request_no: r.request_no, factory_code: r.factory_code, reason: reason || null, requested_by: profile?.id, requested_by_name: profile?.full_name || null }))
    const { error: e } = await supabase.from('mr_cancel_requests').insert(rows)
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Cancel request sent for ${run.runNo} — waiting for Head Office approval.`)
  }

  // Warehouse records the SO number against a released pick run (saved on all its requests).
  // Once set it's locked — changing it later needs Head Office approval.
  async function saveSo(run: { runNo: string; reqs: MaterialRequest[] }) {
    if (!canEditFac(run.reqs[0]?.factory_code || '')) { setError("You have view-only access at this factory."); return }
    if (run.reqs[0]?.warehouse_so_no) { setError('SO number is already set — use “Request change” for Head Office approval.'); return }
    const val = (soEdits[run.runNo] ?? '').trim()
    if (!val) { setError('Enter an SO number first.'); return }
    setBusy(`so|${run.runNo}`); setError(''); setSuccess('')
    const ids = run.reqs.map(r => r.id)
    const { error: upErr } = await supabase.from('material_requests')
      .update({ warehouse_so_no: val, so_set_by: profile?.id || null, so_set_by_name: profile?.full_name || null, so_set_at: new Date().toISOString() })
      .in('id', ids)
    if (upErr) { setError(upErr.message); setBusy(''); return }
    setSuccess(`SO number saved for ${run.runNo}.`)
    setBusy('')
    setSoEdits(prev => { const n = { ...prev }; delete n[run.runNo]; return n })
    load()
  }

  // Ask Head Office to change an already-set SO number.
  async function requestSoChange(run: { runNo: string; reqs: MaterialRequest[] }) {
    if (!profile) return
    const cur = run.reqs[0]?.warehouse_so_no || ''
    const next = window.prompt(`Change SO number for ${run.runNo} (currently ${cur}).\nNew SO number:`, cur)
    if (next === null) return
    if (!next.trim() || next.trim() === cur) { setError('Enter a different SO number.'); return }
    const reason = window.prompt('Reason for the change (sent to Head Office):') || ''
    setError(''); setSuccess('')
    const { error: e } = await supabase.from('so_change_requests').insert({
      pick_run_no: run.runNo, factory_code: run.reqs[0]?.factory_code, old_so: cur, new_so: next.trim(), reason: reason || null,
      requested_by: profile.id, requested_by_name: profile.full_name || null,
    })
    if (e) { setError(e.message); return }
    setSuccess(`SO change for ${run.runNo} sent to Head Office for approval.`)
  }


  // Build a printable Material Picking List PDF for a released run, and download it
  async function downloadPickRunPdf(runNo: string, factory: string, released_at: string, mats: MatMap, audience: string) {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const list = Object.values(mats).sort((a, b) => a.code.localeCompare(b.code))
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN BHD', 14, 16)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal')
    doc.text(`Material List — for ${audience}`, 14, 23)
    doc.setFontSize(10)
    doc.text(`Pick run: ${runNo}`, 14, 32)
    doc.text(`Factory: ${factoryName(factory)} (${factory})`, 14, 38)
    doc.text(`Released: ${new Date(released_at).toLocaleString()}`, 14, 44)
    doc.text(`Printed: ${new Date().toLocaleString()}`, 120, 44)
    autoTable(doc, {
      startY: 50,
      head: [['#', 'Material', 'Description', 'Unit', 'Qty to pick', 'Picked', 'Remarks']],
      body: list.map((g, i) => { const d = pickDisplay(g.code, g.requested, g.unit); return [String(i + 1), g.code, g.description, d.unit, String(d.qty), '', ''] }),
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] },
      columnStyles: { 4: { halign: 'right' } },
    })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 16
    doc.text('Picked by: ____________________   Date: __________', 14, endY)
    doc.text('Received by: ___________________   Date: __________', 14, endY + 10)
    doc.save(`PickRun_${runNo.replace(/\//g, '-')}_${factory}_${audience}.pdf`)
  }

  // Factory (label) list PDF: one row per product so labels carry the product name + expiry date (not combined)
  async function downloadFactoryPdf(runNo: string, factory: string, released_at: string, reqs: MaterialRequest[]) {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const docNo = `L${runNo}`
    const doc = new jsPDF({ orientation: 'landscape' })
    const body: string[][] = []
    let n = 1
    reqs.forEach(r => {
      (r.material_request_items || []).filter(it => factoryItems.has(it.item_code)).forEach(it => {
        const printQty = it.label_print_qty != null ? it.label_print_qty : it.requested_qty
        body.push([String(n++), r.production_batches?.item_code || '', r.production_batches?.description || '',
          it.label_exp_date ? fmtExp(it.label_exp_date) : (fmtExp(r.production_batches?.exp_date) || '—'), it.label_batch_no || '—',
          it.item_code, it.description, it.unit, String(printQty), ''])
      })
    })
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN BHD', 14, 16)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal')
    doc.text('Label Request — for Factory', 14, 23)
    doc.setFontSize(10)
    doc.text(`Document: ${docNo}`, 14, 32)
    doc.text(`Factory: ${factoryName(factory)} (${factory})`, 14, 38)
    doc.text(`Released: ${new Date(released_at).toLocaleString()}`, 150, 32)
    doc.text(`Printed: ${new Date().toLocaleString()}`, 150, 38)
    autoTable(doc, {
      startY: 44,
      head: [['#', 'Product', 'Product name', 'EXP date', 'Batch No.', 'Material', 'Description', 'Unit', 'Print qty', 'Made']],
      body,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [126, 58, 242] },
      columnStyles: { 8: { halign: 'right' } },
    })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 16
    doc.text('Prepared by: __________________   Date: __________', 14, endY)
    doc.text('Received by: ___________________   Date: __________', 14, endY + 10)
    doc.save(`${docNo.replace(/\//g, '-')}_${factory}.pdf`)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' || filter === 'Combined picking' ? requests : requests.filter(r => r.status === filter)
  const counts: Record<string, number> = { Open: 0, 'Partially Received': 0, Fulfilled: 0 }
  requests.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })

  // Pool active requests by material, summing quantities. Underlying request lines stay
  // intact. Unreleased requests sit in a per-factory "waiting" pool until released; once
  // released they form a frozen pick run (grouped by factory + released_at) the warehouse picks.
  interface CombMat { code: string; description: string; unit: string; requested: number; received: number; items: { id: string; requested_qty: number; received_qty: number }[] }
  type MatMap = Record<string, CombMat>
  const addItem = (mats: MatMap, it: MRItem) => {
    const g = (mats[it.item_code] = mats[it.item_code] || { code: it.item_code, description: it.description, unit: it.unit, requested: 0, received: 0, items: [] })
    g.requested += Number(it.requested_qty)
    g.received += Number(it.received_qty)
    g.items.push({ id: it.id, requested_qty: Number(it.requested_qty), received_qty: Number(it.received_qty) })
  }
  const waiting: Record<string, MatMap> = {}                                  // factory -> materials not yet released
  const runs: Record<string, { runNo: string; factory: string; released_at: string; mats: MatMap; reqs: MaterialRequest[] }> = {} // run id -> run
  requests.filter(r => ACTIVE.includes(r.status)).forEach(r => {
    const runId = r.pick_run_no || (r.released_at ? `${r.factory_code}|${r.released_at}` : '')
    if (r.released_at) {
      const run = (runs[runId] = runs[runId] || { runNo: r.pick_run_no || '(unnumbered)', factory: r.factory_code, released_at: r.released_at, mats: {}, reqs: [] })
      run.reqs.push(r)
      r.material_request_items?.forEach(it => addItem(run.mats, it))
    } else {
      const target = (waiting[r.factory_code] = waiting[r.factory_code] || {})
      // Labels (made at the factory) are not picked from the warehouse — keep them out of this list
      r.material_request_items?.forEach(it => { if (!factoryItems.has(it.item_code)) addItem(target, it) })
    }
  })
  // Oldest request first for allocation: requests arrive newest-first, so reverse the pooled lines
  const allMaps = [...Object.values(waiting), ...Object.values(runs).map(run => run.mats)]
  allMaps.forEach(mats => Object.values(mats).forEach(g => g.items.reverse()))
  const waitingFactories = Object.keys(waiting).filter(f => Object.keys(waiting[f]).length > 0).sort()
  const runList = Object.values(runs).sort((a, b) => b.released_at.localeCompare(a.released_at) || a.factory.localeCompare(b.factory))
  const hasCombined = waitingFactories.length > 0 || runList.length > 0

  // Split a material pool into warehouse-picked vs factory-supplied (e.g. printed labels)
  const splitBySource = (mats: MatMap) => {
    const warehouse: MatMap = {}, factory: MatMap = {}
    Object.entries(mats).forEach(([code, g]) => { (factoryItems.has(code) ? factory : warehouse)[code] = g })
    return { warehouse, factory }
  }
  // Group released runs by how far along they are, for the warehouse list.
  type RunB = { runNo: string; factory: string; released_at: string; mats: MatMap; reqs: MaterialRequest[] }
  const runBucket = (run: RunB): 'new' | 'so' | 'partial' | 'done' => {
    const rs = run.reqs
    if (rs.length > 0 && rs.every(r => r.status === 'Fulfilled')) return 'done'
    if (rs.some(r => r.status === 'Partially Received' || r.status === 'Fulfilled')) return 'partial'
    if (rs[0]?.warehouse_so_no) return 'so'
    return 'new'
  }
  const RUN_BUCKETS = ['new', 'so', 'partial', 'done'] as const
  const BUCKET_LABEL: Record<string, string> = { new: '🆕 New — needs SO number', so: '🧾 SO entered — to pick', partial: '⏳ Partially received', done: '✅ Fully received' }
  const visibleRuns = runList.filter(run => filter === 'Labels'
    ? run.reqs.some(r => (r.material_request_items || []).some(it => factoryItems.has(it.item_code)))
    : Object.keys(splitBySource(run.mats).warehouse).length > 0)
  const orderedRuns = filter === 'Labels'
    ? visibleRuns
    : [...visibleRuns].sort((a, b) => RUN_BUCKETS.indexOf(runBucket(a)) - RUN_BUCKETS.indexOf(runBucket(b)) || b.released_at.localeCompare(a.released_at))

  // One material table; editable=true adds the Received/Remaining columns + receiving (released runs only)
  const renderMatTable = (mats: MatMap, prefix: string, editable: boolean) => {
    const list = Object.values(mats).sort((a, b) => a.code.localeCompare(b.code))
    const heads = ['Material', 'Description', 'Unit', 'To pick', ...(editable ? ['Received', 'Remaining'] : [])]
    const r = (n: number) => Number(Number(n).toPrecision(12))
    return (
      <>
      {/* Mobile: cards */}
      <div className="md:hidden space-y-2">
        {list.map(g => {
          const remaining = Math.max(0, g.requested - g.received); const per = pcsPerRoll[g.code]
          const toPick = per ? Math.ceil(g.requested / per) : r(g.requested)
          return (
            <div key={`m|${prefix}|${g.code}`} className={`border rounded-lg p-2.5 ${editable && g.received >= g.requested ? 'bg-green-50/40' : ''}`}>
              <div className="flex items-baseline justify-between gap-2"><span className="font-mono font-medium text-sm">{g.code}</span><span className="text-blue-700 font-semibold text-sm">{toPick} {per ? 'roll' : g.unit}</span></div>
              <div className="text-gray-600 text-xs">{g.description}</div>
              {editable && <div className="text-xs text-gray-500 mt-1">Received <strong className="text-gray-700">{per ? r(g.received / per) : r(g.received)}</strong> · Remaining <strong className={remaining > 0 ? 'text-red-600' : 'text-green-600'}>{per ? r(remaining / per) : r(remaining)}</strong></div>}
            </div>
          )
        })}
      </div>
      {/* Desktop: table */}
      <div className="hidden md:block overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>{heads.map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
          </thead>
          <tbody>
            {list.map(g => {
              const key = `${prefix}|${g.code}`
              const remaining = Math.max(0, g.requested - g.received)
              const done = g.received >= g.requested
              const per = pcsPerRoll[g.code]
              const r = (n: number) => Number(Number(n).toPrecision(12))
              const toPick = per ? Math.ceil(g.requested / per) : r(g.requested)
              const recv = per ? r(g.received / per) : r(g.received)
              const rem = per ? r(remaining / per) : r(remaining)
              return (
                <tr key={key} className={`border-b last:border-0 ${editable && done ? 'bg-green-50/40' : ''}`}>
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{g.code}</td>
                  <td className="px-3 py-2 text-gray-600">{g.description}</td>
                  <td className="px-3 py-2 text-gray-500">{per ? 'roll' : g.unit}</td>
                  <td className="px-3 py-2 text-right font-semibold text-blue-700">{toPick}{per ? <span className="text-gray-400 font-normal"> ({r(g.requested)} pc)</span> : null}</td>
                  {editable && <>
                    <td className="px-3 py-2 text-right text-gray-700">{recv}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{rem}</td>
                  </>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      </>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Material Requests</h1>
        <p className="text-gray-500 text-sm mb-5">
          Shortfall materials requested from the warehouse.
          {isHO ? ' Showing all factories.' : multiFac ? ` Showing ${(profile.factory_codes || []).length} factories.` : ` Showing factory ${profile.factory_code}.`}
        </p>
        <p className="text-gray-400 text-xs mb-5 -mt-3">Open requests refresh automatically when the BOM or stock changes. Once you start recording received quantities, the request is frozen. To receive a whole Delivery Order at once, use the <strong>Goods Received</strong> tab.</p>

        {!isWarehouse && (
          <div className="flex gap-2 mb-5">
            {TAB_FILTERS.map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {f}{f === 'Not requested' ? (notReq.length ? ` (${notReq.length})` : '') : (f !== 'All' && counts[f] ? ` (${counts[f]})` : '')}
              </button>
            ))}
          </div>
        )}
        {isWarehouse && <p className="text-gray-500 text-sm bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-4">📦 Warehouse view — released pick runs only. Enter the SO number and record what you pick.</p>}

        {!isWarehouse && canEdit && (() => {
          // Only locations this user is allowed to edit can be requested for
          const facOpts = (isHO ? factories.map(f => f.code) : (profile?.factory_codes?.length ? profile.factory_codes : [profile?.factory_code || '']))
            .filter(c => c && canEditFac(c))
          if (facOpts.length === 0) return null
          const fac = facOpts.includes(manFac) ? manFac : facOpts[0]
          return (
            <div className="mb-5">
              <button onClick={() => { setShowManual(o => !o); setError(''); setSuccess('') }} className="text-blue-600 hover:underline text-sm font-medium">
                {showManual ? '× Close manual request' : '➕ Request a material manually'}
              </button>
              {showManual && (
                <div className="mt-2 bg-white border rounded-xl shadow-sm p-4">
                  <p className="text-gray-500 text-xs mb-3">Raise materials by hand (not from a batch recipe). Add one or more items, then <strong>Submit request</strong> — they join <strong>Waiting to release</strong> for that factory.</p>
                  <div className="flex flex-wrap items-end gap-3">
                    {facOpts.length > 1 && (
                      <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory</span>
                        <select value={fac} onChange={e => setManFac(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
                          {facOpts.map(c => <option key={c} value={c}>{isHO ? factoryName(c) : c}</option>)}
                        </select></div>
                    )}
                    <div className="flex flex-col gap-1 flex-1 min-w-[16rem]"><span className="text-xs font-medium text-gray-600">Item</span>
                      <ItemPicker items={itemsMaster} value={manItem ? `${manItem.code} — ${manItem.description}` : ''} onPick={it => setManItem(it)} />
                    </div>
                    <div className="flex flex-col gap-1 w-28"><span className="text-xs font-medium text-gray-600">Qty{manItem ? ` (${manItem.unit})` : ''}</span>
                      <input type="number" step="any" value={manQty} onChange={e => setManQty(e.target.value)} className="border rounded-lg px-3 py-2 text-sm text-right" /></div>
                    <button onClick={addManualLine} className="border border-blue-600 text-blue-600 px-4 py-2 rounded-lg hover:bg-blue-50 text-sm font-medium">+ Add item</button>
                  </div>
                  {manLines.length > 0 && (
                    <div className="mt-3 border rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b"><tr>{['Item', 'Description', 'Qty', ''].map(h => <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600">{h}</th>)}</tr></thead>
                        <tbody>
                          {manLines.map((l, i) => (
                            <tr key={l.code} className="border-b last:border-0">
                              <td className="px-3 py-1.5 font-mono font-medium whitespace-nowrap">{l.code}</td>
                              <td className="px-3 py-1.5 text-gray-600">{l.description}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{Number(Number(l.qty).toPrecision(12))} {l.unit}</td>
                              <td className="px-3 py-1.5 text-right"><button onClick={() => setManLines(prev => prev.filter((_, x) => x !== i))} className="text-red-500 hover:underline text-xs">remove</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button onClick={submitManualRequest} disabled={busy === 'manual'} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{busy === 'manual' ? 'Submitting…' : `Submit request${manLines.length ? ` (${manLines.length} item${manLines.length > 1 ? 's' : ''})` : ''}`}</button>
                    {manLines.length > 0 && <button onClick={() => setManLines([])} className="text-gray-500 hover:underline text-xs">Clear list</button>}
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {filter === 'Not requested' ? (
          (() => {
            const list = notReq.filter(b => isHO || (profile.factory_codes?.length ? profile.factory_codes.includes(b.factory_code) : b.factory_code === profile.factory_code))
            if (list.length === 0) return <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">🎉 Every planned batch has had its materials requested.</div>
            const byFac: Record<string, PlannedBatch[]> = {}; list.forEach(b => { (byFac[b.factory_code] = byFac[b.factory_code] || []).push(b) })
            return (
              <div className="space-y-5 max-h-[40rem] overflow-y-auto pr-1">
                <p className="text-gray-500 text-sm">These planned batches have <strong>no material request yet</strong>. Raise materials for them on the <a href="/production" className="text-blue-600 hover:underline">Order Board</a> (Materials button).</p>
                {Object.keys(byFac).sort().map(fac => (
                  <div key={fac} className="bg-white rounded-xl shadow-sm border overflow-hidden">
                    <div className="px-4 py-2 bg-amber-50 border-b text-sm font-semibold text-amber-800">🏭 {isHO ? factoryName(fac) : fac} <span className="font-normal text-amber-600">· {byFac[fac].length} batch(es) not requested</span></div>
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b"><tr>{['Batch', 'Item', 'Qty', 'Delivery'].map(h => <th key={h} className="text-left px-4 py-2 font-medium text-gray-600">{h}</th>)}</tr></thead>
                      <tbody>
                        {byFac[fac].map(b => (
                          <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                            <td className="px-4 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                            <td className="px-4 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span></td>
                            <td className="px-4 py-2 text-right font-semibold">{b.total_quantity}</td>
                            <td className="px-4 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? b.delivery_date.split('-').reverse().join('/') : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )
          })()
        ) : filter === 'Combined picking' || filter === 'Labels' ? (
          !hasCombined ? (
            <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
              {filter === 'Labels' ? 'No labels yet — release a material request, then upload its Goods Received Note to unlock label printing.' : <>Nothing to pick — no open requests.<br />Raise material requests from batches on the Production board.</>}
            </div>
          ) : (
            <div className="space-y-8">
              {filter !== 'Labels' && !isWarehouse && waitingFactories.length > 0 && (
                <div>
                  <h2 className="font-semibold text-gray-800 mb-1">⏳ Waiting to release</h2>
                  <p className="text-gray-500 text-sm mb-3">
                    New requests collect here. When ready, <strong>Release to warehouse</strong> to send a fixed pick run —
                    anything raised afterwards waits for the next release, so the warehouse always has a clear cut-off.
                  </p>
                  <div className="space-y-4">
                    {waitingFactories.map(fac => (
                      <div key={fac} className="bg-white rounded-xl shadow-sm border p-5">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="font-semibold">{isHO ? factoryName(fac) : fac}</span>
                          <span className="text-sm text-gray-400">· {Object.keys(waiting[fac]).length} material(s) waiting</span>
                          {canEditFac(fac) && <button onClick={() => release(fac)} disabled={busy === `release|${fac}`}
                            className="ml-auto bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
                            {busy === `release|${fac}` ? 'Releasing…' : 'Release to warehouse →'}
                          </button>}
                        </div>
                        {renderMatTable(waiting[fac], `wait|${fac}`, false)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {runList.length > 0 && (
                <div>
                  <h2 className="font-semibold text-gray-800 mb-1">{filter === 'Labels' ? '🏷️ Labels to print' : '📦 Released pick runs'}</h2>
                  <p className="text-gray-500 text-sm mb-3">
                    {filter === 'Labels'
                      ? <>Each card is a <strong>product</strong> — print its labels once its raw materials arrive. Enter batch / expiry and the quantity to print.</>
                      : <>Pick each run's totals in one trip. Type the <strong>total received</strong> for a material — it is split back across the original requests automatically.</>}
                  </p>
                  <div className="space-y-4">
                    {orderedRuns.map((run, idx) => {
                      const rkey = run.runNo
                      const { warehouse } = splitBySource(run.mats)
                      const facReqs = run.reqs.filter(r => (r.material_request_items || []).some(it => factoryItems.has(it.item_code)))
                      const bucket = filter === 'Labels' ? null : runBucket(run)
                      const showHeader = !!bucket && (idx === 0 || runBucket(orderedRuns[idx - 1]) !== bucket)
                      return (
                        <Fragment key={rkey}>
                        {showHeader && <h3 className="text-sm font-semibold text-gray-600 mt-3 mb-1">{BUCKET_LABEL[bucket!]} <span className="text-gray-400 font-normal">· {orderedRuns.filter(rr => runBucket(rr) === bucket).length}</span></h3>}
                        <div className="bg-white rounded-xl shadow-sm border p-5">
                          <div className="flex flex-wrap items-center gap-3 mb-4">
                            <span className="font-semibold">{isHO ? factoryName(run.factory) : run.factory}</span>
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700 font-mono">{run.runNo}</span>
                            <span className="text-sm text-gray-400">released {new Date(run.released_at).toLocaleString()}</span>
                            {filter !== 'Labels' && <>
                            <span className="flex items-center gap-2 ml-auto shrink-0">
                              <span className="text-xs font-medium text-gray-600">SO No.</span>
                              {run.reqs[0]?.warehouse_so_no ? (
                                <>
                                  <span className="font-mono font-medium text-sm">{run.reqs[0].warehouse_so_no}</span>
                                  {run.reqs[0].so_set_by_name && <span className="text-[11px] text-gray-400">by {run.reqs[0].so_set_by_name}{run.reqs[0].so_set_at ? ` · ${new Date(run.reqs[0].so_set_at).toLocaleString()}` : ''}</span>}
                                  {canEditFac(run.factory) && hasCap(profile, 'so_edit') && <button onClick={() => requestSoChange(run)} className="text-blue-600 hover:underline text-xs">Request change</button>}
                                </>
                              ) : canEditFac(run.factory) && hasCap(profile, 'so_edit') ? (
                                <>
                                  <input value={soEdits[run.runNo] ?? ''} onChange={e => setSoEdits(prev => ({ ...prev, [run.runNo]: e.target.value }))}
                                    placeholder="enter SO number" className="border rounded px-2 py-1 text-xs w-40 shrink-0" />
                                  <button onClick={() => saveSo(run)} disabled={busy === `so|${run.runNo}`} className="text-blue-600 hover:underline text-xs disabled:opacity-50">{busy === `so|${run.runNo}` ? 'Saving…' : 'Save'}</button>
                                </>
                              ) : <span className="text-gray-300 text-xs">—</span>}
                            </span>
                            {!isWarehouse && hasCap(profile, 'request_mr_cancel') && <button onClick={() => requestRunCancel(run)} disabled={busy === `runcancel|${run.runNo}`}
                              className="border border-red-300 text-red-600 px-3 py-1 rounded-lg hover:bg-red-50 text-xs font-medium disabled:opacity-50">
                              {busy === `runcancel|${run.runNo}` ? 'Sending…' : '✕ Request cancel (HQ approval)'}</button>}
                            </>}
                          </div>
                          {filter !== 'Labels' && Object.keys(warehouse).length > 0 && (
                            <div className="mb-5">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-sm font-semibold text-gray-700">📦 From warehouse</span>
                                <button onClick={() => downloadPickRunPdf(run.runNo, run.factory, run.released_at, warehouse, 'Warehouse')}
                                  className="ml-auto border border-blue-600 text-blue-600 px-3 py-1 rounded-lg hover:bg-blue-50 text-xs font-medium">⬇ Warehouse PDF</button>
                              </div>
                              {renderMatTable(warehouse, `${rkey}|wh`, true)}
                            </div>
                          )}
                          {filter === 'Labels' && facReqs.length > 0 && (() => {
                            const facLocked = facReqs.some(r => rawFraction(r) <= 0)
                            const labelsMissing = facReqs.some(r => (r.material_request_items || []).filter(it => factoryItems.has(it.item_code)).some(it => !it.label_batch_no && !it.label_exp_date))
                            return (
                            <div>
                              <div className="flex flex-wrap items-center gap-2 mb-2">
                                <span className="text-sm font-semibold text-purple-700">🏭 Made at factory <span className="font-normal text-gray-400">— labels</span></span>
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 font-mono">L{run.runNo}</span>
                                {(() => {
                                  const sel = facReqs.flatMap(r => (r.material_request_items || []).filter(it => factoryItems.has(it.item_code) && selLabels.has(it.id) && !it.label_received_at))
                                  return sel.length > 0 ? (
                                    <button onClick={() => sendLabels(run)} disabled={busy === `sendlabels|${run.runNo}`}
                                      className="ml-auto bg-green-600 text-white px-3 py-1 rounded-lg hover:bg-green-700 text-xs font-medium disabled:opacity-50">{busy === `sendlabels|${run.runNo}` ? 'Sending…' : `Send ${sel.length} label(s) → stock`}</button>
                                  ) : null
                                })()}
                                <button onClick={() => downloadFactoryPdf(run.runNo, run.factory, run.released_at, facReqs)} disabled={facLocked || labelsMissing}
                                  title={facLocked ? 'Locked until the Goods Received Note is uploaded' : labelsMissing ? 'Enter a batch no. or expiry for every label first' : ''}
                                  className={`border border-purple-600 text-purple-600 px-3 py-1 rounded-lg hover:bg-purple-50 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed${facReqs.flatMap(r => (r.material_request_items || []).filter(it => factoryItems.has(it.item_code) && selLabels.has(it.id) && !it.label_received_at)).length > 0 ? '' : ' ml-auto'}`}>⬇ Factory PDF</button>
                              </div>
                              <div className="space-y-3">
                                {facReqs.map(r => {
                                  const facItems = (r.material_request_items || []).filter(it => factoryItems.has(it.item_code))
                                  const frac = rawFraction(r)
                                  const locked = frac <= 0
                                  return (
                                    <div key={r.id} className="border rounded-lg p-3">
                                      {locked && <p className="text-amber-700 text-xs bg-amber-50 border border-amber-200 rounded p-2 mb-2">🔒 Labels unlock once a Goods Received Note for these materials is uploaded (no need to QC-tick or click Receive). Upload the delivery in <strong>Goods Received</strong> to unlock.</p>}
                                      <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
                                        <span className="text-xs text-gray-400 uppercase tracking-wide">Print labels for</span>
                                        <span className="font-bold text-purple-800 text-base">{r.production_batches?.item_code}</span>
                                        <span className="text-gray-700 font-medium">{r.production_batches?.description}</span>
                                        <span className="text-gray-400 text-xs font-mono ml-auto">{r.request_no}</span>
                                      </div>
                                      {/* Mobile: one card per label */}
                                      <div className="md:hidden space-y-2">
                                        {facItems.map(it => {
                                          const avail = labelAvail(r, it)
                                          const le = labelEdits[it.id] ?? { batch: it.label_batch_no ?? '', exp: it.label_exp_date ?? '', qty: String(it.label_print_qty ?? avail) }
                                          const setLe = (patch: Partial<{ batch: string; exp: string; qty: string }>) => setLabelEdits(p => ({ ...p, [it.id]: { batch: p[it.id]?.batch ?? it.label_batch_no ?? '', exp: p[it.id]?.exp ?? it.label_exp_date ?? '', qty: p[it.id]?.qty ?? String(it.label_print_qty ?? avail), ...patch } }))
                                          return (
                                            <div key={`ml|${it.id}`} className="border rounded-lg p-2.5">
                                              <div className="flex items-baseline justify-between gap-2"><span className="font-mono font-medium text-sm">{it.item_code}</span><span className="text-xs text-gray-500">make {it.requested_qty} {it.unit}</span></div>
                                              <div className="text-gray-600 text-xs">{it.description}</div>
                                              {locked ? <div className="text-amber-700 text-xs mt-1">🔒 locked until GRN uploaded</div> : (
                                                <div className="mt-2 grid grid-cols-2 gap-2">
                                                  <label className="text-xs text-gray-500">Available now<div className="font-semibold text-blue-700">{avail}</div></label>
                                                  <label className="text-xs text-gray-500">Print qty<input type="number" min="0" max={avail} value={le.qty} onChange={e => setLe({ qty: e.target.value })} className="border rounded px-2 py-1 text-sm w-full" /></label>
                                                  <label className="text-xs text-gray-500">Batch No.<input value={le.batch} onChange={e => setLe({ batch: e.target.value })} placeholder="batch no." className="border rounded px-2 py-1 text-sm w-full" /></label>
                                                  <label className="text-xs text-gray-500">Expiry<input type="date" value={le.exp} onChange={e => setLe({ exp: e.target.value })} className="border rounded px-2 py-1 text-sm w-full" /></label>
                                                  <button onClick={() => saveLabel(it, r)} disabled={busy === `label|${it.id}`} className="col-span-2 bg-blue-600 text-white rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50">{busy === `label|${it.id}` ? 'Saving…' : 'Save'}{(it.label_batch_no || it.label_exp_date) ? ' ✓' : ''}</button>
                                                  {it.label_received_at ? <span className="col-span-2 text-green-600 text-xs font-medium">✓ Sent to stock</span> : (
                                                    <div className="col-span-2 flex items-center gap-3">
                                                      {it.label_photo_path
                                                        ? <button onClick={() => viewLabelPhoto(it.label_photo_path!)} className="text-green-600 hover:underline text-xs">✓ Photo</button>
                                                        : <label className="text-blue-600 hover:underline text-xs cursor-pointer">{busy === `lphoto|${it.id}` ? '…' : '📷 Photo'}<input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadLabelPhoto(it, r, f); e.target.value = '' }} /></label>}
                                                      <label className="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" className="h-4 w-4" checked={selLabels.has(it.id)} onChange={() => toggleLabel(it.id)} /> send</label>
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </div>
                                          )
                                        })}
                                      </div>
                                      {/* Desktop: table */}
                                      <div className="hidden md:block overflow-x-auto border rounded-lg">
                                        <table className="w-full text-sm">
                                          <thead className="bg-gray-50 border-b">
                                            <tr>{['Material', 'Description', 'Unit', 'To make', 'Made', 'Remaining', ...(locked ? [] : ['Available now', 'Print qty', 'Batch No.', 'Expiry', ''])].map((h, hi) => <th key={hi} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
                                          </thead>
                                          <tbody>
                                            {facItems.map(it => {
                                              const done = it.received_qty >= it.requested_qty
                                              const remaining = Math.max(0, it.requested_qty - it.received_qty)
                                              const avail = labelAvail(r, it)
                                              const le = labelEdits[it.id] ?? { batch: it.label_batch_no ?? '', exp: it.label_exp_date ?? '', qty: String(it.label_print_qty ?? avail) }
                                              const setLe = (patch: Partial<{ batch: string; exp: string; qty: string }>) => setLabelEdits(p => ({ ...p, [it.id]: { batch: p[it.id]?.batch ?? it.label_batch_no ?? '', exp: p[it.id]?.exp ?? it.label_exp_date ?? '', qty: p[it.id]?.qty ?? String(it.label_print_qty ?? avail), ...patch } }))
                                              return (
                                                <tr key={it.id} className={`border-b last:border-0 ${done ? 'bg-green-50/40' : ''}`}>
                                                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{it.item_code}</td>
                                                  <td className="px-3 py-2 text-gray-600">{it.description}</td>
                                                  <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                                                  <td className="px-3 py-2 text-right font-semibold text-purple-700">{it.requested_qty}</td>
                                                  <td className="px-3 py-2 text-right text-gray-700">{it.received_qty}</td>
                                                  <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{remaining}</td>
                                                  {!locked && <>
                                                    <td className="px-3 py-2 text-right font-semibold text-blue-700">{avail}</td>
                                                    <td className="px-3 py-2"><input type="number" min="0" max={avail} value={le.qty} onChange={e => setLe({ qty: e.target.value })} className="border rounded px-2 py-1 text-xs w-20 text-right" /></td>
                                                    <td className="px-3 py-2"><input value={le.batch} onChange={e => setLe({ batch: e.target.value })} placeholder="batch no." className="border rounded px-2 py-1 text-xs w-28" /></td>
                                                    <td className="px-3 py-2"><input type="date" min="2020-01-01" max="2100-12-31" value={le.exp} onChange={e => setLe({ exp: e.target.value })} className="border rounded px-2 py-1 text-xs" /></td>
                                                    <td className="px-3 py-2 whitespace-nowrap">
                                                      {it.label_received_at ? <span className="text-green-600 text-xs font-medium">✓ Sent to stock</span> : (<>
                                                        <button onClick={() => saveLabel(it, r)} disabled={busy === `label|${it.id}`} className="text-blue-600 hover:underline text-xs disabled:opacity-50">{busy === `label|${it.id}` ? 'Saving…' : 'Save'}</button>{(it.label_batch_no || it.label_exp_date) && <span className="text-green-600 text-xs ml-0.5">✓</span>}
                                                        <span className="text-gray-300 mx-1">·</span>
                                                        {it.label_photo_path
                                                          ? <button onClick={() => viewLabelPhoto(it.label_photo_path!)} className="text-green-600 hover:underline text-xs">✓ Photo</button>
                                                          : <label className="text-blue-600 hover:underline text-xs cursor-pointer">{busy === `lphoto|${it.id}` ? '…' : '📷 Photo'}<input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadLabelPhoto(it, r, f); e.target.value = '' }} /></label>}
                                                        <span className="text-gray-300 mx-1">·</span>
                                                        <input type="checkbox" className="h-4 w-4 align-middle" checked={selLabels.has(it.id)} onChange={() => toggleLabel(it.id)} title="Tick to send into stock" />
                                                      </>)}
                                                    </td>
                                                  </>}
                                                </tr>
                                              )
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ) })()}
                        </div>
                        </Fragment>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        ) : shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No {filter !== 'All' ? filter.toLowerCase() : ''} material requests.
            <br />Raise one from a batch on the Production board.
          </div>
        ) : (
          <div className="space-y-5 max-h-[40rem] overflow-y-auto pr-1">
            {(multiFac ? [...shown].sort((a, b) => (a.factory_code || '').localeCompare(b.factory_code || '')) : shown).map((r, i, arr) => (
              <Fragment key={r.id}>
              {multiFac && (i === 0 || arr[i - 1].factory_code !== r.factory_code) && (
                <div className="text-sm font-semibold text-gray-700 pt-1">🏭 {isHO ? factoryName(r.factory_code) : r.factory_code} <span className="text-gray-400 font-normal">· {arr.filter(x => x.factory_code === r.factory_code).length} request(s)</span></div>
              )}
              <div className="bg-white rounded-xl shadow-sm border p-5">
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <span className="font-mono font-semibold">{r.request_no}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status}</span>
                  <span className="text-sm text-gray-500">
                    Batch <span className="font-mono">{r.production_batches?.batch_no}</span> · {r.production_batches?.item_code}
                  </span>
                  <span className="text-sm text-gray-500">· {isHO ? factoryName(r.factory_code) : r.factory_code}</span>
                  <span className="text-sm text-gray-400 ml-auto">{new Date(r.created_at).toLocaleString()}</span>
                  {r.status === 'Open' && hasCap(profile, 'request_mr_cancel') && (r.released_at ? (
                    <button onClick={() => requestMrCancel(r)} disabled={busy === `reqcancel|${r.id}`}
                      className="border border-red-300 text-red-600 px-3 py-1 rounded-lg hover:bg-red-50 text-xs font-medium disabled:opacity-50">
                      {busy === `reqcancel|${r.id}` ? 'Sending…' : '✕ Request cancel (HQ approval)'}</button>
                  ) : (
                    <button onClick={() => cancelRequest(r)} disabled={busy === `cancel|${r.id}`}
                      className="border border-red-300 text-red-600 px-3 py-1 rounded-lg hover:bg-red-50 text-xs font-medium disabled:opacity-50">
                      {busy === `cancel|${r.id}` ? 'Cancelling…' : '✕ Cancel request'}</button>
                  ))}
                </div>

                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>{['Material', 'Description', 'Unit', 'Requested', 'Received', 'Remaining', ...(canEditFac(r.factory_code) ? [''] : [])].map((h, i) => (
                        <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {(r.material_request_items || []).filter(it => !factoryItems.has(it.item_code)).map(it => {
                        const done = it.received_qty >= it.requested_qty
                        const remaining = Math.max(0, it.requested_qty - it.received_qty)
                        return (
                          <tr key={it.id} className={`border-b last:border-0 ${done ? 'bg-green-50/40' : ''}`}>
                            <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{it.item_code}</td>
                            <td className="px-3 py-2 text-gray-600">{it.description}</td>
                            <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                            <td className="px-3 py-2 text-right font-semibold text-blue-700">{it.requested_qty}</td>
                            <td className="px-3 py-2 text-right text-gray-700">{it.received_qty}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{remaining}</td>
                            {canEditFac(r.factory_code) && <td className="px-3 py-2 whitespace-nowrap text-right">
                              {movePending.has(it.id) ? <span className="text-amber-600 text-xs">⏳ move pending</span>
                                : it.received_qty > 0 && hasCap(profile, 'move_received_qty') && moveTargets(it, r).length > 0 ? <button onClick={() => openMove(it, r)} className="text-blue-600 hover:underline text-xs">Move qty</button>
                                  : null}
                            </td>}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {(r.material_request_items || []).some(it => factoryItems.has(it.item_code)) && (
                  <p className="text-gray-400 text-xs mt-2">🏭 This product also has labels made at the factory — they appear in the factory label section (with batch / expiry) once the raw materials are received, not picked from the warehouse.</p>
                )}
              </div>
              </Fragment>
            ))}
          </div>
        )}

      </div>

      {/* Move received qty to another request (HO approval) */}
      {moveSrc && (() => {
        const { it, r } = moveSrc
        const targets = moveTargets(it, r)
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setMoveSrc(null)}>
            <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
              <h2 className="font-semibold text-lg mb-1">Move received quantity</h2>
              <p className="text-gray-500 text-sm mb-4"><span className="font-mono">{it.item_code}</span> — from {r.pick_run_no || r.request_no} ({it.received_qty} {it.unit} received). Goes to Head Office for approval.</p>
              <div className="space-y-3">
                <div><label className="block text-sm font-medium mb-1">Quantity to move ({it.unit})</label>
                  <input type="number" step="any" min="0" max={it.received_qty} value={moveQty} onChange={e => setMoveQty(e.target.value)} className="w-full border rounded-lg px-3 py-2" /></div>
                <div><label className="block text-sm font-medium mb-1">Move to request</label>
                  <select value={moveTargetId} onChange={e => setMoveTargetId(e.target.value)} className="w-full border rounded-lg px-3 py-2 bg-white">
                    <option value="">Choose a request…</option>
                    {targets.map(t => <option key={t.id} value={t.id}>{t.label} · still needs {t.remaining} {it.unit}</option>)}
                  </select></div>
                <div><label className="block text-sm font-medium mb-1">Reason</label>
                  <input value={moveReason} onChange={e => setMoveReason(e.target.value)} placeholder="Why move it?" className="w-full border rounded-lg px-3 py-2" /></div>
              </div>
              <div className="flex gap-2 mt-5">
                <button onClick={submitMove} disabled={busy === 'move'} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{busy === 'move' ? 'Sending…' : 'Send for approval'}</button>
                <button onClick={() => setMoveSrc(null)} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
