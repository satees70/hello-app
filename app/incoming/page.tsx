'use client'
import { useEffect, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can } from '@/lib/permissions'
import { apiFetch } from '@/lib/api'

interface DeliveryOrder {
  id: string
  file_name: string
  file_path: string
  do_number: string | null
  do_date: string | null
  factory_code: string
  status: string
  created_at: string
  so_number?: string | null
  pick_run_no?: string | null
  vehicle?: string | null
  driver_name?: string | null
  loaded_at?: string | null
  driver_assigned_at?: string | null
  gr_departed_at?: string | null
  transport_received_at?: string | null
  lorry_assigned_by?: string | null
  loaded_by?: string | null
  driver_assigned_by?: string | null
  gr_departed_by?: string | null
  transport_received_by?: string | null
}
interface DoLine { id: string; item_code: string; description: string; quantity: number; unit: string; batch_no: string; qc_checked: boolean; photo_path: string | null; received_at: string | null; stock_lot_id?: string | null; received_qty?: number | null }
interface MRItem { id: string; item_code: string; unit: string; requested_qty: number; received_qty: number }
interface MatReq { id: string; factory_code: string; status: string; pick_run_no: string | null; material_request_items: MRItem[] }

const STATUS_STYLES: Record<string, string> = {
  Processing: 'bg-blue-100 text-blue-700',
  Review: 'bg-purple-100 text-purple-700',
  'Partially Received': 'bg-teal-100 text-teal-700',
  Received: 'bg-green-100 text-green-700',
  Error: 'bg-red-100 text-red-700',
}
const ACTIVE = ['Open', 'Partially Received']
// Pack units on an item code's size suffix (e.g. 30KG/BAG). Accept the plural
// forms too (BAGS/CTNS/CARTONS) so a code like S852-SP-30KG/BAGS still resolves
// to its base material instead of showing as an unknown item.
const PACK = 'BAGS?|CTNS?|CARTONS?'

// Transport stage of a Goods-Received document (warehouse → factory).
type GrStage = 'none' | 'lorry' | 'loaded' | 'driver' | 'sent' | 'received'
function grStage(d: { vehicle?: string | null; loaded_at?: string | null; driver_name?: string | null; gr_departed_at?: string | null; transport_received_at?: string | null }): GrStage {
  if (d.transport_received_at) return 'received'
  if (d.gr_departed_at) return 'sent'
  if (d.driver_name) return 'driver'
  if (d.loaded_at) return 'loaded'
  if (d.vehicle) return 'lorry'
  return 'none'
}
const GR_LABEL: Record<GrStage, string> = { none: 'Not started', lorry: 'Lorry assigned', loaded: 'Loaded', driver: 'Driver assigned', sent: 'On the way', received: 'Received' }
const GR_STYLE: Record<GrStage, string> = {
  none: 'bg-gray-100 text-gray-500', lorry: 'bg-teal-100 text-teal-700', loaded: 'bg-amber-100 text-amber-800',
  driver: 'bg-indigo-100 text-indigo-700', sent: 'bg-blue-100 text-blue-700', received: 'bg-green-100 text-green-700',
}

