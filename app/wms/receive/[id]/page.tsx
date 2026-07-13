'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

interface PO { id: string; po_number: string | null; supplier_name: string | null; status: string; expected_date: string | null }
interface Line { id: string; line_no: number | null; item_id: string | null; item_code: string; description: string | null; quantity: number; qty_received: number; uom: string | null }
interface Draft { qty: string; batch: string; exp: string; qc: 'pass' | 'fail'; note: string; photo: Blob | null; preview: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const STATUS_CHIP: Record<string, string> = { Open: 'bg-amber-100 text-amber-700', 'Partially Received': 'bg-blue-100 text-blue-700', Fulfilled: 'bg-emerald-100 text-emerald-700' }
const blank = (): Draft => ({ qty: '', batch: '', exp: '', qc: 'pass', note: '', photo: null, preview: '' })

function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const max = 1280; let { width, height } = img
      if (width > max || height > max) { const s = max / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s) }
      const c = document.createElement('canvas'); c.width = width; c.height = height
      const ctx = c.getContext('2d'); if (!ctx) return reject(new Error('Canvas unavailable'))
      ctx.drawImage(img, 0, 0, width, height)
      c.toBlob(b => b ? resolve(b) : reject(new Error('Compress failed')), 'image/jpeg', 0.6)
    }
    img.onerror = () => reject(new Error('Could not read image')); img.src = url
  })
}

