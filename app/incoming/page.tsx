'use client'
import { useEffect, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
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
interface DoLine { id: string; item_code: string; description: string; quantity: number; unit: string; batch_no: string }
interface MRItem { id: string; item_code: string; unit: string; requested_qty: number; received_qty: number }
interface MatReq { id: string; factory_code: string; status: string; material_request_items: MRItem[] }

const STATUS_STYLES: Record<string, string> = {
  Processing: 'bg-blue-100 text-blue-700',
  Review: 'bg-purple-100 text-purple-700',
  Received: 'bg-green-100 text-green-700',
  Error: 'bg-red-100 text-red-700',
}
const ACTIVE = ['Open', 'Partially Received']
const PACK = 'BAG|CTN|CARTON'

export default function IncomingPage() {
  const { profile, loading, error: profileError } = useProfile()
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
  const resolveItem = (code: string): { code: string; unit: string } | null => {
    if (doItems[code] != null) return { code, unit: doItems[code] }
    const b = baseCode(code); if (doItems[b] != null) return { code: b, unit: doItems[b] }
    return null
  }
  const parseKgPerBag = (code: string, desc: string) => {
    const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*KG\\s*\\/\\s*(?:${PACK})`, 'i').exec(`${code} ${desc || ''}`)
    return m ? Number(m[1]) : null
  }
  const bagFactor = (code: string, desc: string, doUnit: string, reqUnit: string | undefined): number | null => {
    const wantsKg = /kg/i.test(reqUnit || ''); const doInKg = /kg/i.test(doUnit || '')
    if (!wantsKg || doInKg) return 1
    return kgPerBag[code] ?? kgPerBag[baseCode(code)] ?? parseKgPerBag(code, desc)
  }
  const num = (n: number) => Number(Number(n).toPrecision(12))

  async function receiveDoc() {
    if (!linesFor) return
    setReceiving(true); setError(''); setSuccess('')
    const byCode: Record<string, { qty: number; unit: string; desc: string; batch: string }> = {}
    lines.forEach(l => { const g = (byCode[l.item_code] = byCode[l.item_code] || { qty: 0, unit: l.unit, desc: l.description, batch: '' }); g.qty += Number(l.quantity) || 0; if (!g.batch) g.batch = l.batch_no })
    let applied = 0, unplanned = 0, needFactor = 0
    const unknown: string[] = []
    for (const code of Object.keys(byCode)) {
      const g = byCode[code]
      const ml = matchLines(code)
      if (ml.length > 0) {
        const factor = bagFactor(code, g.desc, g.unit, ml[0].unit)
        if (factor === null) { needFactor++; continue }
        const { error: e } = await supabase.rpc('receive_combined_lot', { p_item_ids: ml.map(l => l.id), p_qty: g.qty * factor, p_batch_no: g.batch || null, p_exp_date: null, p_do_number: linesFor.do_number || null })
        if (e) { setError(`${code}: ${e.message}`); setReceiving(false); return }
        applied++
      } else {
        const item = resolveItem(code)
        if (!item) { unknown.push(code); continue }
        const factor = bagFactor(code, g.desc, g.unit, item.unit)
        if (factor === null) { needFactor++; continue }
        const { error: e } = await supabase.rpc('receive_stock_direct', { p_item_code: item.code, p_factory: linesFor.factory_code, p_qty: g.qty * factor, p_batch_no: g.batch || null, p_exp_date: null, p_do_number: linesFor.do_number || null })
        if (e) { setError(`${code}: ${e.message}`); setReceiving(false); return }
        unplanned++
      }
    }
    await supabase.from('delivery_orders').update({ status: 'Received' }).eq('id', linesFor.id)
    setReceiving(false); setLinesFor(null)
    setSuccess(`Received ${linesFor.do_number || linesFor.file_name} — ${applied} against order(s)`
      + `${unplanned ? `, ${unplanned} into stock (unplanned)` : ''}`
      + `${needFactor ? `, ${needFactor} need a "KG per bag" set first` : ''}`
      + `${unknown.length ? `, skipped unknown: ${unknown.join(', ')}` : ''}.`)
    loadDocs()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
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
            <p className="text-gray-500 text-sm mb-3">Matched items are received against their order; known items with no order go into stock flagged <em>unplanned</em>; unknown codes are skipped. Bag/carton quantities convert to KG.</p>
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>{['Item', 'Description', 'Delivered', 'Batch', 'Into stock', 'Status'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {lines.length === 0 && <tr><td colSpan={6} className="text-center py-6 text-gray-400">No lines read from this document.</td></tr>}
                  {lines.map(l => {
                    const ml = matchLines(l.item_code)
                    const matched = ml.length > 0
                    const item = matched ? null : resolveItem(l.item_code)
                    const known = matched || !!item
                    const reqUnit = matched ? ml[0]?.unit : item?.unit
                    const factor = known ? bagFactor(l.item_code, l.description, l.unit, reqUnit) : 1
                    const into = factor === null ? null : num(Number(l.quantity) * factor)
                    return (
                      <tr key={l.id} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{l.item_code}{baseCode(l.item_code) !== l.item_code && <span className="block text-gray-400 font-normal text-xs">→ {baseCode(l.item_code)}</span>}</td>
                        <td className="px-3 py-2 text-gray-600">{l.description}</td>
                        <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{l.quantity} {l.unit}</td>
                        <td className="px-3 py-2 font-mono">{l.batch_no || '—'}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">{!known || factor === null ? '—' : <span className="font-semibold text-blue-700">{into} {reqUnit}{factor !== 1 ? <span className="text-gray-400 font-normal"> ({l.quantity}×{factor})</span> : null}</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {!known ? <span className="text-red-600">⚠ unknown item — skip</span>
                            : factor === null ? <span className="text-amber-600">⚠ set KG per bag</span>
                            : matched ? <span className="text-green-600">✓ against order</span>
                            : <span className="text-indigo-600">→ stock (unplanned)</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {linesFor.status !== 'Received' ? (
              <div className="flex items-center justify-end gap-3 mt-4">
                <button onClick={receiveDoc} disabled={receiving || lines.length === 0}
                  className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                  {receiving ? 'Receiving…' : 'Receive into stock'}
                </button>
              </div>
            ) : (
              <p className="text-green-600 text-sm mt-4">✓ This delivery order has been received.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
