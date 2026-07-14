'use client'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface PO {
  id: string; po_number: string | null; supplier_name: string | null; order_date: string | null; expected_date: string | null
  file_name: string | null; file_path: string | null; status: string; source: string
  error_message: string | null; created_at: string
  wms_po_lines?: { count: number }[]
}
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

  const [linesFor, setLinesFor] = useState<PO | null>(null)
  const [lines, setLines] = useState<POLine[]>([])

  // manual entry
  const [showManual, setShowManual] = useState(false)
  const [mSupplier, setMSupplier] = useState(''); const [mPo, setMPo] = useState(''); const [mExpected, setMExpected] = useState('')
  const [mLines, setMLines] = useState<DraftLine[]>([{ item_code: '', description: '', quantity: '', uom: '' }])
  const [saving, setSaving] = useState(false)

  const [statusFilter, setStatusFilter] = useState('')
  useEffect(() => { const s = new URLSearchParams(window.location.search).get('status'); if (s) setStatusFilter(s) }, [])
  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const { data } = await supabase.from('wms_purchase_orders').select('*, wms_po_lines(count)').order('created_at', { ascending: false }).limit(100)
    setPos((data as PO[]) || [])
    const { data: sup } = await supabase.from('wms_suppliers').select('name, code').eq('active', true).order('name')
    setSuppliers((sup as { name: string; code: string }[]) || [])
    if (!items.length) setItems(await fetchAll<Item>('items', 'code, description, unit', 'code'))
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
    setLinesFor(o)
    const { data } = await supabase.from('wms_po_lines').select('*').eq('po_id', o.id).order('line_no')
    setLines((data as POLine[]) || [])
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

        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-gray-500">Status:</span>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-1.5">
            <option value="">All</option>
            {Array.from(new Set(pos.map(o => o.status))).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {statusFilter && <button onClick={() => setStatusFilter('')} className="text-emerald-700 hover:underline text-xs">clear</button>}
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['PO No', 'Supplier', 'Expected', 'Lines', 'Status', 'Added', 'Actions'].map(h => <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {(statusFilter ? pos.filter(o => o.status === statusFilter) : pos).length === 0 && <tr><td colSpan={7} className="text-center py-10 text-gray-400">No purchase orders{statusFilter ? ` with status “${statusFilter}”` : ' yet'}.</td></tr>}
              {(statusFilter ? pos.filter(o => o.status === statusFilter) : pos).map(o => (
                <tr key={o.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono">{o.po_number || <span className="text-gray-300">{o.file_name ? '(reading…)' : '—'}</span>}</td>
                  <td className="px-4 py-2.5">{o.supplier_name || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{o.expected_date || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 tabular-nums">{o.wms_po_lines?.[0]?.count ?? 0}</td>
                  <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[o.status] || 'bg-gray-100'}`}>{o.status}</span></td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(o.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex gap-3 text-xs">
                      {['Open', 'Partially Received', 'Fulfilled'].includes(o.status) && <Link href={`/wms/receive/${o.id}`} className="text-emerald-700 font-medium hover:underline">Receive →</Link>}
                      <button onClick={() => viewLines(o)} className="text-emerald-700 hover:underline">View lines</button>
                      {o.file_path && <button onClick={() => viewPdf(o)} className="text-gray-500 hover:underline">PDF</button>}
                      {canEdit && o.file_path && <button onClick={() => reRead(o)} className="text-gray-500 hover:underline">Re-read</button>}
                      {canEdit && <button onClick={() => del(o)} className="text-red-500 hover:underline">Delete</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {linesFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLinesFor(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1"><h2 className="font-semibold text-lg">{linesFor.po_number || linesFor.file_name} <span className="text-gray-400 font-normal text-sm">· {linesFor.supplier_name || 'supplier ?'}</span></h2><button onClick={() => setLinesFor(null)} className="text-gray-400 hover:text-gray-600">✕</button></div>
            <div className="overflow-x-auto border rounded-lg mt-3">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b"><tr>{['#', 'Item', 'Description', 'Ordered', 'Received', 'Unit'].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600">{h}</th>)}</tr></thead>
                <tbody>
                  {lines.length === 0 && <tr><td colSpan={6} className="text-center py-6 text-gray-400">No lines.</td></tr>}
                  {lines.map(l => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-gray-400">{l.line_no}</td>
                      <td className="px-3 py-2 font-mono font-medium">{l.item_code}{!l.item_id && <span className="ml-1 text-amber-600" title="Not in Items master">⚠</span>}</td>
                      <td className="px-3 py-2 text-gray-600 max-w-[220px] truncate">{l.description}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtQty(l.quantity)}</td>
                      <td className="px-3 py-2 tabular-nums text-emerald-700">{fmtQty(l.qty_received)}</td>
                      <td className="px-3 py-2 text-gray-500">{l.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