export default function WmsReceivePage() {
  const { id } = useParams<{ id: string }>()
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [po, setPo] = useState<PO | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [grnId, setGrnId] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const { data: o } = await supabase.from('wms_purchase_orders').select('id, po_number, supplier_name, status, expected_date').eq('id', id).single()
    const { data: ls } = await supabase.from('wms_po_lines').select('*').eq('po_id', id).order('line_no')
    setPo((o as PO) || null); setLines((ls as Line[]) || [])
  }, [id])
  useEffect(() => { if (profile) load() }, [profile, load])

  const outstanding = (l: Line) => clean(l.quantity - l.qty_received)
  const draftOf = (l: Line) => drafts[l.id] ?? blank()
  const setDraft = (lineId: string, patch: Partial<Draft>) => setDrafts(d => ({ ...d, [lineId]: { ...(d[lineId] ?? blank()), ...patch } }))

  async function onPhoto(l: Line, file: File) {
    try { const blob = await compressImage(file); setDraft(l.id, { photo: blob, preview: URL.createObjectURL(blob) }) }
    catch { setErr('Could not read that photo.') }
  }

  async function ensureGrn(): Promise<string | null> {
    if (grnId) return grnId
    const { data, error } = await supabase.rpc('wms_start_grn', { p_po_id: id })
    if (error) { setErr(error.message); return null }
    setGrnId(data as string); return data as string
  }

  async function receive(l: Line) {
    if (!canEdit) return
    const d = draftOf(l); const qty = Number(d.qty)
    if (!(qty > 0)) { setErr('Enter the received quantity.'); return }
    if (!d.photo) { setErr('A photo is required to receive a line.'); return }
    setBusy(l.id); setErr(''); setMsg('')
    const gid = await ensureGrn(); if (!gid) { setBusy(''); return }
    const path = `photos/${gid}/${l.id}-${Date.now()}.jpg`
    const up = await supabase.storage.from('wms-grn').upload(path, d.photo, { contentType: 'image/jpeg' })
    if (up.error) { setErr(`Photo upload failed: ${up.error.message}`); setBusy(''); return }
    const { error } = await supabase.rpc('wms_receive_line', {
      p_grn_id: gid, p_po_line_id: l.id, p_item_code: l.item_code, p_qty: qty,
      p_batch: d.batch.trim(), p_exp_date: d.exp || null, p_qc: d.qc, p_qc_note: d.note.trim() || null, p_photo_path: path,
    })
    setBusy('')
    if (error) { setErr(error.message); return }
    setMsg(`Received ${fmtQty(qty)} of ${l.item_code} into GOODS-IN${d.qc === 'fail' ? ' (QC FAIL noted)' : ''}.`)
    setDrafts(dd => { const n = { ...dd }; delete n[l.id]; return n }); load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!po) return <div className="p-8 text-sm text-gray-500">PO not found. <Link href="/wms/purchase-orders" className="text-emerald-700 underline">Back</Link></div>

  const doneCount = lines.filter(l => outstanding(l) <= 0).length

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/wms/purchase-orders" className="text-sm text-emerald-700 hover:underline">← Purchase Orders</Link>
        <div className="flex flex-wrap items-center gap-3 mt-2 mb-1">
          <h1 className="text-2xl font-bold">Receive {po.po_number || '(no number)'}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[po.status] || 'bg-gray-100 text-gray-600'}`}>{po.status}</span>
        </div>
        <p className="text-gray-500 text-sm mb-6">{po.supplier_name || 'Supplier ?'}{po.expected_date ? ` · expected ${po.expected_date}` : ''} · {doneCount}/{lines.length} lines fully received{grnId ? ` · this delivery is being booked` : ''}</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access, so you can’t receive goods.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        <div className="space-y-3">
          {lines.map(l => {
            const out = outstanding(l); const done = out <= 0; const d = draftOf(l)
            return (
              <div key={l.id} className={`bg-white rounded-xl border shadow-sm p-4 ${done ? 'opacity-70' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-mono font-semibold">{l.item_code}{!l.item_id && <span className="ml-1 text-amber-600" title="Not in Items master">⚠</span>}</div>
                    <div className="text-sm text-gray-500 max-w-[440px]">{l.description}</div>
                    <div className="text-xs text-gray-500 mt-1 tabular-nums">Ordered <b>{fmtQty(l.quantity)}</b>{l.uom ? ' ' + l.uom : ''} · Received <b className="text-emerald-700">{fmtQty(l.qty_received)}</b> · Outstanding <b className={out > 0 ? 'text-amber-600' : 'text-gray-400'}>{fmtQty(out)}</b></div>
                  </div>
                  {done && <span className="text-emerald-700 text-sm font-medium">✓ Received</span>}
                </div>

                {canEdit && (
                  <div className="mt-3 border-t pt-3 grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Qty {done ? '(more)' : ''}</label><input value={d.qty} onChange={e => setDraft(l.id, { qty: e.target.value.replace(/[^0-9.]/g, '') })} placeholder={out > 0 ? String(clean(out)) : '0'} className="w-full border rounded-lg px-2 py-1.5 text-sm text-right tabular-nums" inputMode="decimal" /></div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Batch</label><input value={d.batch} onChange={e => setDraft(l.id, { batch: e.target.value })} className="w-full border rounded-lg px-2 py-1.5 text-sm font-mono" /></div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Expiry</label><input type="date" value={d.exp} onChange={e => setDraft(l.id, { exp: e.target.value })} className="w-full border rounded-lg px-2 py-1.5 text-sm" /></div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">QC</label>
                      <div className="flex rounded-lg border overflow-hidden text-xs">
                        <button type="button" onClick={() => setDraft(l.id, { qc: 'pass' })} className={`flex-1 py-1.5 ${d.qc === 'pass' ? 'bg-emerald-600 text-white' : 'text-gray-600'}`}>Pass</button>
                        <button type="button" onClick={() => setDraft(l.id, { qc: 'fail' })} className={`flex-1 py-1.5 ${d.qc === 'fail' ? 'bg-red-600 text-white' : 'text-gray-600'}`}>Fail</button>
                      </div>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs text-gray-500 mb-1">Photo *</label>
                      <label className={`block text-center border rounded-lg py-1.5 text-xs cursor-pointer ${d.photo ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'hover:bg-gray-50'}`}>
                        {d.photo ? '✓ photo' : '📷 add'}
                        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onPhoto(l, f) }} />
                      </label>
                    </div>
                    <div className="col-span-1">
                      <button onClick={() => receive(l)} disabled={busy === l.id || !(Number(d.qty) > 0) || !d.photo} className="w-full bg-emerald-700 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{busy === l.id ? '…' : 'Receive'}</button>
                    </div>
                    {d.qc === 'fail' && <div className="col-span-2 sm:col-span-6"><input value={d.note} onChange={e => setDraft(l.id, { note: e.target.value })} placeholder="QC fail reason…" className="w-full border rounded-lg px-2 py-1.5 text-sm" /></div>}
                    {d.preview && <div className="col-span-2 sm:col-span-6"><img src={d.preview} alt="" className="h-16 rounded border" /></div>}
                  </div>
                )}
              </div>
            )
          })}
          {lines.length === 0 && <div className="bg-white rounded-xl border p-8 text-center text-gray-400 text-sm">This PO has no lines.</div>}
        </div>
        <p className="text-xs text-gray-400 mt-4">Received goods go into the <b>GOODS-IN</b> holding area. Use <Link href="/wms/putaway" className="text-emerald-700 underline">Putaway</Link> to move them onto shelves.</p>
      </div>
    </div>
  )
}