// Searchable item picker — type a code OR a name, then click a row. Works on every browser
// (the native datalist arrow is unreliable and was hiding matches).
function ItemCombo({ items, value, onPick }: { items: { code: string; description: string; unit: string }[]; value: string; onPick: (code: string, description: string, unit: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // Tolerant search: ignore punctuation/spacing and match each typed word in any order,
  // against code + description (so "s.biji sawi" finds "BIJI SAWI KUNING 25KG").
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const words = norm(q).split(' ').filter(Boolean)
  const matches = (words.length ? items.filter(i => { const hay = norm(i.code + ' ' + i.description); return words.every(w => hay.includes(w)) }) : items).slice(0, 60)
  return (
    <div className="relative">
      <input value={open ? q : value} onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => { setQ(''); setOpen(true) }} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Type a code or name…" className="w-full border rounded-lg px-3 py-2" />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto bg-white border rounded-lg shadow-lg">
          {matches.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">No matching item — check the code is in the Items master.</div>}
          {matches.map(i => (
            <button key={i.code} type="button" onMouseDown={e => { e.preventDefault(); onPick(i.code, i.description, i.unit); setOpen(false) }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b last:border-0">
              <span className="font-mono font-medium">{i.code}</span> <span className="text-gray-500">{i.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function IncomingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'goods_received')
  const isWarehouse = !!profile?.warehouse_user   // warehouse staff receive for every factory they serve
  const canEditFac = (fc: string | undefined) => isWarehouse || can(profile, 'goods_received', 'edit', fc)   // honours per-factory view-only
  const [docs, setDocs] = useState<DeliveryOrder[]>([])
  const [docFilters, setDocFilters] = useState({ file: '', do: '', factory: '', status: '', uploaded: '', transport: '' })
  const [docQ, setDocQ] = useState('')   // single search box used on mobile
  const [lineCounts, setLineCounts] = useState<Record<string, { recv: number; total: number }>>({})
  const [docLineText, setDocLineText] = useState<Record<string, string>>({})   // do_id -> its item codes + descriptions (for searching documents by content)
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Transport (warehouse → factory) for a document
  const [transportDoc, setTransportDoc] = useState<DeliveryOrder | null>(null)
  const [lorries, setLorries] = useState<{ name: string; parked_at: string | null; lorry_type: string | null }[]>([])
  const [crew, setCrew] = useState<string[]>([])
  const [userNames, setUserNames] = useState<Record<string, string>>({})   // user id -> name, for "by whom" on transport steps
  const [grLog, setGrLog] = useState<{ action: string; detail: string | null; actor_name: string | null; at: string }[]>([])
  const [tBusy, setTBusy] = useState(false)

  // Lines / review state for the currently opened document
  const [linesFor, setLinesFor] = useState<DeliveryOrder | null>(null)
  const [lines, setLines] = useState<DoLine[]>([])
  const [lineQ, setLineQ] = useState('')   // item-code / description search within the opened document
  const [requests, setRequests] = useState<MatReq[]>([])
  const [kgPerBag, setKgPerBag] = useState<Record<string, number>>({})
  const [pcsPerRoll, setPcsPerRoll] = useState<Record<string, number>>({})
  const [doItems, setDoItems] = useState<Record<string, string>>({})
  const [stockCode, setStockCode] = useState<Record<string, string>>({})   // pack code -> loose "stock code" override
  const [receiving, setReceiving] = useState(false)
  const [busyLine, setBusyLine] = useState('')
  const [editReq, setEditReq] = useState<DoLine | null>(null)
  const [editForm, setEditForm] = useState<Record<string, string>>({})
  const [itemsMaster, setItemsMaster] = useState<{ code: string; description: string; unit: string }[]>([])
  const itemByCode = (c: string) => itemsMaster.find(i => i.code.toLowerCase() === (c || '').trim().toLowerCase())

  const EDIT_FIELDS: { key: string; label: string }[] = [
    { key: 'item_code', label: 'Item code' }, { key: 'description', label: 'Description' },
    { key: 'quantity', label: 'Delivered qty' }, { key: 'unit', label: 'Unit' }, { key: 'batch_no', label: 'Batch no' },
  ]
  function openEditReq(l: DoLine) {
    setEditReq(l); setError(''); setSuccess('')
    setEditForm({ item_code: l.item_code || '', description: l.description || '', quantity: String(l.quantity ?? ''), unit: l.unit || '', batch_no: l.batch_no || '' })
  }
  // Only one open amendment per line — avoids duplicate pending requests
  async function hasPendingChange(lineId: string) {
    const { data } = await supabase.from('do_change_requests').select('id').eq('line_id', lineId).eq('status', 'Pending').limit(1)
    return !!(data && data.length)
  }
  async function submitEditReq() {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!editReq || !linesFor) return
    if (await hasPendingChange(editReq.id)) { setError('An amendment for this line is already waiting for Head Office — wait for it to be approved or rejected first.'); return }
    const orig: Record<string, string> = { item_code: editReq.item_code || '', description: editReq.description || '', quantity: String(editReq.quantity ?? ''), unit: editReq.unit || '', batch_no: editReq.batch_no || '' }
    // Only validate the item code against the master when the user actually CHANGES
    // it. The line's original code came from the Delivery Order and was already
    // accepted/received, so editing another field (e.g. batch no) must not be blocked
    // just because that code (a pack variant like S104-25KG/BAG) isn't literally in
    // the master.
    const codeChanged = (editForm.item_code || '') !== (editReq.item_code || '')
    if (codeChanged && editForm.item_code && !itemByCode(editForm.item_code) && !itemByCode(baseCode(editForm.item_code))) { setError('Pick a valid item code from the Items master.'); return }
    const changed = EDIT_FIELDS.filter(f => (editForm[f.key] || '') !== orig[f.key])
    if (changed.length === 0) { setError('Nothing changed.'); return }
    const reason = window.prompt('Reason for these changes (sent to Head Office):')
    if (reason === null) return
    const { data: sess } = await supabase.auth.getSession()
    const rows = changed.map(f => ({
      do_id: linesFor.id, line_id: editReq.id, factory_code: linesFor.factory_code, request_type: 'edit',
      field: f.key, old_value: orig[f.key], new_value: editForm[f.key], reason: reason || null,
      line_label: `${editReq.item_code} · ${editReq.description || ''}`,
      requested_by: sess.session?.user.id || null, requested_by_name: profile?.full_name || null,
    }))
    const { error: e } = await supabase.from('do_change_requests').insert(rows)
    if (e) { setError(e.message); return }
    setEditReq(null); setSuccess('Change request sent to Head Office.')
  }
  async function requestDeleteLine(l: DoLine) {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor) return
    if (await hasPendingChange(l.id)) { setError('An amendment for this line is already waiting for Head Office — wait for it to be approved or rejected first.'); return }
    const reason = window.prompt(`Request to DELETE line "${l.item_code}".\nReason (sent to Head Office):`)
    if (reason === null) return
    const { data: sess } = await supabase.auth.getSession()
    const { error: e } = await supabase.from('do_change_requests').insert({
      do_id: linesFor.id, line_id: l.id, factory_code: linesFor.factory_code, request_type: 'delete',
      reason: reason || null, line_label: `${l.item_code} · ${l.description || ''}`,
      requested_by: sess.session?.user.id || null, requested_by_name: profile?.full_name || null,
    })
    if (e) { setError(e.message); return }
    setSuccess('Delete request sent to Head Office.')
  }
  // Correct the quantity actually received into stock (HO approval re-books the difference)
  async function requestCorrectQty(l: DoLine) {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor) return
    if (await hasPendingChange(l.id)) { setError('An amendment for this line is already waiting for Head Office — wait for it to be approved or rejected first.'); return }
    const cur = l.received_qty ?? 0
    const val = window.prompt(`Correct the quantity received into stock for ${l.item_code} (now ${cur}).\nEnter the correct total quantity received:`, String(cur))
    if (val === null) return
    const n = Number(val)
    if (!(n >= 0)) { setError('Enter a valid quantity (0 or more).'); return }
    const reason = window.prompt('Reason for the correction (sent to Head Office):') || ''
    const { data: sess } = await supabase.auth.getSession()
    const { error: e } = await supabase.from('do_change_requests').insert({
      do_id: linesFor.id, line_id: l.id, factory_code: linesFor.factory_code, request_type: 'correct_qty',
      field: 'received_qty', old_value: String(cur), new_value: String(n), reason: reason || null,
      line_label: `${l.item_code} · ${l.description || ''}`,
      requested_by: sess.session?.user.id || null, requested_by_name: profile?.full_name || null,
    })
    if (e) { setError(e.message); return }
    setSuccess('Quantity correction sent to Head Office.')
  }
  const reqCtl = (l: DoLine) => (
    <span className="whitespace-nowrap text-xs">
      {l.received_at && <><button onClick={() => requestCorrectQty(l)} className="text-blue-600 hover:underline">Correct qty</button><span className="text-gray-300 mx-1">·</span></>}
      <button onClick={() => openEditReq(l)} className="text-blue-600 hover:underline">Request edit</button>
      <span className="text-gray-300 mx-1">·</span>
      <button onClick={() => requestDeleteLine(l)} className="text-red-600 hover:underline">delete</button>
    </span>
  )

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const photoReq = !isHO   // Goods Received needs a photo (Head Office exempt)

  // Tick QC on every not-yet-received line at once
  async function tickAllQc() {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor) return
    await supabase.from('delivery_order_lines').update({ qc_checked: true }).eq('do_id', linesFor.id).is('received_at', null)
    reloadLines()
  }

  useEffect(() => { if (profile) { loadDocs(); loadFactories(); loadItemsMaster(); loadResources() } }, [profile])
  // Deep link: /incoming?transport=<docId> opens that document's Transport view (from Lorry Internal Transfer).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('transport'); if (!id) return
    const d = docs.find(x => x.id === id); if (d) setTransportDoc(d)
  }, [docs])
  useEffect(() => { if (transportDoc) loadGrLog(transportDoc.id); else setGrLog([]) }, [transportDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadResources() {
    const { data } = await supabase.from('delivery_resources').select('kind, name, parked_at, lorry_type').eq('active', true).order('name')
    setLorries((data || []).filter(r => r.kind === 'lorry').map(r => ({ name: r.name, parked_at: r.parked_at, lorry_type: r.lorry_type })))
    setCrew([...new Set((data || []).filter(r => r.kind !== 'lorry').map(r => r.name))].sort())
    const { data: us } = await supabase.rpc('list_users')
    setUserNames(Object.fromEntries(((us as { id: string; full_name: string }[]) || []).map(u => [u.id, u.full_name])))
  }
  async function loadGrLog(id: string) {
    const { data } = await supabase.from('gr_transport_log').select('action, detail, actor_name, at').eq('doc_id', id).order('at', { ascending: false })
    setGrLog(data || [])
  }
  // Transport-step actions on a Goods-Received document.
  async function grTransport(rpc: string, args: Record<string, unknown>) {
    setTBusy(true); setError('')
    const { error: e } = await supabase.rpc(rpc, args)
    setTBusy(false)
    if (e) { setError(e.message); return false }
    await loadDocs()
    if (typeof args.p_doc_id === 'string') loadGrLog(args.p_doc_id)
    return true
  }

  async function loadDocs() {
    const { data } = await supabase.from('delivery_orders').select('*').order('created_at', { ascending: false })
    setDocs((data as DeliveryOrder[]) || [])
    // Per-document progress (lines received / total) + a per-document text blob of
    // its item codes & descriptions, so the file search can match documents by content.
    const ls = await fetchAll<{ do_id: string; received_at: string | null; item_code: string | null; description: string | null }>(
      'delivery_order_lines', 'do_id, received_at, item_code, description')
    const c: Record<string, { recv: number; total: number }> = {}
    const t: Record<string, string> = {}
    ls.forEach(r => {
      const e = c[r.do_id] || (c[r.do_id] = { recv: 0, total: 0 })
      e.total++; if (r.received_at) e.recv++
      t[r.do_id] = (t[r.do_id] || '') + ' ' + `${r.item_code || ''} ${r.description || ''}`.toLowerCase()
    })
    setLineCounts(c)
    setDocLineText(t)
  }
  async function loadItemsMaster() {
    const { data } = await supabase.from('items').select('code, description, unit').order('code').limit(10000)
    setItemsMaster((data as { code: string; description: string; unit: string }[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'

  const docFacName = (d: DeliveryOrder) => isHO ? factoryName(d.factory_code) : d.factory_code
  const inc = (v: string | null | undefined, q: string) => !q || (v || '').toLowerCase().includes(q.toLowerCase())
  // The File search also matches a document by its PR (pick run) number and the items inside it
  const fileMatch = (d: DeliveryOrder, q: string) => !q || inc(d.file_name, q) || inc(d.pick_run_no, q) || inc(docLineText[d.id] || '', q)
  const colDocs = docs.filter(d =>
    fileMatch(d, docFilters.file) && inc(d.do_number, docFilters.do) && inc(docFacName(d), docFilters.factory) &&
    (!docFilters.status || d.status === docFilters.status) && inc(new Date(d.created_at).toLocaleString(), docFilters.uploaded) &&
    (!docFilters.transport || (docFilters.transport === 'needs_driver' ? (!!d.vehicle && !d.driver_name && !d.transport_received_at) : grStage(d) === docFilters.transport)))
  const mobDocs = docs.filter(d => !docQ || [d.file_name, d.do_number, d.pick_run_no, docFacName(d), d.status, docLineText[d.id] || ''].some(v => inc(v, docQ)))
  const docStatuses = [...new Set(docs.map(d => d.status))].sort()
  const shownLines = lines.filter(l => !lineQ || inc(l.item_code, lineQ) || inc(l.description, lineQ))

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) await doUpload(file)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function doUpload(file: File) {
    if (!profile) return
    if (!canEditFac(profile.factory_code)) { setError('You have view-only access to Goods Received at your factory.'); return }
    if (file.type !== 'application/pdf') { setError('Please choose a PDF file.'); return }
    setUploading(true); setError(''); setSuccess('')
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${profile.factory_code}/${Date.now()}-${safeName}`
    const { error: upErr } = await supabase.storage.from('delivery-orders').upload(path, file)
    if (upErr) { setError(`Upload failed: ${upErr.message}`); setUploading(false); return }
    const { data: inserted, error: insErr } = await supabase.from('delivery_orders')
      .insert({ file_name: file.name, file_path: path, status: 'Processing', factory_code: profile.factory_code, uploaded_by: profile.id })
      .select().single()
    if (insErr || !inserted) { setError(`Saving record failed: ${insErr?.message}`); setUploading(false); return }
    setSuccess(`Uploaded "${file.name}". Reading the document with Claude…`)
    setUploading(false); loadDocs()
    try {
      const res = await apiFetch('/api/extract-delivery-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doId: inserted.id, filePath: path }) })
      const result = await res.json()
      if (!res.ok) { setError(`Extraction failed: ${result.error || 'Unknown error'}`); setSuccess('') }
      else { setSuccess(`Read ${result.count} line(s) from "${inserted.file_name}". Click View Lines to review and receive.`) }
    } catch { setError('Could not reach the extraction service.'); setSuccess('') }
    loadDocs()
  }

  async function viewLines(doc: DeliveryOrder) {
    setLinesFor(doc); setError(''); setSuccess(''); setLineQ('')
    const { data: ls } = await supabase.from('delivery_order_lines').select('*').eq('do_id', doc.id).order('item_code')
    const dl = (ls as DoLine[]) || []
    setLines(dl)
    // open requests for this factory (for matching)
    const { data: reqs } = await supabase.from('material_requests')
      .select('id, factory_code, status, pick_run_no, material_request_items(id, item_code, unit, requested_qty, received_qty)')
      .eq('factory_code', doc.factory_code).in('status', ACTIVE)
    setRequests((reqs as MatReq[]) || [])
    // kg/bag overrides
    const { data: ov } = await supabase.from('items').select('code, kg_per_bag').not('kg_per_bag', 'is', null)
    const m: Record<string, number> = {}; (ov || []).forEach(r => { if (r.kg_per_bag) m[r.code] = Number(r.kg_per_bag) }); setKgPerBag(m)
    // pieces-per-roll (roll plastics received in rolls → stocked in pc)
    const { data: rl } = await supabase.from('items').select('code, pcs_per_roll').not('pcs_per_roll', 'is', null)
    const pr: Record<string, number> = {}; (rl || []).forEach(r => { if (r.pcs_per_roll) pr[r.code] = Number(r.pcs_per_roll) }); setPcsPerRoll(pr)
    // units of every code + base code (to know what's a real item), plus stock-code overrides
    const codes = [...new Set(dl.flatMap(l => [l.item_code, baseCode(l.item_code)]))]
    const { data: items } = await supabase.from('items').select('code, unit, stock_code').in('code', codes)
    const u: Record<string, string> = {}; const sc: Record<string, string> = {}
    ;(items || []).forEach(r => { u[r.code] = r.unit || ''; if (r.stock_code) sc[r.code] = r.stock_code })
    // also load the units of any override target codes (e.g. S035) so they resolve
    const targets = [...new Set(Object.values(sc))].filter(t => u[t] == null)
    if (targets.length) { const { data: t2 } = await supabase.from('items').select('code, unit').in('code', targets); (t2 || []).forEach(r => { u[r.code] = r.unit || '' }) }
    setDoItems(u); setStockCode(sc)
  }

  // Reload just the lines of the open document (after a QC tick or photo)
  async function reloadLines() {
    if (!linesFor) return
    const { data } = await supabase.from('delivery_order_lines').select('*').eq('do_id', linesFor.id).order('item_code')
    setLines((data as DoLine[]) || [])
  }

  // QC ticks a line as checked (or unchecks)
  async function toggleQc(line: DoLine) {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    await supabase.from('delivery_order_lines').update({ qc_checked: !line.qc_checked }).eq('id', line.id)
    reloadLines()
  }

  // Shrink a phone photo in the browser before upload (keeps each ~150–250 KB)
  function compressImage(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        const max = 1280
        let { width, height } = img
        if (width > max || height > max) { const s = max / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s) }
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
        const ctx = canvas.getContext('2d'); if (!ctx) return reject(new Error('Canvas unavailable'))
        ctx.drawImage(img, 0, 0, width, height)
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('Compress failed')), 'image/jpeg', 0.6)
      }
      img.onerror = () => reject(new Error('Could not read image'))
      img.src = url
    })
  }

  // Attach one photo to a line (compressed), stored under the document's folder
  async function onLinePhoto(line: DoLine, file: File) {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor) return
    setBusyLine(line.id); setError('')
    try {
      const blob = await compressImage(file)
      const path = `photos/${linesFor.id}/${line.id}.jpg`
      const { error: upErr } = await supabase.storage.from('delivery-orders').upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
      if (upErr) { setError(`Photo upload failed: ${upErr.message}`); setBusyLine(''); return }
      await supabase.from('delivery_order_lines').update({ photo_path: path }).eq('id', line.id)
      await reloadLines()
    } catch { setError('Could not process the photo.') }
    setBusyLine('')
  }

  async function viewLinePhoto(path: string) {
    const { data } = await supabase.storage.from('delivery-orders').createSignedUrl(path, 120)
    if (data) window.open(data.signedUrl, '_blank')
  }

  // Re-run extraction for a document stuck on Processing or Error
  async function reExtract(doc: DeliveryOrder) {
    if (!canEditFac(doc.factory_code)) { setError("You have view-only access at this factory."); return }
    setError(''); setSuccess('')
    await supabase.from('delivery_orders').update({ status: 'Processing' }).eq('id', doc.id)
    loadDocs()
    try {
      const res = await apiFetch('/api/extract-delivery-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doId: doc.id, filePath: doc.file_path }) })
      const r = await res.json()
      if (!res.ok) setError(`Read failed: ${r.error || 'Unknown error'}`)
      else setSuccess(`Read ${r.count} line(s) from "${doc.file_name}". Click View Lines to review.`)
    } catch { setError('Could not reach the extraction service.') }
    loadDocs()
  }

  async function handleViewPdf(path: string) {
    const { data, error: e } = await supabase.storage.from('delivery-orders').createSignedUrl(path, 60)
    if (e || !data) { setError('Could not open the PDF.'); return }
    window.open(data.signedUrl, '_blank')
  }

  async function handleDelete(doc: DeliveryOrder) {
    if (!canEditFac(doc.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!confirm(`Delete "${doc.file_name}"? This removes the document record (received stock is not reversed).`)) return
    await supabase.storage.from('delivery-orders').remove([doc.file_path])
    await supabase.from('delivery_order_lines').delete().eq('do_id', doc.id)
    await supabase.from('delivery_orders').delete().eq('id', doc.id)
    if (linesFor?.id === doc.id) setLinesFor(null)
    loadDocs()
  }

  // --- matching + bag/carton→KG conversion (same rules as Material Requests) ---
  const baseCode = (code: string) => code.replace(new RegExp(`[-\\s]*\\d+(?:\\.\\d+)?\\s*KG\\s*\\/\\s*(?:${PACK})\\s*$`, 'i'), '').trim()
  const matchLines = (code: string): MRItem[] => {
    const base = baseCode(code)
    // Oldest-first across open requests; but if this DO is linked to a pick run,
    // fill that run's requests FIRST so the DO reconciles against its own run.
    const run = linesFor?.pick_run_no || ''
    const active = [...requests].reverse().filter(r => ACTIVE.includes(r.status))
    const ordered = run ? [...active].sort((a, b) => (a.pick_run_no === run ? 0 : 1) - (b.pick_run_no === run ? 0 : 1)) : active
    const sc = stockCode[code]
    const out: MRItem[] = []
    ordered.forEach(r => (r.material_request_items || []).forEach(it => { if (it.item_code === code || it.item_code === base || (sc && it.item_code === sc)) out.push(it) }))
    return out
  }
  // Resolve the code to stock under: explicit stock-code override first (e.g.
  // E035-25KG/BAG → S035), then the BASE code (D242-25KG/BAG → D242), else the code itself.
  const resolveItem = (code: string): { code: string; unit: string } | null => {
    const sc = stockCode[code]
    if (sc && doItems[sc] != null) return { code: sc, unit: doItems[sc] }
    const b = baseCode(code)
    if (b !== code && doItems[b] != null) return { code: b, unit: doItems[b] }
    if (doItems[code] != null) return { code, unit: doItems[code] }
    return null
  }
  const parseKgPerBag = (code: string, desc: string) => {
    const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*KG\\s*\\/\\s*(?:${PACK})`, 'i').exec(`${code} ${desc || ''}`)
    return m ? Number(m[1]) : null
  }
  // Convert when the delivery is in a pack (BAG/CTN), using the KG-per-pack from the code (e.g. 25KG/BAG → 25).
  // Deliveries already in KG or counted Units pass through (factor 1). null = pack but size unknown.
  const bagFactor = (code: string, desc: string, doUnit: string): number | null => {
    if (!/bag|ctn|carton/i.test(doUnit || '')) return 1
    return kgPerBag[code] ?? kgPerBag[baseCode(code)] ?? parseKgPerBag(code, desc)
  }
  // The unit the stock lands in: KG when a pack was converted, else the item's own unit (or the DO unit)
  const intoUnit = (factor: number, fallback: string | undefined) => factor === 1 ? (fallback || '') : 'KG'
  const num = (n: number) => Number(Number(n).toFixed(3))

  // Roll plastics: a roll converts to N pieces (× pcs_per_roll). Takes precedence over bag→kg.
  const rollFactor = (code: string): number | null => pcsPerRoll[code] ?? pcsPerRoll[baseCode(code)] ?? null

  // Per-line computed display values (shared by the desktop table and mobile cards)
  const lineCalc = (l: DoLine) => {
    const ml = matchLines(l.item_code)
    const matched = ml.length > 0
    const item = matched ? null : resolveItem(l.item_code)
    const known = matched || !!item
    const roll = known ? rollFactor(l.item_code) : null
    if (roll) {
      return { matched, known, factor: roll, into: num(Number(l.quantity) * roll), unit: 'pc' }
    }
    const factor = known ? bagFactor(l.item_code, l.description, l.unit) : 1
    const into = factor === null ? null : num(Number(l.quantity) * factor)
    const unit = factor === null ? '' : intoUnit(factor, matched ? ml[0]?.unit : item?.unit)
    return { matched, known, factor, into, unit }
  }
  const statusNode = (known: boolean, factor: number | null, matched: boolean) =>
    !known ? <span className="text-red-600">⚠ unknown item — skip</span>
      : factor === null ? <span className="text-amber-600">⚠ set KG per bag</span>
        : matched ? <span className="text-green-600">✓ against order</span>
          : <span className="text-indigo-600">→ stock (unplanned)</span>
  const qcBox = (l: DoLine, editable: boolean) => (
    <input type="checkbox" checked={l.qc_checked} disabled={!editable} onChange={() => toggleQc(l)} className="h-5 w-5" />
  )
  const photoCtl = (l: DoLine, editable: boolean) => (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {l.photo_path
        ? <button onClick={() => viewLinePhoto(l.photo_path!)} className="text-green-600 hover:underline text-xs">✓ View{editable ? ' / retake' : ''}</button>
        : <span className="text-amber-600 text-xs">no photo</span>}
      {editable && (
        <label className="cursor-pointer text-blue-600 hover:underline text-xs">
          {busyLine === l.id ? '…' : '📷 Photo'}
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onLinePhoto(l, f); e.target.value = '' }} />
        </label>
      )}
    </span>
  )
  // Per-line Receive button (partial receiving): enabled once QC-ticked + photo + receivable
  const receiveBtn = (l: DoLine) => {
    const c = lineCalc(l)
    if (l.received_at) {
      // Flag a short/over receipt: actual received count vs what the DO said.
      const recvCount = c.factor ? Number(l.received_qty || 0) / c.factor : null
      const doQty = Number(l.quantity)
      const disc = recvCount != null && Math.abs(recvCount - doQty) > 0.001
      return (
        <span className="text-xs font-medium whitespace-nowrap">
          <span className="text-green-600">✓ Received{disc ? ` ${Number(recvCount!.toFixed(3))}` : ''}</span>
          {disc && <span className={`ml-1 ${recvCount! > doQty ? 'text-indigo-600' : 'text-amber-600'}`}>({recvCount! > doQty ? 'over' : 'short'} {Number(Math.abs(recvCount! - doQty).toFixed(3))})</span>}
        </span>
      )
    }
    const ready = l.qc_checked && (!photoReq || !!l.photo_path) && c.known && c.factor !== null
    return (
      <span className="flex items-center gap-2 whitespace-nowrap">
        <button onClick={() => receiveLine(l)} disabled={!ready || busyLine === l.id}
          className="bg-blue-600 text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-40">
          {busyLine === l.id ? '…' : 'Receive'}
        </button>
        <button onClick={() => reportShortOver(l)} disabled={!ready || busyLine === l.id}
          title="Received a different quantity than the DO? Enter the actual amount — it goes into stock and Head Office is flagged."
          className="text-xs text-amber-700 hover:underline disabled:opacity-40">Short/over</button>
      </span>
    )
  }

  // Recompute the document's status from its lines (Review → Partially Received → Received)
  async function refreshDoStatus(currentLines: DoLine[]) {
    if (!linesFor) return
    const receivable = currentLines.filter(l => { const c = lineCalc(l); return c.known && c.factor !== null })
    const anyReceived = currentLines.some(l => l.received_at)
    const allReceived = receivable.length > 0 && receivable.every(l => l.received_at)
    const status = allReceived ? 'Received' : anyReceived ? 'Partially Received' : 'Review'
    await supabase.from('delivery_orders').update({ status }).eq('id', linesFor.id)
    setLinesFor({ ...linesFor, status })
    loadDocs()
  }

  // Receive ONE line into stock (partial receiving). Requires QC tick + photo.
  async function receiveLine(l: DoLine, silent = false, overrideCount?: number): Promise<boolean> {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return false }
    if (!linesFor || l.received_at) return false
    const c = lineCalc(l)
    if (!c.known || c.factor === null) { setError(`${l.item_code}: cannot be received (unknown item or pack size).`); return false }
    if (!l.qc_checked || (photoReq && !l.photo_path)) { setError(`${l.item_code}: tick QC${photoReq ? ' and add a photo' : ''} first.`); return false }
    if (!silent) { setBusyLine(l.id); setError(''); setSuccess('') }
    // Receive the DO's quantity, unless production entered a different actual count.
    const qty = (overrideCount != null ? overrideCount : Number(l.quantity)) * c.factor
    const ml = matchLines(l.item_code)
    let err
    if (ml.length > 0) {
      ;({ error: err } = await supabase.rpc('receive_combined_lot', { p_item_ids: ml.map(x => x.id), p_qty: qty, p_batch_no: l.batch_no || null, p_exp_date: null, p_do_number: linesFor.do_number || null }))
    } else {
      const item = resolveItem(l.item_code)!
      ;({ error: err } = await supabase.rpc('receive_stock_direct', { p_item_code: item.code, p_factory: linesFor.factory_code, p_qty: qty, p_batch_no: l.batch_no || null, p_exp_date: null, p_do_number: linesFor.do_number || null }))
    }
    if (err) { setError(`${l.item_code}: ${err.message}`); setBusyLine(''); return false }
    // Record which stock lot this line booked (for an exact reversal if it's deleted later)
    const resolved = resolveItem(l.item_code)
    let lotId: string | null = null
    if (resolved) {
      const { data: lot } = await supabase.from('stock_lots').select('id')
        .eq('factory_code', linesFor.factory_code).eq('item_code', resolved.code)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      lotId = lot?.id || null
    }
    const { error: markErr } = await supabase.from('delivery_order_lines').update({ received_at: new Date().toISOString(), stock_lot_id: lotId, received_qty: qty }).eq('id', l.id)
    if (markErr) { setError(`${l.item_code}: stock was added but the line could not be marked received — ${markErr.message}. Ask Head Office to run the database update.`); setBusyLine(''); return false }
    if (!silent) {
      const { data } = await supabase.from('delivery_order_lines').select('*').eq('do_id', linesFor.id).order('item_code')
      const fresh = (data as DoLine[]) || []
      setLines(fresh); setBusyLine('')
      await refreshDoStatus(fresh)
      setSuccess(`Received ${l.item_code}.`)
    }
    return true
  }

  // Production received a different quantity than the DO says: book the ACTUAL
  // amount into stock and raise an issue to Head Office (short / over).
  async function reportShortOver(l: DoLine) {
    if (!linesFor) return
    if (!canEditFac(linesFor.factory_code)) { setError("You have view-only access at this factory."); return }
    const c = lineCalc(l)
    if (!c.known || c.factor === null) { setError(`${l.item_code}: sort out the item / pack size first.`); return }
    if (!l.qc_checked || (photoReq && !l.photo_path)) { setError(`${l.item_code}: tick QC${photoReq ? ' and add a photo' : ''} first.`); return }
    const doQty = Number(l.quantity)
    const v = window.prompt(`How many ${l.unit || 'unit'}(s) did you ACTUALLY receive?\nThe DO says ${doQty}.`, String(doQty))
    if (v == null) return
    const actual = Number(v)
    if (Number.isNaN(actual) || actual < 0) { setError('Enter a valid quantity.'); return }
    const reason = (window.prompt('Note for Head Office (why short / over?) — optional:') || '').trim()
    const ok = await receiveLine(l, false, actual)
    if (!ok || actual === doQty) return
    const diff = Number((actual - doQty).toFixed(3))
    await supabase.from('notifications').insert({
      factory_code: linesFor.factory_code, type: 'grn',
      title: `${diff > 0 ? '⬆ Over' : '⬇ Short'} receipt: ${l.item_code}`,
      body: `DO ${linesFor.do_number || '—'}: ${l.description || l.item_code} — DO ${doQty}, received ${actual} ${l.unit || ''} (${diff > 0 ? '+' : ''}${diff})${reason ? ' · ' + reason : ''}.`,
      link: '/incoming',
    })
    // Also log it as a tracked thread in the Goods Received discussion so it can
    // be checked off / discussed (no @mention here — the notification above is the ping).
    const doTopic = linesFor.do_number || linesFor.file_name || linesFor.id
    await supabase.from('discussions').insert({
      channel: 'goods_received', author_id: profile?.id, author_name: profile?.full_name || null, topic: doTopic,
      body: `${diff > 0 ? '⬆ Over' : '⬇ Short'}: ${l.description || l.item_code} — DO ${doQty}, received ${actual} ${l.unit || ''} (${diff > 0 ? '+' : ''}${diff})${reason ? ' · ' + reason : ''}.`,
    })
    setSuccess(`Received ${actual} ${l.unit || ''} and flagged ${diff > 0 ? 'over' : 'short'} by ${Math.abs(diff)} to Head Office.`)
  }

  // Raise a free-form issue on this DO — posts a thread into the Goods Received
  // discussion tab and pings the DO's location so the warehouse checks & updates it.
  async function raiseIssue() {
    if (!linesFor) return
    const doTopic = linesFor.do_number || linesFor.file_name || linesFor.id
    const msg = window.prompt(`Describe the issue with DO ${doTopic} — the warehouse will see this and can reply / mark it done:`)
    if (msg == null) return
    const text = msg.trim(); if (!text) return
    const fac = linesFor.factory_code
    const { error: err } = await supabase.from('discussions').insert({
      channel: 'goods_received', author_id: profile?.id, author_name: profile?.full_name || null, topic: doTopic, body: text,
      mention_factories: fac && fac !== 'HEAD_OFFICE' ? [fac] : [],
    })
    if (err) { setError('Could not raise the issue: ' + err.message); return }
    setSuccess('Issue raised — it is now in the Goods Received discussion for the warehouse to check.')
  }

  // Receive every line that's ready (QC-ticked + photo + receivable) and not yet received
  async function receiveAllReady() {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor) return
    setReceiving(true); setError(''); setSuccess('')
    const ready = lines.filter(l => !l.received_at && l.qc_checked && (!photoReq || l.photo_path) && (() => { const c = lineCalc(l); return c.known && c.factor !== null })())
    for (const l of ready) await receiveLine(l, true)
    const { data } = await supabase.from('delivery_order_lines').select('*').eq('do_id', linesFor.id).order('item_code')
    const fresh = (data as DoLine[]) || []
    setLines(fresh); setReceiving(false)
    await refreshDoStatus(fresh)
    setSuccess(`Received ${ready.length} item(s) into stock.`)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Goods Received — Delivery Orders</h1>
        <p className="text-gray-500 text-sm mb-5">Upload the warehouse Delivery Order PDF. It is read automatically; review the lines, then receive into stock.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        <div className="bg-white rounded-xl shadow-sm border p-6 mb-8 flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" onChange={onFile} className="hidden" />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
            {uploading ? 'Uploading…' : '📄 Upload Delivery Order PDF'}
          </button>
          <span className="text-sm text-gray-400">Choose the warehouse PDF — it uploads and is read automatically.</span>
        </div>

        <h2 className="font-semibold text-lg mb-2">Uploaded Documents</h2>
        {/* Mobile: one card per document */}
        <input value={docQ} onChange={e => setDocQ(e.target.value)} placeholder="Search file, DO no, factory, item…"
          className="md:hidden w-full border rounded-lg px-3 py-2 text-sm mb-3" />
        <div className="md:hidden space-y-3 mb-8 max-h-[26rem] overflow-y-auto pr-1">
          {docs.length === 0 && <p className="text-center py-6 text-gray-400 border rounded-lg bg-white">No delivery orders uploaded yet</p>}
          {docs.length > 0 && mobDocs.length === 0 && <p className="text-center py-6 text-gray-400 border rounded-lg bg-white">No documents match your search</p>}
          {mobDocs.map(doc => (
            <div key={doc.id} className="bg-white rounded-xl shadow-sm border p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-sm break-all">{doc.file_name}</span>
                <span className="shrink-0 text-right">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>{doc.status}</span>
                  {lineCounts[doc.id]?.total ? <span className="block text-xs text-gray-500 mt-0.5">{lineCounts[doc.id].recv}/{lineCounts[doc.id].total} received</span> : null}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{doc.do_number ? <span className="font-mono">{doc.do_number}</span> : '—'} · {isHO ? factoryName(doc.factory_code) : doc.factory_code} · {new Date(doc.created_at).toLocaleDateString()}</div>
              <div className="flex flex-wrap gap-3 mt-2 pt-2 border-t text-xs">
                <button onClick={() => viewLines(doc)} className="text-blue-600 hover:underline font-medium">View Lines</button>
                {(doc.status === 'Processing' || doc.status === 'Error') && <button onClick={() => reExtract(doc)} className="text-blue-600 hover:underline">Re-read</button>}
                <button onClick={() => setTransportDoc(doc)} className="text-teal-700 hover:underline">🚚 Transport{doc.transport_received_at ? ' ✅' : doc.vehicle ? ' •' : ''}</button>
                <button onClick={() => handleViewPdf(doc.file_path)} className="text-blue-600 hover:underline">View PDF</button>
                <button onClick={() => handleDelete(doc)} className="text-red-500 hover:underline ml-auto">Delete</button>
              </div>
            </div>
          ))}
        </div>
        {/* Desktop: table (scrolls inside the box after ~5 rows) */}
        <div className="hidden md:block bg-white rounded-xl shadow-sm border overflow-auto mb-8 max-h-[24rem]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['File', 'DO No.', 'Factory', 'Status', 'Transport', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
              <tr className="border-b">
                <th className="px-3 py-2"><input value={docFilters.file} onChange={e => setDocFilters({ ...docFilters, file: e.target.value })} placeholder="File, item or PR…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"><input value={docFilters.do} onChange={e => setDocFilters({ ...docFilters, do: e.target.value })} placeholder="Filter…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"><input value={docFilters.factory} onChange={e => setDocFilters({ ...docFilters, factory: e.target.value })} placeholder="Filter…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"><select value={docFilters.status} onChange={e => setDocFilters({ ...docFilters, status: e.target.value })} className="w-full border rounded px-2 py-1 text-xs font-normal bg-white"><option value="">All</option>{docStatuses.map(s => <option key={s} value={s}>{s}</option>)}</select></th>
                <th className="px-3 py-2"><select value={docFilters.transport} onChange={e => setDocFilters({ ...docFilters, transport: e.target.value })} className="w-full border rounded px-2 py-1 text-xs font-normal bg-white"><option value="">All</option><option value="needs_driver">⚠ Needs driver</option>{(['none', 'lorry', 'loaded', 'driver', 'sent', 'received'] as GrStage[]).map(s => <option key={s} value={s}>{GR_LABEL[s]}</option>)}</select></th>
                <th className="px-3 py-2"><input value={docFilters.uploaded} onChange={e => setDocFilters({ ...docFilters, uploaded: e.target.value })} placeholder="Filter…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">No delivery orders uploaded yet</td></tr>}
              {docs.length > 0 && colDocs.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">No documents match the filters</td></tr>}
              {colDocs.map(doc => (
                <tr key={doc.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">{doc.file_name}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 whitespace-nowrap">{doc.do_number || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{isHO ? factoryName(doc.factory_code) : doc.factory_code}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>{doc.status}</span>{lineCounts[doc.id]?.total ? <span className="block text-xs text-gray-500 mt-1">{lineCounts[doc.id].recv}/{lineCounts[doc.id].total} received</span> : null}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{(() => { const st = grStage(doc); return <button onClick={() => setTransportDoc(doc)} className={`px-2 py-0.5 rounded-full text-xs font-medium ${GR_STYLE[st]} hover:opacity-80`}>{GR_LABEL[st]}</button> })()}{!!doc.vehicle && !doc.driver_name && !doc.transport_received_at && <span className="block text-[11px] text-amber-600 mt-0.5">⚠ needs driver</span>}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(doc.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 whitespace-nowrap flex gap-3 items-center">
                    <button onClick={() => viewLines(doc)} className="text-blue-600 hover:underline text-xs">View Lines</button>
                    {(doc.status === 'Processing' || doc.status === 'Error') && (
                      <button onClick={() => reExtract(doc)} className="text-blue-600 hover:underline text-xs">Re-read</button>
                    )}
                    <button onClick={() => setTransportDoc(doc)} className="text-teal-700 hover:underline text-xs whitespace-nowrap">
                      🚚 Transport{doc.transport_received_at ? ' ✅' : doc.vehicle ? ' •' : ''}
                    </button>
                    <button onClick={() => handleViewPdf(doc.file_path)} className="text-blue-600 hover:underline text-xs">View PDF</button>
                    <button onClick={() => handleDelete(doc)} className="text-red-500 hover:underline text-xs">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {linesFor && (
          <div className="bg-white rounded-xl shadow-sm border p-5 mb-10">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <h2 className="font-semibold text-lg">{linesFor.do_number || linesFor.file_name} <span className="text-gray-400 font-normal text-sm">· {isHO ? factoryName(linesFor.factory_code) : linesFor.factory_code} · {linesFor.do_date || '—'}</span></h2>
              <div className="flex items-center gap-3">
                <button onClick={raiseIssue} className="text-amber-700 bg-amber-50 border border-amber-300 hover:bg-amber-100 rounded-lg px-3 py-1 text-xs font-medium">🚩 Raise issue</button>
                <a href={`/discussion?topic=${encodeURIComponent(linesFor.do_number || linesFor.file_name || linesFor.id)}`} className="text-blue-600 hover:underline text-xs">💬 Discussion</a>
                <button onClick={() => setLinesFor(null)} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
              </div>
            </div>
            {(linesFor.pick_run_no || linesFor.so_number) && (() => {
              const linked = !!linesFor.pick_run_no && requests.some(r => r.pick_run_no === linesFor.pick_run_no)
              return (
                <div className="mb-2 text-sm flex flex-wrap items-center gap-2">
                  {linesFor.so_number && <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-mono text-xs">SO {linesFor.so_number}</span>}
                  {linesFor.pick_run_no && <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-mono text-xs">{linesFor.pick_run_no}</span>}
                  <span className={linked ? 'text-green-700 text-xs' : 'text-amber-600 text-xs'}>{linked ? '✓ matched to its pick run — received items fill this run first' : 'no open pick run found with this number — items match by code (oldest request first)'}</span>
                </div>
              )
            })()}
            <p className="text-gray-500 text-sm mb-3">For each line: QC <strong>ticks</strong>{photoReq ? <> and adds a <strong>photo</strong></> : <> (photo optional for Head Office)</>}, then <strong>Receive</strong> that item. You can receive some now and the rest later (partial). Matched items go against their order; known items with no order go into stock flagged <em>unplanned</em>; unknown codes are skipped. Bag/carton quantities convert to KG.</p>
            <div className="flex items-center gap-2 mb-3">
              <input value={lineQ} onChange={e => setLineQ(e.target.value)} placeholder="Search item code or description…" className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm" />
              {lineQ && <span className="text-xs text-gray-500 whitespace-nowrap">{shownLines.length} of {lines.length}</span>}
            </div>
            {(() => {
              const probs = lines.filter(l => !l.received_at).map(l => ({ l, c: lineCalc(l) })).filter(x => !x.c.known || x.c.factor === null)
              if (probs.length === 0) return null
              return (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3 text-sm">
                  <p className="font-semibold text-amber-800 mb-1">⚠ {probs.length} line(s) need attention before they can be received:</p>
                  <ul className="space-y-0.5 text-amber-800">
                    {probs.map(({ l, c }) => (
                      <li key={l.id}>
                        <span className="font-mono font-medium">{l.item_code}</span> — {!c.known
                          ? <span>unknown item code → add it in <strong>Items</strong> (or fix the code via <em>Request edit</em>)</span>
                          : <span>delivered in {l.unit || 'a pack'} but no KG-per-{(l.unit || 'pack').toLowerCase()} set → open <strong>Items</strong>, edit <span className="font-mono">{baseCode(l.item_code)}</span> and set <strong>KG per bag / carton</strong></span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })()}
            {/* Mobile: one card per line (no side-scrolling) */}
            <div className="md:hidden space-y-3">
              {lines.length === 0 && <p className="text-center py-6 text-gray-400 border rounded-lg">No lines read from this document.</p>}
              {lines.length > 0 && shownLines.length === 0 && <p className="text-center py-6 text-gray-400 border rounded-lg">No lines match your search.</p>}
              {shownLines.map(l => {
                const c = lineCalc(l)
                const editable = !l.received_at && canEditFac(linesFor.factory_code)
                return (
                  <div key={l.id} className={`border rounded-lg p-3 ${l.received_at ? 'border-green-300 bg-green-50/60' : (l.qc_checked && l.photo_path ? 'border-green-200 bg-green-50/30' : '')}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-mono font-medium text-sm">{l.item_code}{baseCode(l.item_code) !== l.item_code && <span className="block text-gray-400 font-normal text-xs">→ {baseCode(l.item_code)}</span>}</div>
                      <div className="text-xs text-right">{statusNode(c.known, c.factor, c.matched)}</div>
                    </div>
                    <div className="text-gray-600 text-sm mt-1">{l.description}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm mt-2">
                      <span className="text-gray-500">Delivered: <strong className="text-gray-800">{l.quantity} {l.unit}</strong></span>
                      <span className="text-gray-500">Batch: <span className="font-mono">{l.batch_no || '—'}</span></span>
                      {c.known && c.factor !== null && <span className="text-gray-500">Into stock: <strong className="text-blue-700">{c.into} {c.unit}</strong>{c.factor !== 1 ? <span className="text-gray-400"> ({l.quantity}×{c.factor})</span> : null}</span>}
                    </div>
                    <div className="mt-3 pt-2 border-t flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">{qcBox(l, editable)} QC checked</label>
                      {photoCtl(l, editable)}
                      <span className="ml-auto">{receiveBtn(l)}</span>
                    </div>
                    <div className="mt-2 pt-2 border-t">{reqCtl(l)}</div>
                  </div>
                )
              })}
            </div>

            {/* Desktop: table */}
            <div className="hidden md:block overflow-x-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>{['QC', 'Photo', 'Item', 'Description', 'Delivered', 'Batch', 'Into stock', 'Status', ''].map((h, i) => (
                    <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {lines.length === 0 && <tr><td colSpan={9} className="text-center py-6 text-gray-400">No lines read from this document.</td></tr>}
                  {lines.length > 0 && shownLines.length === 0 && <tr><td colSpan={9} className="text-center py-6 text-gray-400">No lines match your search.</td></tr>}
                  {shownLines.map(l => {
                    const c = lineCalc(l)
                    const editable = !l.received_at && canEditFac(linesFor.factory_code)
                    return (
                      <tr key={l.id} className={`border-b last:border-0 ${l.received_at ? 'bg-green-50/40' : ''}`}>
                        <td className="px-3 py-2 text-center">{qcBox(l, editable)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{photoCtl(l, editable)}</td>
                        <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{l.item_code}{baseCode(l.item_code) !== l.item_code && <span className="block text-gray-400 font-normal text-xs">→ {baseCode(l.item_code)}</span>}</td>
                        <td className="px-3 py-2 text-gray-600">{l.description}</td>
                        <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{l.quantity} {l.unit}</td>
                        <td className="px-3 py-2 font-mono">{l.batch_no || '—'}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{!c.known || c.factor === null ? '—' : <span className="font-semibold text-blue-700">{c.into} {c.unit}{c.factor !== 1 ? <span className="text-gray-400 font-normal"> ({l.quantity}×{c.factor})</span> : null}</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{statusNode(c.known, c.factor, c.matched)}</td>
                        <td className="px-3 py-2 whitespace-nowrap"><div className="flex flex-col items-start gap-1">{receiveBtn(l)}{reqCtl(l)}</div></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {(() => {
              const receivedCount = lines.filter(l => l.received_at).length
              const readyCount = lines.filter(l => !l.received_at && l.qc_checked && (!photoReq || l.photo_path) && (() => { const c = lineCalc(l); return c.known && c.factor !== null })()).length
              return (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-4">
                  <span className="text-sm text-gray-500">{receivedCount} of {lines.length} item(s) received{readyCount ? ` · ${readyCount} ready` : ''}.</span>
                  {canEditFac(linesFor.factory_code) && lines.some(l => !l.received_at && !l.qc_checked) && (
                    <button onClick={tickAllQc} className="sm:ml-auto border border-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 font-medium text-sm w-full sm:w-auto">✓ Tick all QC</button>
                  )}
                  <button onClick={receiveAllReady} disabled={receiving || readyCount === 0}
                    className={`bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium w-full sm:w-auto${lines.some(l => !l.received_at && !l.qc_checked) && canEditFac(linesFor.factory_code) ? '' : ' sm:ml-auto'}`}>
                    {receiving ? 'Receiving…' : `Receive all ready${readyCount ? ` (${readyCount})` : ''}`}
                  </button>
                </div>
              )
            })()}
          </div>
        )}
      </div>

      {transportDoc && (() => {
        const doc = docs.find(d => d.id === transportDoc.id) || transportDoc
        const dest = isHO ? factoryName(doc.factory_code) : doc.factory_code
        const isAdmin = profile?.role === 'admin'
        // Warehouse people enter lorry/loaded/driver/send; the destination factory confirms received.
        const canWh = isWarehouse || isHO || isAdmin
        const canRcv = isHO || isAdmin || (!isWarehouse && (profile?.factory_code === doc.factory_code || (profile?.factory_codes || []).includes(doc.factory_code)))
        const onSite = lorries.filter(l => l.parked_at === doc.factory_code)   // parked at destination (rare)
        const atWh = lorries.filter(l => l.parked_at && l.parked_at !== doc.factory_code)
        const fmtT = (iso?: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
        const by = (uid?: string | null) => uid && userNames[uid] ? ` · by ${userNames[uid]}` : ''
        const step = (done: boolean, label: string, when?: string | null) => (
          <span className={`inline-flex items-center gap-1 text-xs ${done ? 'text-green-700' : 'text-gray-400'}`}>{done ? '✅' : '○'} {label}{done && when ? ` · ${fmtT(when)}` : ''}</span>
        )
        return (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setTransportDoc(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-lg my-8 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-lg">🚚 Transport — {doc.do_number || doc.file_name}</h3>
              <button onClick={() => setTransportDoc(null)} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
            </div>
            <p className="text-sm text-gray-500 mb-4">Send these goods to <strong>{dest}</strong>. Assign a lorry, mark loaded, assign a driver (can be later), send — the factory confirms on arrival.</p>

            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4 pb-3 border-b">
              {step(!!doc.vehicle, 'Lorry')}
              {step(!!doc.loaded_at, 'Loaded', doc.loaded_at)}
              {step(!!doc.driver_name, 'Driver', doc.driver_assigned_at)}
              {step(!!doc.gr_departed_at, 'Sent', doc.gr_departed_at)}
              {step(!!doc.transport_received_at, 'Received', doc.transport_received_at)}
            </div>

            <div className="space-y-4">
              <p className="text-xs text-gray-400">{canWh ? 'You (warehouse) set up the lorry, loaded, driver and send. The destination factory confirms receipt.' : canRcv ? 'The warehouse sets up the lorry & driver. You confirm when it arrives.' : 'View only.'}</p>
              {/* Lorry */}
              <div>
                <label className="block text-sm font-medium mb-1">Lorry</label>
                {doc.vehicle
                  ? <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 bg-teal-50 text-teal-800 rounded-full px-2.5 py-1 text-sm font-medium">🚚 {doc.vehicle}</span><span className="text-xs text-gray-400">{by(doc.lorry_assigned_by)}</span>{canWh && <button onClick={() => grTransport('assign_gr_transport', { p_doc_id: doc.id, p_kind: 'lorry', p_value: null })} disabled={tBusy} className="text-xs text-blue-600 hover:underline">change</button>}</div>
                  : canWh
                    ? <select value="" onChange={e => grTransport('assign_gr_transport', { p_doc_id: doc.id, p_kind: 'lorry', p_value: e.target.value })} disabled={tBusy} className="border rounded-lg px-2 py-1.5 text-sm w-full">
                        <option value="">Assign a lorry…</option>
                        {atWh.length > 0 && <optgroup label="🅿 Parked at a warehouse/site">{atWh.map(l => <option key={l.name} value={l.name}>{l.name}{l.lorry_type ? ` · ${l.lorry_type}` : ''} · at {factoryName(l.parked_at!)}</option>)}</optgroup>}
                        {onSite.length > 0 && <optgroup label="🅿 Parked at destination">{onSite.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}</optgroup>}
                        <optgroup label="Other lorries">{lorries.filter(l => !l.parked_at).map(l => <option key={l.name} value={l.name}>{l.name}{l.lorry_type ? ` · ${l.lorry_type}` : ''}</option>)}</optgroup>
                      </select>
                    : <span className="text-sm text-gray-400">Not assigned yet</span>}
              </div>

              {/* Loaded */}
              <div>
                <label className="block text-sm font-medium mb-1">Loaded</label>
                {doc.loaded_at
                  ? <span className="text-sm text-green-700">✅ Loaded {fmtT(doc.loaded_at)}<span className="text-gray-400 text-xs">{by(doc.loaded_by)}</span>{canWh && <button onClick={() => grTransport('mark_gr_loaded', { p_doc_id: doc.id, p_on: false })} disabled={tBusy} className="ml-1 text-gray-400 hover:underline text-xs">undo</button>}</span>
                  : canWh
                    ? <div className="flex items-center gap-2"><button onClick={() => grTransport('mark_gr_loaded', { p_doc_id: doc.id, p_on: true })} disabled={tBusy || !doc.vehicle} className="bg-amber-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-amber-700 disabled:opacity-50">📦 Mark loaded</button>{!doc.vehicle && <span className="text-xs text-gray-400">assign a lorry first</span>}</div>
                    : <span className="text-sm text-gray-400">Not loaded yet</span>}
              </div>

              {/* Driver */}
              <div>
                <label className="block text-sm font-medium mb-1">Driver <span className="text-gray-400 font-normal">(can be assigned later)</span></label>
                {doc.driver_name
                  ? <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 rounded-full px-2.5 py-1 text-sm font-medium">👤 {doc.driver_name}</span><span className="text-xs text-gray-400">{by(doc.driver_assigned_by)}</span>{canWh && <button onClick={() => grTransport('assign_gr_transport', { p_doc_id: doc.id, p_kind: 'driver', p_value: null })} disabled={tBusy} className="text-xs text-blue-600 hover:underline">change</button>}</div>
                  : canWh
                    ? <select value="" onChange={e => grTransport('assign_gr_transport', { p_doc_id: doc.id, p_kind: 'driver', p_value: e.target.value })} disabled={tBusy} className="border rounded-lg px-2 py-1.5 text-sm w-full">
                        <option value="">Assign a driver…</option>
                        {crew.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    : <span className="text-sm text-gray-400">Not assigned yet</span>}
              </div>

              {/* Send + Receive */}
              <div className="flex items-center gap-3 pt-2 border-t">
                {doc.gr_departed_at
                  ? <span className="text-green-700 text-sm">✅ Sent {fmtT(doc.gr_departed_at)}<span className="text-gray-400 text-xs">{by(doc.gr_departed_by)}</span>{canWh && <button onClick={() => grTransport('mark_gr_out', { p_doc_id: doc.id, p_out: false })} disabled={tBusy} className="ml-1 text-gray-400 hover:underline text-xs">undo</button>}</span>
                  : canWh
                    ? <button onClick={() => grTransport('mark_gr_out', { p_doc_id: doc.id, p_out: true })} disabled={tBusy || !doc.vehicle} className="bg-teal-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-teal-700 disabled:opacity-50">🚚 Send to factory</button>
                    : <span className="text-sm text-gray-400">Not sent yet</span>}
                {doc.transport_received_at
                  ? <span className="text-green-700 text-sm font-medium ml-auto">✅ Received {fmtT(doc.transport_received_at)}<span className="text-gray-400 text-xs font-normal">{by(doc.transport_received_by)}</span></span>
                  : canRcv
                    ? <button onClick={() => grTransport('confirm_gr_received', { p_doc_id: doc.id })} disabled={tBusy} className="ml-auto bg-green-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-green-700 disabled:opacity-50">Confirm received</button>
                    : <span className="text-sm text-gray-400 ml-auto">Awaiting the factory to confirm</span>}
              </div>

              {/* History — audit/back-up of every change */}
              <div className="pt-3 border-t">
                <div className="text-xs font-medium text-gray-500 mb-1">🕘 History</div>
                {grLog.length === 0
                  ? <p className="text-xs text-gray-400">No actions yet.</p>
                  : <ul className="space-y-0.5 max-h-40 overflow-auto text-xs">
                      {grLog.map((h, i) => (
                        <li key={i} className="text-gray-600"><span className="font-medium">{h.action}</span>{h.detail ? `: ${h.detail}` : ''} <span className="text-gray-400">· {h.actor_name || '—'} · {fmtT(h.at)}</span></li>
                      ))}
                    </ul>}
              </div>
            </div>
          </div>
        </div>
        )
      })()}

      {editReq && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setEditReq(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-lg my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">Request changes to a line</h2>
            <p className="text-gray-500 text-sm mb-4">Goes to Head Office for approval.{editReq.received_at ? ' This line is already received — item/qty/unit/batch changes need it deleted & received again.' : ''}</p>
            <div className="space-y-3">
              {EDIT_FIELDS.map(f => (
                <div key={f.key}>
                  <label className="block text-sm font-medium mb-1">{f.label}</label>
                  {f.key === 'item_code' ? (
                    <>
                      <ItemCombo items={itemsMaster} value={editForm.item_code || ''}
                        onPick={(code, description) => setEditForm({ ...editForm, item_code: code, description })} />
                      {editForm.item_code && !itemByCode(editForm.item_code)
                        ? (itemByCode(baseCode(editForm.item_code))
                            ? <span className="text-xs text-gray-400">→ {baseCode(editForm.item_code)} (in stock as the base material)</span>
                            : (editReq && (editForm.item_code || '') === (editReq.item_code || '')
                                // Unchanged original DO code — it was already accepted, so this is fine.
                                ? <span className="text-xs text-gray-400">Original code from the Delivery Order — you can edit the other fields (e.g. batch no).</span>
                                : <span className="text-xs text-amber-600">This code isn’t in the Items master — type a code or name and pick it from the list.</span>))
                        : null}
                    </>
                  ) : f.key === 'description' ? (
                    <input value={editForm.description || ''} disabled className="w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-500" title="Follows the item code" />
                  ) : (
                    <input value={editForm[f.key] || ''} onChange={e => setEditForm({ ...editForm, [f.key]: e.target.value })}
                      className="w-full border rounded-lg px-3 py-2" />
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={submitEditReq} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 font-medium">Send for approval</button>
              <button onClick={() => setEditReq(null)} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
