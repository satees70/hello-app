'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import { encodeItem } from '@/lib/qr'
import { LABEL_SIZES, downloadLabels } from '@/lib/wmsLabel'

interface PO { id: string; po_number: string | null; supplier_name: string | null; status: string; expected_date: string | null }
interface Line { id: string; line_no: number | null; item_id: string | null; item_code: string; description: string | null; quantity: number; qty_received: number; uom: string | null }
// Photos are uploaded the moment they're taken and only the storage PATH is kept, so a draft
// survives leaving the page (paths are saved to localStorage; previews are re-signed on return).
interface Draft { qty: string; batch: string; exp: string; qc: 'pass' | 'fail'; note: string; photoPath: string; preview: string; bagPath: string; bagPreview: string; weightPath: string; weightPreview: string }
// Fields we persist to localStorage (everything except the transient preview URLs).
type SavedDraft = Pick<Draft, 'qty' | 'batch' | 'exp' | 'qc' | 'note' | 'photoPath' | 'bagPath' | 'weightPath'>
const draftKey = (poId: string) => `wmsRecvDraft:${poId}`

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const STATUS_CHIP: Record<string, string> = { Open: 'bg-amber-100 text-amber-700', 'Partially Received': 'bg-emerald-100 text-emerald-700', Fulfilled: 'bg-emerald-100 text-emerald-700' }
// Today's date as YYMMDD (Malaysia), the usual batch-number convention.
function todayYYMMDD(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: '2-digit', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const g = (t: string) => p.find(x => x.type === t)?.value || ''
  return `${g('year')}${g('month')}${g('day')}`
}
const TODAY = todayYYMMDD()
const pad2 = (n: number) => String(n).padStart(2, '0')

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
  // A manager (Head Office / admin) can receive an old paper delivery without photos, with no
  // bypass request. Regular staff still need the three photos or an approved bypass.
  const isManager = !!profile && (profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')

  const [po, setPo] = useState<PO | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [runNo, setRunNo] = useState('01')   // today's running batch number (YYMMDD/NN)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [grnId, setGrnId] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [labelSize, setLabelSize] = useState('55x35')
  const [bypassApproved, setBypassApproved] = useState<Set<string>>(new Set())   // po_line ids with an approved unconsumed photo bypass
  const [bypassPending, setBypassPending] = useState<Set<string>>(new Set())
  const [photoBusy, setPhotoBusy] = useState('')   // `${lineId}-${kind}` currently uploading
  const restoredRef = useRef(false)

  // One label per package: copies default to the qty (received qty if typed, else
  // the outstanding/ordered qty), so staff don't key a count. Capped at 500.
  const labelCopies = (l: Line) => Math.max(1, Math.min(500, Math.round(Number(draftOf(l).qty) || outstanding(l) || 1)))

  async function printLabel(l: Line) {
    const d = draftOf(l)
    const n = labelCopies(l)
    if (n > 100 && !confirm(`Print ${n} labels for ${l.item_code}?`)) return
    const name = l.description ? (l.description.length > 24 ? l.description.slice(0, 23) + '…' : l.description) : ''
    const expLine = d.exp ? `Exp ${new Date(d.exp + 'T00:00:00').toLocaleDateString('en-GB')}` : ''
    const width = String(n).length
    const items = Array.from({ length: n }, (_, i) => {
      const seq = String(i + 1).padStart(width, '0')
      const subs = [name, `Batch ${d.batch || '—'}  #${seq}`, expLine].filter(Boolean)
      return { qrText: encodeItem(l.item_code, d.batch, d.exp, seq), title: l.item_code, subs }
    })
    await downloadLabels(items, labelSize, `BatchLabels_${l.item_code.replace(/[^a-zA-Z0-9]/g, '-')}_x${n}.pdf`)
  }

  const load = useCallback(async () => {
    const { data: o } = await supabase.from('wms_purchase_orders').select('id, po_number, supplier_name, status, expected_date').eq('id', id).single()
    const { data: ls } = await supabase.from('wms_po_lines').select('*').eq('po_id', id).order('line_no')
    // Next running number for today = 1 + the highest NN already used in a YYMMDD/NN batch today.
    const { data: todayB } = await supabase.from('wms_grn_lines').select('batch_no').like('batch_no', `${TODAY}/%`)
    let mx = 0
    for (const r of (todayB as { batch_no: string }[] || [])) { const m = /\/(\d+)\s*$/.exec(r.batch_no || ''); if (m) mx = Math.max(mx, parseInt(m[1], 10)) }
    setPo((o as PO) || null); setLines((ls as Line[]) || []); setRunNo(pad2(mx + 1))
    const { data: bp } = await supabase.from('grn_bypass_requests').select('po_line_id, status, consumed_at').eq('po_id', id)
    const appr = new Set<string>(); const pend = new Set<string>()
    ;(bp as { po_line_id: string; status: string; consumed_at: string | null }[] || []).forEach(b => {
      if (b.status === 'Approved' && !b.consumed_at) appr.add(b.po_line_id)
      else if (b.status === 'Pending') pend.add(b.po_line_id)
    })
    setBypassApproved(appr); setBypassPending(pend)
  }, [id])
  useEffect(() => { if (profile) load() }, [profile, load])

  const outstanding = (l: Line) => clean(l.quantity - l.qty_received)
  // Batch defaults to today's date + a short supplier code, so the SAME item from two
  // suppliers on the same day gets distinct batches (e.g. 260714ABC vs 260714XYZ). Editable.
  // All lines in this receiving session default to today's YYMMDD/NN, so each delivery
  // gets a distinct batch (a 2nd delivery of the same item today becomes /NN+1).
  const defaultBatch = useMemo(() => `${TODAY}/${runNo}`, [runNo])
  const newDraft = useCallback((): Draft => ({ qty: '', batch: defaultBatch, exp: '', qc: 'pass', note: '', photoPath: '', preview: '', bagPath: '', bagPreview: '', weightPath: '', weightPreview: '' }), [defaultBatch])
  const draftOf = (l: Line) => drafts[l.id] ?? newDraft()
  const setDraft = (lineId: string, patch: Partial<Draft>) => setDrafts(d => ({ ...d, [lineId]: { ...(d[lineId] ?? newDraft()), ...patch } }))

  // Restore any half-finished drafts (with their already-uploaded photos) for this PO, so leaving
  // and coming back doesn't lose the pictures. Runs once per PO; re-signs previews for display.
  useEffect(() => {
    if (!id) return
    try {
      const raw = localStorage.getItem(draftKey(id))
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, SavedDraft>
        setDrafts(prev => {
          const next = { ...prev }
          for (const [lid, s] of Object.entries(saved)) next[lid] = { qty: s.qty || '', batch: s.batch || '', exp: s.exp || '', qc: s.qc || 'pass', note: s.note || '', photoPath: s.photoPath || '', preview: '', bagPath: s.bagPath || '', bagPreview: '', weightPath: s.weightPath || '', weightPreview: '' }
          return next
        })
        const want: { lid: string; key: 'preview' | 'bagPreview' | 'weightPreview'; path: string }[] = []
        for (const [lid, s] of Object.entries(saved)) {
          if (s.photoPath) want.push({ lid, key: 'preview', path: s.photoPath })
          if (s.bagPath) want.push({ lid, key: 'bagPreview', path: s.bagPath })
          if (s.weightPath) want.push({ lid, key: 'weightPreview', path: s.weightPath })
        }
        Promise.all(want.map(async w => ({ ...w, url: (await supabase.storage.from('wms-grn').createSignedUrl(w.path, 3600)).data?.signedUrl || '' })))
          .then(res => setDrafts(prev => { const next = { ...prev }; for (const r of res) if (r.url && next[r.lid]) next[r.lid] = { ...next[r.lid], [r.key]: r.url }; return next }))
      }
    } catch { /* ignore bad cache */ }
    restoredRef.current = true
  }, [id])

  // Save drafts (paths + typed fields, not the transient previews) so they survive navigation.
  useEffect(() => {
    if (!id || !restoredRef.current) return
    try {
      const saved: Record<string, SavedDraft> = {}
      for (const [lid, d] of Object.entries(drafts)) {
        if (d.qty || d.photoPath || d.bagPath || d.weightPath || d.note || d.exp || (d.batch && d.batch !== defaultBatch))
          saved[lid] = { qty: d.qty, batch: d.batch, exp: d.exp, qc: d.qc, note: d.note, photoPath: d.photoPath, bagPath: d.bagPath, weightPath: d.weightPath }
      }
      if (Object.keys(saved).length) localStorage.setItem(draftKey(id), JSON.stringify(saved))
      else localStorage.removeItem(draftKey(id))
    } catch { /* ignore quota */ }
  }, [drafts, id, defaultBatch])

  // Upload a photo the moment it's taken (to a stable per-line path, overwriting a retake), so it's
  // safe even if the tab is closed before Receive. Only the path is kept in the draft.
  async function uploadPhoto(l: Line, kind: 'product' | 'bag' | 'weight', file: File) {
    setErr(''); setPhotoBusy(`${l.id}-${kind}`)
    try {
      const blob = await compressImage(file)
      const path = `photos/draft/${id}/${l.id}-${kind}.jpg`
      const up = await supabase.storage.from('wms-grn').upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
      if (up.error) throw up.error
      const preview = URL.createObjectURL(blob)
      if (kind === 'product') setDraft(l.id, { photoPath: path, preview })
      else if (kind === 'bag') setDraft(l.id, { bagPath: path, bagPreview: preview })
      else setDraft(l.id, { weightPath: path, weightPreview: preview })
    } catch (e) { setErr(`Photo upload failed: ${e instanceof Error ? e.message : String(e)}. Please try again.`) }
    setPhotoBusy('')
  }
  const onPhoto = (l: Line, file: File) => uploadPhoto(l, 'product', file)
  const onBagPhoto = (l: Line, file: File) => uploadPhoto(l, 'bag', file)
  const onWeightPhoto = (l: Line, file: File) => uploadPhoto(l, 'weight', file)

  async function ensureGrn(): Promise<string | null> {
    if (grnId) return grnId
    const { data, error } = await supabase.rpc('wms_start_grn', { p_po_id: id })
    if (error) { setErr(error.message); return null }
    setGrnId(data as string); return data as string
  }

  async function receive(l: Line) {
    if (!canEdit) return
    const d = draftOf(l)
    // Qty defaults to the outstanding quantity when the box is left blank (it shows as a placeholder).
    const qty = d.qty.trim() ? Number(d.qty) : outstanding(l)
    if (!(qty > 0)) { setErr('Enter the received quantity.'); return }
    const hasPhotos = !!d.photoPath && !!d.bagPath && !!d.weightPath
    if (!hasPhotos && !bypassApproved.has(l.id) && !isManager) { setErr('Take the product, bag and weight photos — or request a bypass for a manager to approve.'); return }
    if (!hasPhotos && !bypassApproved.has(l.id) && isManager && !window.confirm(`Receive ${l.item_code} without photos (old delivery checked on paper)?`)) return
    setBusy(l.id); setErr(''); setMsg('')
    const gid = await ensureGrn(); if (!gid) { setBusy(''); return }
    // Photos are already uploaded (on capture) — just pass their paths.
    const { error } = await supabase.rpc('wms_receive_line', {
      p_grn_id: gid, p_po_line_id: l.id, p_item_code: l.item_code, p_qty: qty,
      p_batch: d.batch.trim(), p_exp_date: d.exp || null, p_qc: d.qc, p_qc_note: d.note.trim() || null, p_photo_path: d.photoPath || null,
      p_bag_photo_path: d.bagPath || null, p_weight_photo_path: d.weightPath || null,
    })
    setBusy('')
    if (error) { setErr(error.message); return }
    setMsg(`Received ${fmtQty(qty)} of ${l.item_code} into GOODS-IN${d.qc === 'fail' ? ' (QC FAIL noted)' : ''}${!hasPhotos ? (bypassApproved.has(l.id) ? ' (photo bypass used)' : ' (no photo — received on paper)') : ''}.`)
    setDrafts(dd => { const n = { ...dd }; delete n[l.id]; return n }); load()
  }
  // Photo can't be taken → ask a manager to approve receiving this line without photos.
  async function requestBypass(l: Line) {
    if (!canEdit) return
    const reason = window.prompt(`Request to receive ${l.item_code} WITHOUT the photos?\n\nA manager (Head Office) must approve. Reason:`, '')
    if (reason === null) return
    setBusy('bp' + l.id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('request_grn_bypass', { p_po_line_id: l.id, p_reason: reason || null })
    setBusy('')
    if (error) { setErr(/request_grn_bypass|grn_bypass_requests/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-grn-photos-bypass.sql in the Supabase SQL editor.' : error.message); return }
    setBypassPending(s => new Set(s).add(l.id))
    setMsg(`Bypass requested for ${l.item_code} — waiting for manager approval.`)
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
        {canEdit && <div className="text-xs text-gray-500 mb-4 flex items-center gap-2">Batch label size:
          <select value={labelSize} onChange={e => setLabelSize(e.target.value)} className="border rounded-lg px-2 py-1 text-xs">{Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
        </div>}

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
                  <div className="mt-3 border-t pt-3 grid grid-cols-2 sm:grid-cols-8 gap-2 items-end">
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Qty {done ? '(more)' : ''}</label><input value={d.qty} onChange={e => setDraft(l.id, { qty: e.target.value.replace(/[^0-9.]/g, '') })} placeholder={out > 0 ? String(clean(out)) : '0'} className="w-full border rounded-lg px-2 py-1.5 text-sm text-right tabular-nums" inputMode="decimal" /></div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Weight photo *</label>
                      <label className={`block text-center border rounded-lg py-1.5 text-xs cursor-pointer ${d.weightPath ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-amber-300 hover:bg-gray-50'}`}>
                        {photoBusy === `${l.id}-weight` ? '⏳ saving…' : d.weightPath ? '✓ weight' : '⚖ photo'}
                        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onWeightPhoto(l, f); e.target.value = '' }} />
                      </label>
                    </div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Batch</label><input value={d.batch} onChange={e => setDraft(l.id, { batch: e.target.value })} className="w-full border rounded-lg px-2 py-1.5 text-sm font-mono" /></div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">Expiry</label><input type="date" value={d.exp} onChange={e => setDraft(l.id, { exp: e.target.value })} className="w-full border rounded-lg px-2 py-1.5 text-sm" /></div>
                    <div className="col-span-1"><label className="block text-xs text-gray-500 mb-1">QC</label>
                      <div className="flex rounded-lg border overflow-hidden text-xs">
                        <button type="button" onClick={() => setDraft(l.id, { qc: 'pass' })} className={`flex-1 py-1.5 ${d.qc === 'pass' ? 'bg-emerald-600 text-white' : 'text-gray-600'}`}>Pass</button>
                        <button type="button" onClick={() => setDraft(l.id, { qc: 'fail' })} className={`flex-1 py-1.5 ${d.qc === 'fail' ? 'bg-red-600 text-white' : 'text-gray-600'}`}>Fail</button>
                      </div>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs text-gray-500 mb-1">Product photo *</label>
                      <label className={`block text-center border rounded-lg py-1.5 text-xs cursor-pointer ${d.photoPath ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-amber-300 hover:bg-gray-50'}`}>
                        {photoBusy === `${l.id}-product` ? '⏳ saving…' : d.photoPath ? '✓ photo' : '📷 add'}
                        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onPhoto(l, f); e.target.value = '' }} />
                      </label>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-xs text-gray-500 mb-1">Bag photo *</label>
                      <label className={`block text-center border rounded-lg py-1.5 text-xs cursor-pointer ${d.bagPath ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-amber-300 hover:bg-gray-50'}`}>
                        {photoBusy === `${l.id}-bag` ? '⏳ saving…' : d.bagPath ? '✓ bag' : '📷 bag'}
                        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onBagPhoto(l, f); e.target.value = '' }} />
                      </label>
                    </div>
                    <div className="col-span-1">
                      <button onClick={() => receive(l)} disabled={busy === l.id || !!photoBusy || !((d.qty.trim() ? Number(d.qty) : out) > 0) || !((d.photoPath && d.bagPath && d.weightPath) || bypassApproved.has(l.id) || isManager)} className="w-full bg-emerald-700 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{busy === l.id ? '…' : 'Receive'}</button>
                    </div>
                    {d.qc === 'fail' && <div className="col-span-2 sm:col-span-8"><input value={d.note} onChange={e => setDraft(l.id, { note: e.target.value })} placeholder="QC fail reason…" className="w-full border rounded-lg px-2 py-1.5 text-sm" /></div>}
                    <div className="col-span-2 sm:col-span-8 flex items-center gap-3 flex-wrap">
                      {d.preview && <img src={d.preview} alt="product" className="h-14 rounded border" title="Product photo" />}
                      {d.bagPreview && <img src={d.bagPreview} alt="bag" className="h-14 rounded border" title="Bag photo" />}
                      {d.weightPreview && <img src={d.weightPreview} alt="weight" className="h-14 rounded border" title="Weight photo" />}
                      {!(d.photoPath && d.bagPath && d.weightPath) && (
                        bypassApproved.has(l.id) ? <span className="text-[11px] text-emerald-700 font-medium">✓ photo bypass approved — you can receive without photos</span>
                        : bypassPending.has(l.id) ? <span className="text-[11px] text-amber-600">⏳ bypass pending manager approval</span>
                        : isManager ? <span className="text-[11px] text-amber-700">🗒 Photos recommended. As a manager you can still <b>Receive</b> without them (old delivery checked on paper).</span>
                        : <span className="text-[11px] text-amber-600 flex items-center gap-2">Product, bag &amp; weight photos required.
                            <button type="button" onClick={() => requestBypass(l)} disabled={busy === 'bp' + l.id} className="underline text-indigo-600 hover:text-indigo-800">Request bypass (no photo)</button>
                          </span>
                      )}
                      <button type="button" onClick={() => printLabel(l)} className="text-xs text-emerald-700 hover:underline ml-auto">🏷 Print {labelCopies(l)} label{labelCopies(l) > 1 ? 's' : ''}</button>
                    </div>
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
