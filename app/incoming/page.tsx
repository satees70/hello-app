'use client'
import { useEffect, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can } from '@/lib/permissions'

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
const PACK = 'BAG|CTN|CARTON'

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
  const [docFilters, setDocFilters] = useState({ file: '', do: '', factory: '', status: '', uploaded: '' })
  const [docQ, setDocQ] = useState('')   // single search box used on mobile
  const [lineCounts, setLineCounts] = useState<Record<string, { recv: number; total: number }>>({})
  const [docLineText, setDocLineText] = useState<Record<string, string>>({})   // do_id -> its item codes + descriptions (for searching documents by content)
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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
  async function submitEditReq() {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!editReq || !linesFor) return
    const orig: Record<string, string> = { item_code: editReq.item_code || '', description: editReq.description || '', quantity: String(editReq.quantity ?? ''), unit: editReq.unit || '', batch_no: editReq.batch_no || '' }
    if (editForm.item_code && !itemByCode(editForm.item_code) && !itemByCode(baseCode(editForm.item_code))) { setError('Pick a valid item code from the Items master.'); return }
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
  const photoReq = false   // photo optional for now (phone camera issues) — can still attach one

  // Tick QC on every not-yet-received line at once
  async function tickAllQc() {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor) return
    await supabase.from('delivery_order_lines').update({ qc_checked: true }).eq('do_id', linesFor.id).is('received_at', null)
    reloadLines()
  }

  useEffect(() => { if (profile) { loadDocs(); loadFactories(); loadItemsMaster() } }, [profile])

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
  // The File search also matches a document by the items inside it (codes + descriptions)
  const fileMatch = (d: DeliveryOrder, q: string) => !q || inc(d.file_name, q) || inc(docLineText[d.id] || '', q)
  const colDocs = docs.filter(d =>
    fileMatch(d, docFilters.file) && inc(d.do_number, docFilters.do) && inc(docFacName(d), docFilters.factory) &&
    (!docFilters.status || d.status === docFilters.status) && inc(new Date(d.created_at).toLocaleString(), docFilters.uploaded))
  const mobDocs = docs.filter(d => !docQ || [d.file_name, d.do_number, docFacName(d), d.status, docLineText[d.id] || ''].some(v => inc(v, docQ)))
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
      const res = await fetch('/api/extract-delivery-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doId: inserted.id, filePath: path }) })
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
      const res = await fetch('/api/extract-delivery-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doId: doc.id, filePath: doc.file_path }) })
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
    if (l.received_at) return <span className="text-green-600 text-xs font-medium whitespace-nowrap">✓ Received</span>
    const c = lineCalc(l)
    const ready = l.qc_checked && (!photoReq || !!l.photo_path) && c.known && c.factor !== null
    return (
      <button onClick={() => receiveLine(l)} disabled={!ready || busyLine === l.id}
        className="bg-blue-600 text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-40 whitespace-nowrap">
        {busyLine === l.id ? '…' : 'Receive'}
      </button>
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
  async function receiveLine(l: DoLine, silent = false) {
    if (!canEditFac(linesFor?.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!linesFor || l.received_at) return
    const c = lineCalc(l)
    if (!c.known || c.factor === null) { setError(`${l.item_code}: cannot be received (unknown item or pack size).`); return }
    if (!l.qc_checked || (photoReq && !l.photo_path)) { setError(`${l.item_code}: tick QC${photoReq ? ' and add a photo' : ''} first.`); return }
    if (!silent) { setBusyLine(l.id); setError(''); setSuccess('') }
    const qty = Number(l.quantity) * c.factor
    const ml = matchLines(l.item_code)
    let err
    if (ml.length > 0) {
      ;({ error: err } = await supabase.rpc('receive_combined_lot', { p_item_ids: ml.map(x => x.id), p_qty: qty, p_batch_no: l.batch_no || null, p_exp_date: null, p_do_number: linesFor.do_number || null }))
    } else {
      const item = resolveItem(l.item_code)!
      ;({ error: err } = await supabase.rpc('receive_stock_direct', { p_item_code: item.code, p_factory: linesFor.factory_code, p_qty: qty, p_batch_no: l.batch_no || null, p_exp_date: null, p_do_number: linesFor.do_number || null }))
    }
    if (err) { setError(`${l.item_code}: ${err.message}`); setBusyLine(''); return }
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
    if (markErr) { setError(`${l.item_code}: stock was added but the line could not be marked received — ${markErr.message}. Ask Head Office to run the database update.`); setBusyLine(''); return }
    if (!silent) {
      const { data } = await supabase.from('delivery_order_lines').select('*').eq('do_id', linesFor.id).order('item_code')
      const fresh = (data as DoLine[]) || []
      setLines(fresh); setBusyLine('')
      await refreshDoStatus(fresh)
      setSuccess(`Received ${l.item_code}.`)
    }
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
              <tr>{['File', 'DO No.', 'Factory', 'Status', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
              <tr className="border-b">
                <th className="px-3 py-2"><input value={docFilters.file} onChange={e => setDocFilters({ ...docFilters, file: e.target.value })} placeholder="File or item…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"><input value={docFilters.do} onChange={e => setDocFilters({ ...docFilters, do: e.target.value })} placeholder="Filter…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"><input value={docFilters.factory} onChange={e => setDocFilters({ ...docFilters, factory: e.target.value })} placeholder="Filter…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"><select value={docFilters.status} onChange={e => setDocFilters({ ...docFilters, status: e.target.value })} className="w-full border rounded px-2 py-1 text-xs font-normal bg-white"><option value="">All</option>{docStatuses.map(s => <option key={s} value={s}>{s}</option>)}</select></th>
                <th className="px-3 py-2"><input value={docFilters.uploaded} onChange={e => setDocFilters({ ...docFilters, uploaded: e.target.value })} placeholder="Filter…" className="w-full border rounded px-2 py-1 text-xs font-normal" /></th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No delivery orders uploaded yet</td></tr>}
              {docs.length > 0 && colDocs.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No documents match the filters</td></tr>}
              {colDocs.map(doc => (
                <tr key={doc.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">{doc.file_name}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 whitespace-nowrap">{doc.do_number || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{isHO ? factoryName(doc.factory_code) : doc.factory_code}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>{doc.status}</span>{lineCounts[doc.id]?.total ? <span className="block text-xs text-gray-500 mt-1">{lineCounts[doc.id].recv}/{lineCounts[doc.id].total} received</span> : null}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(doc.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 whitespace-nowrap flex gap-3">
                    <button onClick={() => viewLines(doc)} className="text-blue-600 hover:underline text-xs">View Lines</button>
                    {(doc.status === 'Processing' || doc.status === 'Error') && (
                      <button onClick={() => reExtract(doc)} className="text-blue-600 hover:underline text-xs">Re-read</button>
                    )}
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
              <button onClick={() => setLinesFor(null)} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
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
                      {editForm.item_code && !itemByCode(editForm.item_code) ? (itemByCode(baseCode(editForm.item_code)) ? <span className="text-xs text-gray-400">→ {baseCode(editForm.item_code)} (in stock as the base material)</span> : <span className="text-xs text-amber-600">This code isn’t in the Items master — type a code or name and pick it from the list.</span>) : null}
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
