'use client'
import { useEffect, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'

interface DeliveryOrder {
  id: string
  file_name: string
  file_path: string
  do_number: string | null
  do_date: string | null
  factory_code: string
  status: string
  created_at: string
}
interface DoLine { id: string; item_code: string; description: string; quantity: number; unit: string; batch_no: string; qc_checked: boolean; photo_path: string | null; received_at: string | null }
interface MRItem { id: string; item_code: string; unit: string; requested_qty: number; received_qty: number }
interface MatReq { id: string; factory_code: string; status: string; material_request_items: MRItem[] }

const STATUS_STYLES: Record<string, string> = {
  Processing: 'bg-blue-100 text-blue-700',
  Review: 'bg-purple-100 text-purple-700',
  'Partially Received': 'bg-teal-100 text-teal-700',
  Received: 'bg-green-100 text-green-700',
  Error: 'bg-red-100 text-red-700',
}
const ACTIVE = ['Open', 'Partially Received']
const PACK = 'BAG|CTN|CARTON'

export default function IncomingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'receiving')
  const [docs, setDocs] = useState<DeliveryOrder[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Lines / review state for the currently opened document
  const [linesFor, setLinesFor] = useState<DeliveryOrder | null>(null)
  const [lines, setLines] = useState<DoLine[]>([])
  const [requests, setRequests] = useState<MatReq[]>([])
  const [kgPerBag, setKgPerBag] = useState<Record<string, number>>({})
  const [doItems, setDoItems] = useState<Record<string, string>>({})
  const [receiving, setReceiving] = useState(false)
  const [busyLine, setBusyLine] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { loadDocs(); loadFactories() } }, [profile])

  async function loadDocs() {
    const { data } = await supabase.from('delivery_orders').select('*').order('created_at', { ascending: false })
    setDocs((data as DeliveryOrder[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) await doUpload(file)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function doUpload(file: File) {
    if (!profile) return
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
    setLinesFor(doc); setError(''); setSuccess('')
    const { data: ls } = await supabase.from('delivery_order_lines').select('*').eq('do_id', doc.id).order('item_code')
    const dl = (ls as DoLine[]) || []
    setLines(dl)
    // open requests for this factory (for matching)
    const { data: reqs } = await supabase.from('material_requests')
      .select('id, factory_code, status, material_request_items(id, item_code, unit, requested_qty, received_qty)')
      .eq('factory_code', doc.factory_code).in('status', ACTIVE)
    setRequests((reqs as MatReq[]) || [])
    // kg/bag overrides
    const { data: ov } = await supabase.from('items').select('code, kg_per_bag').not('kg_per_bag', 'is', null)
    const m: Record<string, number> = {}; (ov || []).forEach(r => { if (r.kg_per_bag) m[r.code] = Number(r.kg_per_bag) }); setKgPerBag(m)
    // units of every code + base code (to know what's a real item)
    const codes = [...new Set(dl.flatMap(l => [l.item_code, baseCode(l.item_code)]))]
    const { data: items } = await supabase.from('items').select('code, unit').in('code', codes)
    const u: Record<string, string> = {}; (items || []).forEach(r => { u[r.code] = r.unit || '' }); setDoItems(u)
  }

  // Reload just the lines of the open document (after a QC tick or photo)
  async function reloadLines() {
    if (!linesFor) return
    const { data } = await supabase.from('delivery_order_lines').select('*').eq('do_id', linesFor.id).order('item_code')
    setLines((data as DoLine[]) || [])
  }

  // QC ticks a line as checked (or unchecks)
  async function toggleQc(line: DoLine) {
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
    const out: MRItem[] = []
    ;[...requests].reverse().filter(r => ACTIVE.includes(r.status)).forEach(r => (r.material_request_items || []).forEach(it => { if (it.item_code === code || it.item_code === base) out.push(it) }))
    return out
  }
  // Prefer the BASE code (the recipe's KG raw material, e.g. D242) over the bagged SKU (D242-25KG/BAG, unit BAG)
  const resolveItem = (code: string): { code: string; unit: string } | null => {
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
  const num = (n: number) => Number(Number(n).toPrecision(12))

  // Per-line computed display values (shared by the desktop table and mobile cards)
  const lineCalc = (l: DoLine) => {
    const ml = matchLines(l.item_code)
    const matched = ml.length > 0
    const item = matched ? null : resolveItem(l.item_code)
    const known = matched || !!item
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
    const ready = l.qc_checked && !!l.photo_path && c.known && c.factor !== null
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
    if (!linesFor || l.received_at) return
    const c = lineCalc(l)
    if (!c.known || c.factor === null) { setError(`${l.item_code}: cannot be received (unknown item or pack size).`); return }
    if (!l.qc_checked || !l.photo_path) { setError(`${l.item_code}: tick QC and add a photo first.`); return }
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
    await supabase.from('delivery_order_lines').update({ received_at: new Date().toISOString() }).eq('id', l.id)
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
    if (!linesFor) return
    setReceiving(true); setError(''); setSuccess('')
    const ready = lines.filter(l => !l.received_at && l.qc_checked && l.photo_path && (() => { const c = lineCalc(l); return c.known && c.factor !== null })())
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
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mb-8">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['File', 'DO No.', 'Factory', 'Status', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {docs.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No delivery orders uploaded yet</td></tr>}
              {docs.map(doc => (
                <tr key={doc.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">{doc.file_name}</td>
                  <td className="px-4 py-3 font-mono text-gray-500 whitespace-nowrap">{doc.do_number || '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{isHO ? factoryName(doc.factory_code) : doc.factory_code}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>{doc.status}</span></td>
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
            <p className="text-gray-500 text-sm mb-3">For each line: QC <strong>ticks</strong> and adds a <strong>photo</strong>, then <strong>Receive</strong> that item. You can receive some now and the rest later (partial). Matched items go against their order; known items with no order go into stock flagged <em>unplanned</em>; unknown codes are skipped. Bag/carton quantities convert to KG.</p>
            {/* Mobile: one card per line (no side-scrolling) */}
            <div className="md:hidden space-y-3">
              {lines.length === 0 && <p className="text-center py-6 text-gray-400 border rounded-lg">No lines read from this document.</p>}
              {lines.map(l => {
                const c = lineCalc(l)
                const editable = !l.received_at
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
                  {lines.map(l => {
                    const c = lineCalc(l)
                    const editable = !l.received_at
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
                        <td className="px-3 py-2 whitespace-nowrap">{receiveBtn(l)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {(() => {
              const receivedCount = lines.filter(l => l.received_at).length
              const readyCount = lines.filter(l => !l.received_at && l.qc_checked && l.photo_path && (() => { const c = lineCalc(l); return c.known && c.factor !== null })()).length
              return (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-4">
                  <span className="text-sm text-gray-500">{receivedCount} of {lines.length} item(s) received{readyCount ? ` · ${readyCount} ready` : ''}.</span>
                  <button onClick={receiveAllReady} disabled={receiving || readyCount === 0}
                    className="sm:ml-auto bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium w-full sm:w-auto">
                    {receiving ? 'Receiving…' : `Receive all ready${readyCount ? ` (${readyCount})` : ''}`}
                  </button>
                </div>
              )
            })()}
          </div>
        )}
      </div>
    </div>
  )
}
