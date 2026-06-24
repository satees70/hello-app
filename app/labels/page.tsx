'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface MRItem {
  id: string; item_code: string; description: string; unit: string; requested_qty: number; received_qty: number
  label_batch_no?: string | null; label_exp_date?: string | null; label_print_qty?: number | null
  label_photo_path?: string | null; label_sent_at?: string | null; label_received_at?: string | null
  label_for_product?: string | null
  label_printed_by_name?: string | null; label_printed_at?: string | null
}
interface MReq {
  id: string; request_no: string; factory_code: string; released_at: string | null; pick_run_no: string | null
  production_batches: { batch_no: string; item_code: string; description: string; exp_date: string | null } | null
  material_request_items: MRItem[]
}
type Stage = 'requested' | 'material' | 'printed' | 'sent' | 'completed'
const STAGES: { key: Stage; label: string }[] = [
  { key: 'requested', label: 'Requested' },
  { key: 'material', label: 'Material received' },
  { key: 'printed', label: 'Printed' },
  { key: 'sent', label: 'Sent' },
  { key: 'completed', label: 'Completed' },
]
const STAGE_STYLE: Record<Stage, string> = {
  requested: 'bg-gray-100 text-gray-600', material: 'bg-amber-100 text-amber-700',
  printed: 'bg-blue-100 text-blue-700', sent: 'bg-indigo-100 text-indigo-700', completed: 'bg-green-100 text-green-700',
}

