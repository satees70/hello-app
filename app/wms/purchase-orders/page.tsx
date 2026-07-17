'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'
import { openWmsDiscussion } from '@/components/WmsDiscussionWidget'

interface PO {
  id: string; po_number: string | null; supplier_name: string | null; order_date: string | null; expected_date: string | null
  file_name: string | null; file_path: string | null; status: string; source: string; sql_grn_no: string | null
  error_message: string | null; created_at: string
  wms_po_lines?: { count: number }[]
}
type Recv = { item: string; batch: string; qty: number }
interface POLine { id: string; line_no: number | null; item_id: string | null; item_code: string; description: string | null; quantity: number; qty_received: number; uom: string | null }
interface Item { code: string; description: string; unit: string }
interface DraftLine { item_code: string; description: string; quantity: string; uom: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const STATUS_CHIP: Record<string, string> = {
  Processing: 'bg-gray-100 text-gray-600', Open: 'bg-amber-100 text-amber-700', 'Partially Received': 'bg-emerald-100 text-emerald-700',
  Fulfilled: 'bg-emerald-100 text-emerald-700', Cancelled: 'bg-gray-100 text-gray-400', Error: 'bg-red-100 text-red-700',
}

export default function WmsPurchaseOrdersPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [pos, setPos] = useState<PO[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [suppliers, setSuppliers] = useState<{ name: string; code: string }[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const [replacePo, setReplacePo] = useState<PO | null>(null)   // PO whose PDF is being replaced with an amended one

  const [linesFor, setLinesFor] = useState<PO | null>(null)
  const [lines, setLines] = useState<POLine[]>([])

  // manual entry
  const [showManual, setShowManual] = useState(false)
  const [mSupplier, setMSupplier] = useState(''); const [mPo, setMPo] = useState(''); const [mExpected, setMExpected] = useState('')
  const [mLines, setMLines] = useState<DraftLine[]>([{ item_code: '', description: '', quantity: '', uom: '' }])
  const [saving, setSaving] = useState(false)

  const [statusFilter, setStatusFilter] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [q, setQ] = useState('')   // search by PO / supplier / item
  const [descsByPo, setDescsByPo] = useState<Record<string, (string | null)[]>>({})
  const [itemText, setItemText] = useState<Record<string, string>>({})
  const [recvByPo, setRecvByPo] = useState<Record<string, Recv[]>>({})   // received batches per PO
  const [putStatus, setPutStatus] = useState<Record<string, 'pending' | 'done'>>({})   // put-away state per PO
  const [grnEdits, setGrnEdits] = useState<Record<string, string>>({})   // SQL GRN inline edits
  const [poEditPending, setPoEditPending] = useState<Set<string>>(new Set())   // PO line ids with a pending edit request
  const [poEdit, setPoEdit] = useState<{ lineId: string; item_code: string; description: string; quantity: string; uom: string; reason: string } | null>(null)
  useEffect(() => { const s = new URLSearchParams(window.location.search).get('status'); if (s) setStatusFilter(s) }, [])
  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const { data } = await supabase.from('wms_purchase_orders').select('*, wms_po_lines(count)').order('created_at', { ascending: false }).limit(100)
    const list = (data as PO[]) || []
    setPos(list)
    // Item descriptions per PO (for the GCH filter) + a searchable text blob (codes + descriptions).
    const ids = list.map(o => o.id)
    if (ids.length) {
      const { data: pl } = await supabase.from('wms_po_lines').select('po_id, item_code, description').in('po_id', ids)
      const m: Record<string, (string | null)[]> = {}; const t: Record<string, string> = {}
      ;(pl as { po_id: string; item_code: string | null; description: string | null }[] || []).forEach(l => {
        (m[l.po_id] ||= []).push(l.description)
        t[l.po_id] = `${t[l.po_id] || ''} ${l.item_code || ''} ${l.description || ''}`.toLowerCase()
      })
      setDescsByPo(m); setItemText(t)
      // Received batches per PO (via its GRNs) + put-away status (still-in-GOODS-IN = pending).
      const { data: grns } = await supabase.from('wms_grns').select('id, po_id').in('po_id', ids)
      const poByGrn: Record<string, string> = {}; const grnIds: string[] = []
      ;(grns as { id: string; po_id: string | null }[] || []).forEach(g => { if (g.po_id) { poByGrn[g.id] = g.po_id; grnIds.push(g.id) } })
      const recv: Record<string, Recv[]> = {}
      if (grnIds.length) {
        const { data: gl } = await supabase.from('wms_grn_lines').select('grn_id, item_code, batch_no, qty_received').in('grn_id', grnIds)
        ;(gl as { grn_id: string; item_code: string; batch_no: string | null; qty_received: number }[] || []).forEach(l => {
          const po = poByGrn[l.grn_id]; if (!po) return
          ;(recv[po] ||= []).push({ item: l.item_code, batch: l.batch_no || '', qty: Number(l.qty_received || 0) })
        })
      }
      setRecvByPo(recv)
      const { data: gin } = await supabase.from('wms_stock').select('item_code, batch_no, quantity').eq('location_code', 'GOODS-IN').gt('quantity', 0)
      const ginSet = new Set(((gin as { item_code: string; batch_no: string | null }[]) || []).map(s => `${s.item_code}|${s.batch_no || ''}`))
      const ps: Record<string, 'pending' | 'done'> = {}
      for (const [po, lines] of Object.entries(recv)) ps[po] = lines.some(l => ginSet.has(`${l.item}|${l.batch}`)) ? 'pending' : 'done'
      setPutStatus(ps)
    } else { setDescsByPo({}); setItemText({}); setRecvByPo({}); setPutStatus({}) }
    const { data: sup } = await supabase.from('wms_suppliers').select('name, code').eq('active', true).order('name')
    setSuppliers((sup as { name: string; code: string }[]) || [])
    if (!items.length) setItems(await fetchAll<Item>('items', 'code, description, unit', 'code'))
  }

  async function saveSqlGrn(po: PO) {
    const grn = (grnEdits[po.id] ?? po.sql_grn_no ?? '').trim()
    setErr(''); setMsg('')
    const { error } = await supabase.rpc('set_po_sql_grn', { p_po_id: po.id, p_grn: grn || null })
    if (error) { setErr(/set_po_sql_grn|sql_grn_no/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-po-sql-grn.sql in the Supabase SQL editor.' : error.message); return }
    setPos(prev => prev.map(p => p.id === po.id ? { ...p, sql_grn_no: grn || null } : p))
    setMsg(`SQL GRN saved for ${po.po_number || 'PO'}.`)
  }

  // Put-away report: where the received goods ended up — item, batch, bin, qty.
  async function putawayReport(po: PO) {
    const recv = recvByPo[po.id] || []
    if (!recv.length) { setErr('Nothing received on this PO yet.'); return }
    const codes = [...new Set(recv.map(r => r.item))]
    const want = new Set(recv.map(r => `${r.item}|${r.batch}`))
    const { data: st } = await supabase.from('wms_stock').select('item_code, description, batch_no, location_code, quantity').in('item_code', codes).gt('quantity', 0)
    const rows = ((st as { item_code: string; description: string | null; batch_no: string | null; location_code: string; quantity: number }[]) || [])
      .filter(s => want.has(`${s.item_code}|${s.batch_no || ''}`))
      .sort((a, b) => a.item_code.localeCompare(b.item_code) || (a.batch_no || '').localeCompare(b.batch_no || '') || a.location_code.localeCompare(b.location_code))
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS SDN BHD', 14, 15)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.text('PUT-AWAY REPORT', 14, 22)
    doc.setFontSize(10)
    doc.text(`PO: ${po.po_number || '-'}`, 14, 30)
    doc.text(`Supplier: ${po.supplier_name || '-'}`, 14, 36)
    if (po.sql_grn_no) doc.text(`SQL GRN: ${po.sql_grn_no}`, 140, 30)
    doc.text(`Printed: ${new Date().toLocaleString('en-GB')}`, 140, 36)
    autoTable(doc, {
      startY: 42,
      head: [['Item', 'Description', 'Batch', 'Bin', 'Qty']],
      body: rows.map(s => [s.item_code, s.description || '', s.batch_no || '', s.location_code === 'GOODS-IN' ? 'GOODS-IN (not put away)' : s.location_code, fmtQty(s.quantity)]),
      styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: [4, 120, 87] }, columnStyles: { 4: { halign: 'right' } },
    })
    doc.save(`Putaway_${(po.po_number || 'po').replace(/[\/\s]/g, '-')}.pdf`)
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !profile) return
    if (file.type !== 'application/pdf') { setErr('Please choose a PDF file.'); return }
    setUploading(true); setErr(''); setMsg('')
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `po/${Date.now()}-${safe}`
    const up = await supabase.storage.from('wms-grn').upload(path, file)
    if (up.error) { setErr(`Upload failed: ${up.error.message}`); setUploading(false); return }
    const { data: inserted, error: insErr } = await supabase.from('wms_purchase_orders')
      .insert({ file_name: file.name, file_path: path, status: 'Processing', source: 'pdf', created_by: profile.id, created_by_name: profile.full_name })
      .select().single()
    if (insErr || !inserted) { setErr(`Saving record failed: ${insErr?.message}`); setUploading(false); return }
    setMsg(`Uploaded "${file.name}". Reading it with Claude…`); setFile(null); if (fileRef.current) fileRef.current.value = ''
    setUploading(false); load()
    try {
      const res = await apiFetch('/api/wms/extract-po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poId: inserted.id, filePath: path }) })
      const r = await res.json()
      if (!res.ok) { setErr(`Reading failed: ${r.error || 'Unknown error'}`); setMsg('') }
      else { setMsg(`Read ${r.count} line(s). Please review.`); load(); viewLines(inserted as PO) }
    } catch { setErr('Could not reach the reading service.'); setMsg('') }
  }

  async function reRead(o: PO) {
    if (!o.file_path) return
    await supabase.from('wms_purchase_orders').update({ status: 'Processing' }).eq('id', o.id); load()
    try {
      const res = await apiFetch('/api/wms/extract-po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poId: o.id, filePath: o.file_path }) })
      const r = await res.json(); if (!res.ok) setErr(`Reading failed: ${r.error || 'Unknown error'}`); else setMsg(`Re-read ${r.count} line(s).`); load()
    } catch { setErr('Could not reach the reading service.') }
  }

  // Replace this PO's PDF with an amended one, then re-read it. Re-reading rebuilds the order
  // lines from scratch, so it's only safe BEFORE any goods have been received against the PO —
  // once receiving has started, changing the lines would drop the received progress. In that
  // case correct the received stock via a flag / stock correction instead.
  function startReplace(o: PO) {
    if (!canEdit) return
    if ((recvByPo[o.id]?.length ?? 0) > 0) {
      setErr('Goods have already been received on this PO, so its lines can’t be rebuilt from a new PDF (that would wipe the received progress). Fix the received stock with a flag / stock correction instead.')
      return
    }
    setErr(''); setReplacePo(o)
    setTimeout(() => replaceRef.current?.click(), 0)
  }

  async function onReplaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; const o = replacePo
    if (replaceRef.current) replaceRef.current.value = ''
    setReplacePo(null)
    if (!f || !o) return
    if (f.type !== 'application/pdf') { setErr('Please choose a PDF file.'); return }
    if ((recvByPo[o.id]?.length ?? 0) > 0) { setErr('Goods have already been received on this PO — can’t replace its PDF now.'); return }
    setErr(''); setMsg(`Uploading amended PDF for ${o.po_number || o.file_name}…`)
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `po/${Date.now()}-${safe}`
    const up = await supabase.storage.from('wms-grn').upload(path, f)
    if (up.error) { setErr(`Upload failed: ${up.error.message}`); setMsg(''); return }
    const { error: uErr } = await supabase.from('wms_purchase_orders').update({ file_name: f.name, file_path: path, source: 'pdf', status: 'Processing' }).eq('id', o.id)
    if (uErr) { setErr(`Saving record failed: ${uErr.message}`); setMsg(''); return }
    load()
    try {
      const res = await apiFetch('/api/wms/extract-po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poId: o.id, filePath: path }) })
      const r = await res.json()
      if (!res.ok) { setErr(`Reading failed: ${r.error || 'Unknown error'}`); setMsg('') }
      else { setMsg(`Replaced the PDF and re-read ${r.count} line(s). Please review.`); load(); viewLines({ ...o, file_path: path, file_name: f.name } as PO) }
    } catch { setErr('Could not reach the reading service.'); setMsg('') }
  }

  async function saveManual(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    const good = mLines.filter(l => l.item_code.trim() && Number(l.quantity) > 0)
    if (!mSupplier.trim()) { setErr('Enter the supplier.'); return }
    if (!good.length) { setErr('Add at least one item line with a quantity.'); return }
    setSaving(true); setErr(''); setMsg('')
    const { data: po, error: e1 } = await supabase.from('wms_purchase_orders')
      .insert({ source: 'manual', status: 'Open', po_number: mPo.trim() || null, supplier_name: mSupplier.trim(), expected_date: mExpected.trim() || null, created_by: profile.id, created_by_name: profile.full_name })
      .select().single()
    if (e1 || !po) { setErr(`Saving failed: ${e1?.message}`); setSaving(false); return }
    const itemByCode = new Map(items.map(i => [i.code.toUpperCase(), i]))
    const rows = good.map((l, i) => {
      const it = itemByCode.get(l.item_code.trim().toUpperCase())
      return { po_id: po.id, line_no: i + 1, item_code: l.item_code.trim(), description: l.description.trim() || it?.description || null, quantity: Number(l.quantity), uom: l.uom.trim() || it?.unit || null }
    })
    const { error: e2 } = await supabase.from('wms_po_lines').insert(rows)
    setSaving(false)
    if (e2) { setErr(`Saving lines failed: ${e2.message}`); return }
    setMsg(`Purchase order for ${mSupplier} saved with ${rows.length} line(s).`)
    setShowManual(false); setMSupplier(''); setMPo(''); setMExpected(''); setMLines([{ item_code: '', description: '', quantity: '', uom: '' }]); load()
  }

  async function viewLines(o: PO) {
    setLinesFor(o); setPoEdit(null)
    const { data } = await supabase.from('wms_po_lines').select('*').eq('po_id', o.id).order('line_no')
    const ls = (data as POLine[]) || []
    setLines(ls)
    const { data: cr } = await supabase.from('wms_correction_requests').select('po_line_id').eq('kind', 'po_line').eq('status', 'Pending').in('po_line_id', ls.map(l => l.id))
    setPoEditPending(new Set(((cr as { po_line_id: string }[]) || []).map(x => x.po_line_id)))
  }
  // Request an edit to a wrongly-created PO line (Head Office approves before it applies).
  async function submitLineEdit() {
    const e = poEdit; if (!e) return
    const { error } = await supabase.rpc('request_po_line_edit', {
      p_line_id: e.lineId, p_new_item_code: e.item_code.trim(), p_new_description: e.description.trim() || null,
      p_new_qty: e.quantity === '' ? null : Number(e.quantity), p_new_uom: e.uom.trim() || null, p_reason: e.reason.trim() || null,
    })
    if (error) { setErr(/request_po_line_edit|wms_correction_requests/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-corrections.sql in the Supabase SQL editor.' : error.message); return }
    setPoEditPending(s => new Set(s).add(e.lineId)); setPoEdit(null)
    setMsg('Line change requested — waiting for Head Office approval.')
  }
  async function viewPdf(o: PO) {
    if (!o.file_path) return
    const { data } = await supabase.storage.from('wms-grn').createSignedUrl(o.file_path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  async function del(o: PO) {
    if (!confirm(`Delete PO "${o.po_number || o.file_name}" and its lines?`)) return
    if (o.file_path) await supabase.storage.from('wms-grn').remove([o.file_path])
    await supabase.from('wms_purchase_orders').delete().eq('id', o.id)
    if (linesFor?.id === o.id) setLinesFor(null); load()
  }

  const setLine = (i: number, patch: Partial<DraftLine>) => setMLines(ls => ls.map((l, x) => x === i ? { ...l, ...patch } : l))

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  const nq = q.trim().toLowerCase()
  const shownPos = (statusFilter ? pos.filter(o => o.status === statusFilter) : pos)
    .filter(o => passWh(wh, descsByPo[o.id]))
    .filter(o => !nq || `${o.po_number || ''} ${o.supplier_name || ''} ${o.sql_grn_no || ''}`.toLowerCase().includes(nq) || (itemText[o.id] || '').includes(nq))

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Purchase Orders</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">What you’re expecting from suppliers. Upload the PO PDF (read by AI) or add one by hand, then receive goods against it. (Later these can arrive straight from SQL Account.)</p>

        {canEdit && (
          <div className="bg-white rounded-xl shadow-sm border p-5 mb-6">
            <form onSubmit={handleUpload} className="flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] || null)}
                className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-700 file:text-white file:px-4 file:py-2 file:font-medium" />
              <button type="submit" disabled={!file || uploading} className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{uploading ? 'Uploading…' : 'Upload PO PDF'}</button>
              <span className="text-gray-300">or</span>
              <button type="button" onClick={() => { setShowManual(v => !v); setErr('') }} className="border px-4 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium">{showManual ? 'Close manual entry' : 'Add by hand'}</button>
            </form>

            {showManual && (
              <form onSubmit={saveManual} className="mt-4 border-t pt-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div><label className="block text-xs text-gray-500 mb-1">Supplier</label><input list="wms-suppliers" value={mSupplier} onChange={e => setMSupplier(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" required /><datalist id="wms-suppliers">{suppliers.map(s => <option key={s.name} value={s.name}>{`${s.name} (${s.code})`}</option>)}</datalist></div>
                  <div><label className="block text-xs text-gray-500 mb-1">PO number <span className="text-gray-400">(optional)</span></label><input value={mPo} onChange={e => setMPo(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">Expected date <span className="text-gray-400">(optional)</span></label><input value={mExpected} onChange={e => setMExpected(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="e.g. 20/7/2026" /></div>
                </div>
                <div className="space-y-2">
                  {mLines.map((l, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-6"><ItemPicker items={items} value={l.item_code ? `${l.item_code} — ${l.description}` : ''} onPick={it => setLine(i, { item_code: it.code, description: it.description, uom: it.unit })} /></div>
                      <div className="col-span-3"><input value={l.quantity} onChange={e => setLine(i, { quantity: e.target.value.replace(/[^0-9.]/g, '') })} className="w-full border rounded-lg px-3 py-2 text-sm text-right" placeholder="Qty" inputMode="decimal" /></div>
                      <div className="col-span-2"><input value={l.uom} onChange={e => setLine(i, { uom: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Unit" /></div>
                      <div className="col-span-1">{mLines.length > 1 && <button type="button" onClick={() => setMLines(ls => ls.filter((_, x) => x !== i))} className="text-red-500 text-lg leading-none">×</button>}</div>
                    </div>
                  ))}
                  <button type="button" onClick={() => setMLines(ls => [...ls, { item_code: '', description: '', quantity: '', uom: '' }])} className="text-emerald-700 text-sm hover:underline">+ Add line</button>
                </div>
                <button type="submit" disabled={saving} className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : 'Save purchase order'}</button>
              </form>
            )}
          </div>
        )}

        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">{msg}</p>}

        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 PO no., supplier or item…" className="border rounded-lg px-3 py-1.5 flex-1 min-w-[12rem]" />
          <span className="text-gray-500">Status:</span>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-1.5">
            <option value="">All</option>
            {Array.from(new Set(pos.map(o => o.status))).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {statusFilter && <button onClick={() => setStatusFilter('')} className="text-emerald-700 hover:underline text-xs">clear</button>}
          <div className="w-full sm:w-auto sm:ml-auto"><WarehouseTabs value={wh} onChange={setWh} /></div>
        </div>

        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['PO No', 'Supplier', 'Expected', 'Lines', 'Status', 'Put-away', 'SQL GRN', 'Added', 'Actions'].map(h => <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {shownPos.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No purchase orders{statusFilter ? ` with status “${statusFilter}”` : ''}{wh !== 'all' ? ' in this warehouse' : ' yet'}.</td></tr>}
              {shownPos.map(o => (
                <tr key={o.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono">{o.po_number || <span className="text-gray-300">{o.file_name ? '(reading…)' : '—'}</span>}</td>
                  <td className="px-4 py-2.5">{o.supplier_name || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{o.expected_date || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 tabular-nums">{o.wms_po_lines?.[0]?.count ?? 0}</td>
                  <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[o.status] || 'bg-gray-100'}`}>{o.status}</span></td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {/* Tick only when EVERY item is received (PO Fulfilled) AND all of it is put away
                        (nothing left in GOODS-IN). Otherwise it's still Pending. */}
                    {(recvByPo[o.id]?.length ?? 0) === 0 ? <span className="text-gray-300 text-xs">—</span>
                      : (putStatus[o.id] === 'done' && o.status === 'Fulfilled') ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Put away ✓</span>
                      : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700" title={putStatus[o.id] === 'pending' ? 'Received goods still in GOODS-IN' : 'Not all items received yet'}>Pending</span>}
                    {(recvByPo[o.id]?.length ?? 0) > 0 && <button onClick={() => putawayReport(o)} className="ml-2 text-emerald-700 hover:underline text-xs">report</button>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <input value={grnEdits[o.id] ?? o.sql_grn_no ?? ''} disabled={!canEdit} onChange={e => setGrnEdits(m => ({ ...m, [o.id]: e.target.value }))}
                        placeholder="GRN #" className="border rounded px-2 py-1 text-xs w-24 disabled:bg-gray-100" />
                      {canEdit && (grnEdits[o.id] ?? o.sql_grn_no ?? '') !== (o.sql_grn_no ?? '') &&
                        <button onClick={() => saveSqlGrn(o)} className="bg-emerald-600 text-white px-2 py-1 rounded text-xs hover:bg-emerald-700">Save</button>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(o.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex gap-3 text-xs">
                      {['Open', 'Partially Received', 'Fulfilled'].includes(o.status) && <Link href={`/wms/receive/${o.id}`} className="text-emerald-700 font-medium hover:underline">Receive →</Link>}
                      <button onClick={() => viewLines(o)} className="text-emerald-700 hover:underline">View lines</button>
                      <button onClick={() => openWmsDiscussion(`PO ${o.po_number || o.file_name || o.id.slice(0, 8)}`)} title="Ask a question about this PO" className="text-indigo-600 hover:underline">💬 Discuss</button>
                      {o.file_path && <button onClick={() => viewPdf(o)} className="text-gray-500 hover:underline">PDF</button>}
                      {canEdit && o.file_path && <button onClick={() => reRead(o)} className="text-gray-500 hover:underline">Re-read</button>}
                      {canEdit && (recvByPo[o.id]?.length ?? 0) === 0 && <button onClick={() => startReplace(o)} title="Upload an amended PDF and re-read the lines" className="text-gray-500 hover:underline">Replace PDF</button>}
                      {canEdit && <button onClick={() => del(o)} className="text-red-500 hover:underline">Delete</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per purchase order */}
        <div className="sm:hidden space-y-2">
          {shownPos.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No purchase orders{statusFilter ? ` with status “${statusFilter}”` : ''}{wh !== 'all' ? ' in this warehouse' : ' yet'}.</div>}
          {shownPos.map(o => (
            <div key={o.id} className="bg-white rounded-xl border shadow-sm p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-semibold text-sm">{o.po_number || <span className="text-gray-300">{o.file_name ? '(reading…)' : '—'}</span>}</div>
                  <div className="text-xs text-gray-500 leading-snug">{o.supplier_name || '—'}</div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${STATUS_CHIP[o.status] || 'bg-gray-100'}`}>{o.status}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
                <span>Lines: <span className="tabular-nums">{o.wms_po_lines?.[0]?.count ?? 0}</span></span>
                {o.expected_date && <span>Expected: {o.expected_date}</span>}
                <span>Added: {fmtTime(o.created_at)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs">
                <span className="text-gray-600">Put-away:{' '}
                  {(recvByPo[o.id]?.length ?? 0) === 0 ? <span className="text-gray-300">—</span>
                    : (putStatus[o.id] === 'done' && o.status === 'Fulfilled') ? <span className="px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700">Put away ✓</span>
                    : <span className="px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700" title={putStatus[o.id] === 'pending' ? 'Received goods still in GOODS-IN' : 'Not all items received yet'}>Pending</span>}
                </span>
                {(recvByPo[o.id]?.length ?? 0) > 0 && <button onClick={() => putawayReport(o)} className="text-emerald-700 hover:underline">report</button>}
              </div>
              <div className="flex items-center gap-1 mt-2">
                <span className="text-xs text-gray-500">SQL GRN:</span>
                <input value={grnEdits[o.id] ?? o.sql_grn_no ?? ''} disabled={!canEdit} onChange={e => setGrnEdits(m => ({ ...m, [o.id]: e.target.value }))}
                  placeholder="GRN #" className="border rounded px-2 py-1 text-xs w-24 disabled:bg-gray-100" />
                {canEdit && (grnEdits[o.id] ?? o.sql_grn_no ?? '') !== (o.sql_grn_no ?? '') &&
                  <button onClick={() => saveSqlGrn(o)} className="bg-emerald-600 text-white px-2 py-1 rounded text-xs hover:bg-emerald-700">Save</button>}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5 pt-2 border-t text-xs">
                {['Open', 'Partially Received', 'Fulfilled'].includes(o.status) && <Link href={`/wms/receive/${o.id}`} className="text-emerald-700 font-medium hover:underline">Receive →</Link>}
                <button onClick={() => viewLines(o)} className="text-emerald-700 hover:underline font-medium">View lines</button>
                <button onClick={() => openWmsDiscussion(`PO ${o.po_number || o.file_name || o.id.slice(0, 8)}`)} title="Ask a question about this PO" className="text-indigo-600 hover:underline font-medium">💬 Discuss</button>
                {o.file_path && <button onClick={() => viewPdf(o)} className="text-gray-500 hover:underline font-medium">PDF</button>}
                {canEdit && o.file_path && <button onClick={() => reRead(o)} className="text-gray-500 hover:underline font-medium">Re-read</button>}
                {canEdit && (recvByPo[o.id]?.length ?? 0) === 0 && <button onClick={() => startReplace(o)} title="Upload an amended PDF and re-read the lines" className="text-gray-500 hover:underline font-medium">Replace PDF</button>}
                {canEdit && <button onClick={() => del(o)} className="text-red-500 hover:underline font-medium">Delete</button>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <input ref={replaceRef} type="file" accept="application/pdf" onChange={onReplaceFile} className="hidden" />

      {linesFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLinesFor(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1"><h2 className="font-semibold text-lg">{linesFor.po_number || linesFor.file_name} <span className="text-gray-400 font-normal text-sm">· {linesFor.supplier_name || 'supplier ?'}</span></h2><button onClick={() => setLinesFor(null)} className="text-gray-400 hover:text-gray-600">✕</button></div>
            <div className="overflow-x-auto border rounded-lg mt-3">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b"><tr>{['#', 'Item', 'Description', 'Ordered', 'Received', 'Unit', ''].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600">{h}</th>)}</tr></thead>
                <tbody>
                  {lines.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-gray-400">No lines.</td></tr>}
                  {lines.map(l => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-gray-400">{l.line_no}</td>
                      <td className="px-3 py-2 font-mono font-medium">{l.item_code}{!l.item_id && <span className="ml-1 text-amber-600" title="Not in Items master">⚠</span>}</td>
                      <td className="px-3 py-2 text-gray-600 max-w-[220px] truncate">{l.description}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtQty(l.quantity)}</td>
                      <td className="px-3 py-2 tabular-nums text-emerald-700">{fmtQty(l.qty_received)}</td>
                      <td className="px-3 py-2 text-gray-500">{l.uom}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">
                        {Number(l.qty_received) > 0 ? <span className="text-gray-300" title="Already received — correct the stock on the Stock page">received</span>
                          : poEditPending.has(l.id) ? <span className="text-amber-600">⏳ pending</span>
                          : canEdit ? <button onClick={() => setPoEdit({ lineId: l.id, item_code: l.item_code, description: l.description || '', quantity: String(clean(l.quantity)), uom: l.uom || '', reason: '' })} className="text-indigo-600 hover:underline">Request edit</button>
                          : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {poEdit && (
              <div className="mt-4 border rounded-lg p-4 bg-indigo-50/40">
                <h3 className="font-semibold text-sm mb-2">Request line change <span className="text-gray-400 font-normal">(Head Office approves)</span></h3>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                  <div className="sm:col-span-6"><label className="block text-xs text-gray-500 mb-1">Correct item</label>
                    <ItemPicker items={items} value={poEdit.item_code ? `${poEdit.item_code} — ${poEdit.description}` : ''} onPick={it => setPoEdit(e => e && { ...e, item_code: it.code, description: it.description, uom: it.unit })} /></div>
                  <div className="sm:col-span-3"><label className="block text-xs text-gray-500 mb-1">Qty</label><input value={poEdit.quantity} onChange={e => setPoEdit(p => p && { ...p, quantity: e.target.value.replace(/[^0-9.]/g, '') })} className="w-full border rounded-lg px-3 py-2 text-sm text-right" inputMode="decimal" /></div>
                  <div className="sm:col-span-3"><label className="block text-xs text-gray-500 mb-1">Unit</label><input value={poEdit.uom} onChange={e => setPoEdit(p => p && { ...p, uom: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                  <div className="sm:col-span-12"><label className="block text-xs text-gray-500 mb-1">Reason <span className="text-gray-400">(optional)</span></label><input value={poEdit.reason} onChange={e => setPoEdit(p => p && { ...p, reason: e.target.value })} placeholder="e.g. entered KG code, received 10KG pack" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={submitLineEdit} disabled={!poEdit.item_code.trim()} className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">Send request</button>
                  <button onClick={() => setPoEdit(null)} className="border px-4 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