export default function LabelsPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'material_requests')
  const [reqs, setReqs] = useState<MReq[]>([])
  const [factoryItems, setFactoryItems] = useState<Set<string>>(new Set())
  const [grnSet, setGrnSet] = useState<Set<string>>(new Set())
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<Stage | 'all'>('all')
  const [edits, setEdits] = useState<Record<string, { batch: string; exp: string; qty: string }>>({})
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // Manual label request
  const [labelItems, setLabelItems] = useState<{ code: string; description: string; unit: string }[]>([])
  const [showManual, setShowManual] = useState(false)
  const [manFac, setManFac] = useState('')
  const [manItem, setManItem] = useState<{ code: string; description: string; unit: string } | null>(null)
  const [manQty, setManQty] = useState('')
  const [manFor, setManFor] = useState('')      // product the label is for
  const [manBatch, setManBatch] = useState('')  // label batch no
  const [manExp, setManExp] = useState('')      // label expiry
  const [manLines, setManLines] = useState<{ code: string; description: string; unit: string; qty: number; forProduct: string; batch: string; exp: string }[]>([])

  const [openMat, setOpenMat] = useState<Set<string>>(new Set())   // label rows showing their material details
  const toggleMat = (id: string) => setOpenMat(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [lotsByItem, setLotsByItem] = useState<Record<string, { batch_no: string; qty: number; exp: string | null }[]>>({})  // request_item_id -> received batches

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEditFac = (fc: string) => can(profile, 'material_requests', 'edit', fc)
  const toggleSel = (id: string) => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const [{ data: r }, { data: fi }, { data: dos }, { data: dls }, { data: f }] = await Promise.all([
      supabase.from('material_requests').select('id, request_no, factory_code, released_at, pick_run_no, production_batches!batch_id(batch_no, item_code, description, exp_date), material_request_items(*)').not('released_at', 'is', null).order('released_at', { ascending: false }),
      supabase.from('items').select('code, description, unit').eq('supplied_by_factory', true).order('code'),
      supabase.from('delivery_orders').select('id, factory_code'),
      supabase.from('delivery_order_lines').select('do_id, item_code'),
      supabase.from('factories').select('code, name').order('code'),
    ])
    setReqs((r as unknown as MReq[]) || [])
    // Received batches per request item — so the printer can see what came in and pick a batch
    const reqItemIds = ((r as unknown as MReq[]) || []).flatMap(req => (req.material_request_items || []).map(it => it.id))
    const lotMap: Record<string, { batch_no: string; qty: number; exp: string | null }[]> = {}
    for (let i = 0; i < reqItemIds.length; i += 200) {
      const { data: lots } = await supabase.from('stock_lots').select('request_item_id, batch_no, qty_received, exp_date').in('request_item_id', reqItemIds.slice(i, i + 200))
      ;(lots || []).forEach(l => { if (!l.request_item_id || !l.batch_no) return; (lotMap[l.request_item_id] = lotMap[l.request_item_id] || []).push({ batch_no: l.batch_no, qty: Number(l.qty_received || 0), exp: l.exp_date }) })
    }
    setLotsByItem(lotMap)
    setFactoryItems(new Set((fi || []).map(x => x.code)))
    setLabelItems((fi as { code: string; description: string; unit: string }[]) || [])
    const fac: Record<string, string> = {}; (dos || []).forEach(d => { fac[d.id] = d.factory_code })
    const s = new Set<string>(); (dls || []).forEach(l => { const ff = fac[l.do_id]; if (!ff || !l.item_code) return; s.add(`${ff}|${l.item_code}`); s.add(`${ff}|${grnBase(l.item_code)}`) })
    setGrnSet(s)
    setFactories(f || [])
  }

  const grnBase = (code: string) => code.replace(/-\d+(?:KG|UN|UNIT|PKT|PACK|G|CTN|BAG|ML|L)\b.*$/i, '')
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const fmtExp = (d: string | null | undefined) => d ? d.split('-').reverse().join('/') : ''
  // GRN uploaded covering this request's raw materials? Then labels can be printed.
  const materialReceived = (r: MReq) => {
    const raw = (r.material_request_items || []).filter(it => !factoryItems.has(it.item_code))
    if (raw.length === 0) return true
    return raw.some(it => grnSet.has(`${r.factory_code}|${it.item_code}`) || grnSet.has(`${r.factory_code}|${grnBase(it.item_code)}`))
  }
  // Photo is optional for now (phone camera issues) — a label is "printed" once its details are saved
  const printed = (it: MRItem) => Number(it.label_print_qty) > 0 && !!(it.label_batch_no || it.label_exp_date)
  const stageOf = (it: MRItem, r: MReq): Stage => {
    if (it.label_received_at) return 'completed'
    if (it.label_sent_at) return 'sent'
    if (printed(it)) return 'printed'
    if (materialReceived(r)) return 'material'
    return 'requested'
  }

  async function saveLabel(it: MRItem, r: MReq) {
    if (!canEditFac(r.factory_code)) { setError('You have view-only access at this factory.'); return }
    if (it.label_printed_at) { setError('Already saved — label details are locked.'); return }
    const e = edits[it.id] ?? { batch: it.label_batch_no ?? '', exp: it.label_exp_date ?? '', qty: '' }
    if (!e.batch.trim() && !e.exp) { setError('Enter a batch number or an expiry date for the label.'); return }
    const qty = Number(it.requested_qty)   // print qty is calculated by the system, not typed
    setBusy(`save|${it.id}`); setError(''); setSuccess('')
    const { error: er } = await supabase.from('material_request_items').update({
      label_batch_no: e.batch.trim() || null, label_exp_date: e.exp || null, label_print_qty: qty,
      label_printed_by: profile?.id || null, label_printed_by_name: profile?.full_name || null, label_printed_at: new Date().toISOString(),
    }).eq('id', it.id)
    if (er) { setError(er.message); setBusy(''); return }
    setBusy(''); setSuccess(`Saved ${it.item_code}.`); setEdits(p => { const n = { ...p }; delete n[it.id]; return n }); load()
  }
  async function uploadPhoto(it: MRItem, r: MReq, file: File) {
    if (!canEditFac(r.factory_code)) { setError('You have view-only access at this factory.'); return }
    setBusy(`photo|${it.id}`); setError('')
    const path = `labels/${it.id}.jpg`
    const { error: up } = await supabase.storage.from('delivery-orders').upload(path, file, { upsert: true, contentType: file.type || 'image/jpeg' })
    if (up) { setError(`Photo upload failed: ${up.message}`); setBusy(''); return }
    await supabase.from('material_request_items').update({ label_photo_path: path }).eq('id', it.id)
    setBusy(''); setSuccess(`Photo attached for ${it.item_code}.`); load()
  }
  async function viewPhoto(path: string) {
    const { data } = await supabase.storage.from('delivery-orders').createSignedUrl(path, 120)
    if (data) window.open(data.signedUrl, '_blank')
  }
  function addManualLine() {
    if (!manItem) { setError('Pick a label.'); return }
    const q = Number(manQty)
    if (!(q > 0)) { setError('Enter a quantity greater than zero.'); return }
    setError('')
    const line = { code: manItem.code, description: manItem.description, unit: manItem.unit, qty: q, forProduct: manFor.trim(), batch: manBatch.trim(), exp: manExp }
    setManLines(prev => [...prev, line])
    setManItem(null); setManQty(''); setManFor(''); setManBatch(''); setManExp('')
  }
  async function submitManualLabel(facOpts: string[]) {
    const fac = facOpts.includes(manFac) ? manFac : (facOpts[0] || '')
    if (!fac) { setError('You are not allowed to request for any location.'); return }
    if (!canEditFac(fac)) { setError('You have view-only access at this factory.'); return }
    const pending = manItem && Number(manQty) > 0 ? [{ code: manItem.code, description: manItem.description, unit: manItem.unit, qty: Number(manQty), forProduct: manFor.trim(), batch: manBatch.trim(), exp: manExp }] : []
    const lines = [...manLines, ...pending]
    if (lines.length === 0) { setError('Add at least one label.'); return }
    const items = lines.map(l => ({ code: l.code, description: l.description, unit: l.unit, qty: l.qty, for_product: l.forProduct, batch: l.batch, exp: l.exp }))
    setBusy('manual'); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('raise_manual_label_request', { p_factory: fac, p_items: items })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Label request added (${lines.length}) — ready to print at ${factoryName(fac)}.`)
    setManItem(null); setManQty(''); setManFor(''); setManBatch(''); setManExp(''); setManLines([]); setShowManual(false)
    load()
  }
  async function act(rpc: 'send_labels' | 'receive_labels', ids: string[], doneMsg: string) {
    if (ids.length === 0) { setError('Select at least one label.'); return }
    setBusy(rpc); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc(rpc, { p_item_ids: ids })
    if (e) { setError(e.message); setBusy(''); return }
    setBusy(''); setSuccess(doneMsg); setSel(new Set()); load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  // Flatten to label lines
  const lines = reqs.flatMap(r => (r.material_request_items || []).filter(it => factoryItems.has(it.item_code)).map(it => ({ it, r, stage: stageOf(it, r) })))
  const counts: Record<string, number> = {}; lines.forEach(l => { counts[l.stage] = (counts[l.stage] || 0) + 1 })
  const shown = (filter === 'all' ? lines : lines.filter(l => l.stage === filter))
    .sort((a, b) => a.r.factory_code.localeCompare(b.r.factory_code))
  const selPrinted = shown.filter(l => sel.has(l.it.id) && l.stage === 'printed').map(l => l.it.id)
  const selSent = shown.filter(l => sel.has(l.it.id) && l.stage === 'sent').map(l => l.it.id)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Labels</h1>
        <p className="text-gray-500 text-sm mb-4">Factory-printed labels, through their stages: requested → material received → printed → sent → received (completed).</p>

        <div className="flex flex-wrap gap-2 mb-4">
          {([{ key: 'all', label: 'All' }, ...STAGES] as { key: Stage | 'all'; label: string }[]).map(s => (
            <button key={s.key} onClick={() => { setFilter(s.key); setSel(new Set()) }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === s.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {s.label}{s.key !== 'all' && counts[s.key] ? ` (${counts[s.key]})` : ''}
            </button>
          ))}
        </div>

        {(() => {
          const facOpts = (isHO ? factories.map(f => f.code) : (profile?.factory_codes?.length ? profile.factory_codes : [profile?.factory_code || ''])).filter(c => c && canEditFac(c))
          if (facOpts.length === 0) return null
          const fac = facOpts.includes(manFac) ? manFac : facOpts[0]
          return (
            <div className="mb-5">
              <button onClick={() => { setShowManual(o => !o); setError(''); setSuccess('') }} className="text-blue-600 hover:underline text-sm font-medium">
                {showManual ? '× Close label request' : '➕ Request a label manually'}
              </button>
              {showManual && (
                <div className="mt-2 bg-white border rounded-xl shadow-sm p-4">
                  <p className="text-gray-500 text-xs mb-3">Raise a factory-printed label by hand (no batch). It goes straight to <strong>Material received</strong> — ready to print, send, and receive into stock.</p>
                  <div className="flex flex-wrap items-end gap-3">
                    {facOpts.length > 1 && (
                      <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory</span>
                        <select value={fac} onChange={e => setManFac(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white">
                          {facOpts.map(c => <option key={c} value={c}>{isHO ? factoryName(c) : c}</option>)}
                        </select></div>
                    )}
                    <div className="flex flex-col gap-1 flex-1 min-w-[15rem]"><span className="text-xs font-medium text-gray-600">Label</span>
                      <ItemPicker items={labelItems} value={manItem ? `${manItem.code} — ${manItem.description}` : ''} onPick={it => setManItem(it)} placeholder="Type a label code or name…" />
                    </div>
                    <div className="flex flex-col gap-1 flex-1 min-w-[12rem]"><span className="text-xs font-medium text-gray-600">For product</span>
                      <input value={manFor} onChange={e => setManFor(e.target.value)} placeholder="e.g. E1041-10UN/BAG" className="border rounded-lg px-3 py-2 text-sm" /></div>
                    <div className="flex flex-col gap-1 w-24"><span className="text-xs font-medium text-gray-600">Qty{manItem ? ` (${manItem.unit})` : ''}</span>
                      <input type="number" step="any" value={manQty} onChange={e => setManQty(e.target.value)} className="border rounded-lg px-3 py-2 text-sm text-right" /></div>
                    <div className="flex flex-col gap-1 w-32"><span className="text-xs font-medium text-gray-600">Batch</span>
                      <input value={manBatch} onChange={e => setManBatch(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" /></div>
                    <div className="flex flex-col gap-1 w-40"><span className="text-xs font-medium text-gray-600">Expiry</span>
                      <input type="date" value={manExp} onChange={e => setManExp(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" /></div>
                    <button onClick={addManualLine} className="border border-blue-600 text-blue-600 px-4 py-2 rounded-lg hover:bg-blue-50 text-sm font-medium">+ Add label</button>
                  </div>
                  {manLines.length > 0 && (
                    <div className="mt-3 border rounded-lg overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b"><tr>{['Label', 'Description', 'For product', 'Qty', 'Batch', 'Expiry', ''].map(h => <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
                        <tbody>
                          {manLines.map((l, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-3 py-1.5 font-mono font-medium whitespace-nowrap">{l.code}</td>
                              <td className="px-3 py-1.5 text-gray-600">{l.description}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{l.forProduct || '—'}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{Number(Number(l.qty).toFixed(3))} {l.unit}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{l.batch || '—'}</td>
                              <td className="px-3 py-1.5 whitespace-nowrap">{l.exp ? fmtExp(l.exp) : '—'}</td>
                              <td className="px-3 py-1.5 text-right"><button onClick={() => setManLines(prev => prev.filter((_, x) => x !== i))} className="text-red-500 hover:underline text-xs">remove</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button onClick={() => submitManualLabel(facOpts)} disabled={busy === 'manual'} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{busy === 'manual' ? 'Submitting…' : `Submit request${manLines.length ? ` (${manLines.length})` : ''}`}</button>
                    {manLines.length > 0 && <button onClick={() => setManLines([])} className="text-gray-500 hover:underline text-xs">Clear list</button>}
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {(selPrinted.length > 0 || selSent.length > 0) && (
          <div className="flex flex-wrap items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{sel.size} selected</span>
            {selPrinted.length > 0 && <button onClick={() => act('send_labels', selPrinted, `${selPrinted.length} label(s) sent.`)} disabled={busy === 'send_labels'} className="bg-indigo-600 text-white px-4 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium">Send {selPrinted.length} → location</button>}
            {selSent.length > 0 && <button onClick={() => act('receive_labels', selSent, `${selSent.length} label(s) received into stock.`)} disabled={busy === 'receive_labels'} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Receive {selSent.length} → stock</button>}
            <button onClick={() => setSel(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">No labels{filter !== 'all' ? ` at "${STAGES.find(s => s.key === filter)?.label}"` : ' yet'}.</div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0 z-10">
                <tr>{['', 'Label', 'For product', ...(isHO ? ['Factory'] : []), 'Stage', 'Qty', 'Batch / Expiry', 'Photo', 'Action'].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
              </thead>
              <tbody>
                {shown.map(({ it, r, stage }) => {
                  const e = edits[it.id] ?? { batch: it.label_batch_no ?? '', exp: it.label_exp_date ?? '', qty: String(it.label_print_qty ?? it.requested_qty) }
                  const setE = (patch: Partial<{ batch: string; exp: string; qty: string }>) => setEdits(p => ({ ...p, [it.id]: { batch: p[it.id]?.batch ?? it.label_batch_no ?? '', exp: p[it.id]?.exp ?? it.label_exp_date ?? '', qty: p[it.id]?.qty ?? String(it.label_print_qty ?? it.requested_qty), ...patch } }))
                  const locked = !!it.label_printed_at   // details saved → no more editing
                  const editDetails = canEditFac(r.factory_code) && !locked && (stage === 'material' || stage === 'printed')
                  const canPhoto = canEditFac(r.factory_code) && !it.label_photo_path && (stage === 'material' || stage === 'printed')
                  const selectable = canEditFac(r.factory_code) && (stage === 'printed' || stage === 'sent')
                  const rawMats = (r.material_request_items || []).filter(m => !factoryItems.has(m.item_code))
                  return (
                    <Fragment key={it.id}>
                    <tr className="border-b last:border-0 align-top hover:bg-gray-50">
                      <td className="px-3 py-2">{selectable && <input type="checkbox" className="h-4 w-4" checked={sel.has(it.id)} onChange={() => toggleSel(it.id)} />}</td>
                      <td className="px-3 py-2"><span className="font-mono font-medium">{it.item_code}</span><span className="block text-gray-400">{it.description}</span></td>
                      <td className="px-3 py-2"><span className="font-mono">{r.production_batches?.item_code || it.label_for_product || '—'}</span>{r.production_batches?.description && <span className="block text-gray-700 text-xs max-w-[16rem]">{r.production_batches.description}</span>}<span className="block text-gray-400 text-xs">{r.pick_run_no || r.request_no}</span>{rawMats.length > 0 && <button onClick={() => toggleMat(it.id)} className="block text-blue-600 hover:underline text-xs mt-0.5">{openMat.has(it.id) ? '▾ hide materials' : '▸ show materials'}</button>}</td>
                      {isHO && <td className="px-3 py-2 whitespace-nowrap text-gray-600">{factoryName(r.factory_code)}</td>}
                      <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STAGE_STYLE[stage]}`}>{STAGES.find(s => s.key === stage)?.label}</span></td>
                      <td className="px-3 py-2 text-right"><span className="font-semibold" title="Calculated by the system from the order">{Number(Number(it.requested_qty).toFixed(3))}</span></td>
                      <td className="px-3 py-2">{editDetails ? (
                        <div className="flex flex-col gap-1">
                          <input value={e.batch} onChange={ev => setE({ batch: ev.target.value })} placeholder="batch no." className="border rounded px-2 py-1 text-xs w-28" />
                          <input type="date" value={e.exp} onChange={ev => setE({ exp: ev.target.value })} className="border rounded px-2 py-1 text-xs" />
                        </div>
                      ) : <><span className="text-gray-600 text-xs">{it.label_batch_no || '—'}{it.label_exp_date ? ` · exp ${fmtExp(it.label_exp_date)}` : ''}</span>{it.label_printed_by_name && <span className="block text-gray-400 text-[10px]">🔒 saved by {it.label_printed_by_name}{it.label_printed_at ? ` · ${new Date(it.label_printed_at).toLocaleDateString()}` : ''}</span>}</>}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {it.label_photo_path
                          ? <button onClick={() => viewPhoto(it.label_photo_path!)} className="text-green-600 hover:underline text-xs">✓ View</button>
                          : canPhoto ? <label className="text-blue-600 hover:underline text-xs cursor-pointer">{busy === `photo|${it.id}` ? '…' : '📷 Photo'}<input type="file" accept="image/*" capture="environment" className="hidden" onChange={ev => { const f = ev.target.files?.[0]; if (f) uploadPhoto(it, r, f); ev.target.value = '' }} /></label>
                            : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">
                        {stage === 'requested' && <span className="text-amber-600">🔒 waiting for materials</span>}
                        {stage === 'material' && !locked && <button onClick={() => saveLabel(it, r)} disabled={busy === `save|${it.id}`} className="text-blue-600 hover:underline disabled:opacity-50">{busy === `save|${it.id}` ? 'Saving…' : 'Save details'}</button>}
                        {stage === 'material' && locked && <span className="text-amber-600">Saved — attach photo to send</span>}
                        {stage === 'printed' && canEditFac(r.factory_code) && <button onClick={() => act('send_labels', [it.id], 'Label sent.')} disabled={busy === 'send_labels'} className="bg-indigo-600 text-white px-3 py-1 rounded hover:bg-indigo-700 disabled:opacity-50">Send</button>}
                        {stage === 'sent' && canEditFac(r.factory_code) && <button onClick={() => act('receive_labels', [it.id], 'Label received into stock.')} disabled={busy === 'receive_labels'} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Receive → stock</button>}
                        {stage === 'completed' && <span className="text-green-600 font-medium">✓ Completed</span>}
                      </td>
                    </tr>
                    {openMat.has(it.id) && (
                      <tr className="bg-gray-50/60">
                        <td colSpan={isHO ? 9 : 8} className="px-6 py-2">
                          <div className="text-xs font-medium text-gray-600 mb-1">Materials for this product — ordered vs received (use a received batch on the label):</div>
                          <table className="w-full text-xs">
                            <thead><tr className="text-gray-500">{['Material', 'Requested', 'Received', 'Batch(es) received'].map(h => <th key={h} className="text-left px-2 py-1 font-medium">{h}</th>)}</tr></thead>
                            <tbody>
                              {rawMats.map(m => (
                                <tr key={m.id} className="border-t">
                                  <td className="px-2 py-1"><span className="font-mono font-medium">{m.item_code}</span></td>
                                  <td className="px-2 py-1">{Number(Number(m.requested_qty).toFixed(3))} {m.unit}</td>
                                  <td className="px-2 py-1">{Number(Number(m.received_qty).toFixed(3))} {m.unit}</td>
                                  <td className="px-2 py-1">{(lotsByItem[m.id] || []).length
                                    ? (lotsByItem[m.id]).map(x => `${x.batch_no} (${Number(Number(x.qty).toFixed(3))}${x.exp ? ', exp ' + fmtExp(x.exp) : ''})`).join('  ·  ')
                                    : <span className="text-gray-400">— none received yet</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
