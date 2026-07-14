'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'
import QrScanner from '@/components/QrScanner'
import { parseQr } from '@/lib/qr'

interface Task { id: string; count_no: string | null; name: string | null; scope_type: string; blind: boolean; status: string; created_by_name: string | null; applied_by_name: string | null; applied_at: string | null }
interface CLine { id: string; location_id: string | null; location_code: string; item_id: string | null; item_code: string; description: string | null; batch_no: string; exp_date: string | null; expected_qty: number; counted_qty: number | null; is_unexpected: boolean; skip: boolean; counted_by_name: string | null }
interface Item { code: string; description: string; unit: string }
interface Loc { id: string; code: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number | null) => n == null ? '' : clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })

function discrepancy(l: CLine): { type: string; chip: string } | null {
  if (l.counted_qty == null) return null
  if (l.is_unexpected) return { type: 'Unexpected item', chip: 'bg-sky-100 text-sky-700' }
  const d = clean(l.counted_qty - l.expected_qty)
  if (d === 0) return null
  if (l.counted_qty === 0) return { type: 'Missing', chip: 'bg-red-100 text-red-700' }
  if (d < 0) return { type: 'Short', chip: 'bg-amber-100 text-amber-700' }
  return { type: 'Over', chip: 'bg-violet-100 text-violet-700' }
}

export default function WmsCountPage() {
  const { id } = useParams<{ id: string }>()
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [task, setTask] = useState<Task | null>(null)
  const [lines, setLines] = useState<CLine[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [locByCode, setLocByCode] = useState<Map<string, Loc>>(new Map())
  const [tab, setTab] = useState<'count' | 'review'>('count')
  const [activeBin, setActiveBin] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [uItem, setUItem] = useState(''); const [uDesc, setUDesc] = useState(''); const [uBatch, setUBatch] = useState(''); const [uQty, setUQty] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [prodScanOpen, setProdScanOpen] = useState(false); const [scanMsg, setScanMsg] = useState('')

  // Refs so the continuous product-scan loop always sees fresh data + serializes writes.
  const linesRef = useRef<CLine[]>([]); useEffect(() => { linesRef.current = lines }, [lines])
  const seenRef = useRef<Set<string>>(new Set())      // exact labels scanned this session (dedupe same bag)
  const tallyRef = useRef<Map<string, number>>(new Map())  // running count per item|batch
  const createdRef = useRef<Map<string, string>>(new Map())
  const queueRef = useRef<string[]>([]); const pumpingRef = useRef(false)

  const load = useCallback(async () => {
    const { data: t } = await supabase.from('wms_count_tasks').select('*').eq('id', id).single()
    const { data: ls } = await supabase.from('wms_count_lines').select('*').eq('task_id', id).order('location_code').order('item_code')
    setTask((t as Task) || null); setLines((ls as CLine[]) || [])
    if (!items.length) setItems(await fetchAll<Item>('items', 'code, description, unit', 'code'))
    if (!locByCode.size) setLocByCode(new Map((await fetchAll<Loc>('wms_locations', 'id, code', 'code')).map(l => [l.code.toUpperCase(), l])))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (profile) load() }, [profile, load])

  const bins = useMemo(() => Array.from(new Set(lines.map(l => l.location_code))).sort(), [lines])
  const binLines = useMemo(() => lines.filter(l => l.location_code === activeBin), [lines, activeBin])
  const counted = lines.filter(l => l.counted_qty != null).length
  const discreps = useMemo(() => lines.filter(l => discrepancy(l)), [lines])
  const applied = task?.status === 'Applied'

  async function saveCount(line: CLine, val: string) {
    if (!canEdit || applied) return
    const qty = val === '' ? null : Number(val)
    if (val !== '' && !isFinite(qty as number)) return
    const { error } = await supabase.from('wms_count_lines').update({ counted_qty: qty, counted_by: profile?.id, counted_by_name: profile?.full_name, counted_at: new Date().toISOString() }).eq('id', line.id)
    if (error) { setErr(error.message); return }
    setLines(ls => ls.map(l => l.id === line.id ? { ...l, counted_qty: qty } : l))
  }

  async function addUnexpected() {
    if (!canEdit || !activeBin) return
    const loc = locByCode.get(activeBin.toUpperCase())
    const code = uItem.trim(); const qty = Number(uQty)
    if (!code) { setErr('Pick the item found.'); return }
    if (!(qty > 0)) { setErr('Enter the quantity found.'); return }
    setBusy(true); setErr('')
    const it = items.find(i => i.code.toUpperCase() === code.toUpperCase())
    const { data: itemRow } = await supabase.from('items').select('id').eq('code', code).maybeSingle()
    const { error } = await supabase.from('wms_count_lines').insert({
      task_id: id, location_id: loc?.id ?? null, location_code: activeBin, item_id: itemRow?.id ?? null,
      item_code: code, description: it?.description ?? null, batch_no: uBatch.trim(), expected_qty: 0,
      counted_qty: qty, is_unexpected: true, counted_by: profile?.id, counted_by_name: profile?.full_name, counted_at: new Date().toISOString(),
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setUItem(''); setUDesc(''); setUBatch(''); setUQty(''); load()
  }

  // --- Scan products to tally (each scanned batch label = +1 in the active bin) ---
  function openProdScan() { seenRef.current = new Set(); tallyRef.current = new Map(); createdRef.current = new Map(); setScanMsg(''); setProdScanOpen(true) }
  function enqueueScan(raw: string) { queueRef.current.push(raw); pump() }
  async function pump() {
    if (pumpingRef.current) return
    pumpingRef.current = true
    try { while (queueRef.current.length) await handleScan(queueRef.current.shift()!) } finally { pumpingRef.current = false }
  }
  async function handleScan(raw: string) {
    if (!canEdit || !activeBin || applied) return
    if (seenRef.current.has(raw)) { setScanMsg('⚠ already scanned that exact label'); return }
    const p = parseQr(raw)
    if (p.kind !== 'item') { setScanMsg('⚠ not a product label'); return }
    seenRef.current.add(raw)
    const item = p.item_code, batch = p.batch, key = `${item.toUpperCase()}|${batch}`
    const nq = (tallyRef.current.get(key) || 0) + 1; tallyRef.current.set(key, nq)
    const meta = { counted_by: profile?.id, counted_by_name: profile?.full_name, counted_at: new Date().toISOString() }
    let target = linesRef.current.find(l => l.location_code === activeBin && l.item_code.toUpperCase() === item.toUpperCase() && l.batch_no === batch)
    const cid = createdRef.current.get(key); if (!target && cid) target = linesRef.current.find(l => l.id === cid)
    if (target) {
      const t = target
      const { error } = await supabase.from('wms_count_lines').update({ counted_qty: nq, ...meta }).eq('id', t.id)
      if (error) { setScanMsg(error.message); return }
      const upd = linesRef.current.map(l => l.id === t.id ? { ...l, counted_qty: nq } : l); linesRef.current = upd; setLines(upd)
    } else {
      const loc = locByCode.get(activeBin.toUpperCase())
      const { data: itemRow } = await supabase.from('items').select('id, description').eq('code', item).maybeSingle()
      const ir = itemRow as { id: string; description: string } | null
      const { data: ins, error } = await supabase.from('wms_count_lines').insert({ task_id: id, location_id: loc?.id ?? null, location_code: activeBin, item_id: ir?.id ?? null, item_code: item, description: ir?.description ?? null, batch_no: batch, expected_qty: 0, counted_qty: nq, is_unexpected: true, ...meta }).select().single()
      if (error) { setScanMsg(error.message); return }
      const nl = ins as CLine; createdRef.current.set(key, nl.id)
      const upd = [...linesRef.current, nl]; linesRef.current = upd; setLines(upd)
    }
    setScanMsg(`✓ ${item}${batch ? ' · ' + batch : ''} → ${nq}`)
  }

  async function toggleSkip(line: CLine) {
    if (!canEdit || applied) return
    await supabase.from('wms_count_lines').update({ skip: !line.skip }).eq('id', line.id)
    setLines(ls => ls.map(l => l.id === line.id ? { ...l, skip: !l.skip } : l))
  }

  async function apply() {
    if (!canEdit || applied) return
    if (!confirm('Apply the approved adjustments and correct the stock? This is logged.')) return
    setBusy(true); setErr(''); setMsg('')
    const { data, error } = await supabase.rpc('wms_apply_count', { p_task_id: id })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setMsg(`Applied ${(data as { applied: number }).applied} adjustment(s). Stock corrected and logged.`)
    load()
  }

  function onScan(raw: string) {
    const p = parseQr(raw)
    if (p.kind !== 'bin') { setErr('That’s not a bin QR.'); return }
    if (!locByCode.has(p.code)) { setErr(`Bin ${p.code} is not in the Location Map.`); return }
    setActiveBin(p.code); setScanOpen(false); setErr(''); setTab('count')
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!task) return <div className="p-8 text-sm text-gray-500">Count not found. <Link href="/wms/counts" className="text-emerald-700 underline">Back</Link></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/wms/counts" className="text-sm text-emerald-700 hover:underline">← Stock Counts</Link>
        <div className="flex flex-wrap items-center gap-3 mt-2 mb-1">
          <h1 className="text-2xl font-bold">{task.count_no}{task.name ? ` · ${task.name}` : ''}</h1>
          {task.blind && <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full font-medium">Blind</span>}
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${applied ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-100 text-emerald-700'}`}>{task.status}</span>
        </div>
        <p className="text-gray-500 text-sm mb-5">{counted}/{lines.length} lines counted · {discreps.length} discrepanc{discreps.length === 1 ? 'y' : 'ies'}{applied ? ` · applied by ${task.applied_by_name}` : ''}</p>

        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        <div className="inline-flex rounded-lg border bg-white p-1 mb-5 text-sm">
          {(['count', 'review'] as const).map(m => (
            <button key={m} onClick={() => setTab(m)} className={`px-4 py-1.5 rounded-md font-medium ${tab === m ? 'bg-emerald-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              {m === 'count' ? 'Count' : `Review${discreps.length ? ` (${discreps.length})` : ''}`}
            </button>
          ))}
        </div>

        {tab === 'count' && !applied && (
          <>
            <div className="flex flex-wrap gap-2 mb-4">
              <button onClick={() => { setScanOpen(true); setErr('') }} className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 text-sm font-medium">📷 Scan a bin</button>
              <select value={activeBin} onChange={e => setActiveBin(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                <option value="">…or pick a bin</option>
                {bins.map(b => <option key={b} value={b}>{b} ({lines.filter(l => l.location_code === b && l.counted_qty != null).length}/{lines.filter(l => l.location_code === b).length})</option>)}
              </select>
            </div>

            {activeBin && (
              <div className="bg-white rounded-xl shadow-sm border p-5 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold">Bin <span className="font-mono">{activeBin}</span></h2>
                  <button onClick={openProdScan} className="bg-emerald-700 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-800 text-sm font-medium">📷 Scan products</button>
                </div>
                <div className="space-y-2">
                  {binLines.length === 0 && <p className="text-sm text-gray-400">System expects nothing here — add anything you find below.</p>}
                  {binLines.map(l => (
                    <div key={l.id} className="flex flex-wrap items-center gap-2 border-b last:border-0 pb-2">
                      <div className="flex-1 min-w-[160px]">
                        <div className="font-mono text-sm font-medium">{l.item_code}{l.is_unexpected && <span className="ml-1 text-xs text-sky-600">found</span>}</div>
                        <div className="text-xs text-gray-500">{l.description}{l.batch_no ? ` · b:${l.batch_no}` : ''}</div>
                      </div>
                      {!task.blind && <div className="text-xs text-gray-400 tabular-nums">system {fmtQty(l.expected_qty)}</div>}
                      <input value={inputs[l.id] ?? (l.counted_qty != null ? String(l.counted_qty) : '')}
                        onChange={e => setInputs(s => ({ ...s, [l.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                        onBlur={e => saveCount(l, e.target.value)}
                        placeholder="count" className="w-24 border rounded-lg px-3 py-1.5 text-sm text-right tabular-nums" inputMode="decimal" />
                    </div>
                  ))}
                </div>

                <div className="mt-4 border-t pt-3">
                  <div className="text-xs text-gray-500 mb-2">Found something not listed? Add it:</div>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <div className="sm:col-span-2"><ItemPicker items={items} value={uItem ? `${uItem} — ${uDesc}` : ''} onPick={it => { setUItem(it.code); setUDesc(it.description) }} /></div>
                    <input value={uBatch} onChange={e => setUBatch(e.target.value)} placeholder="batch" className="border rounded-lg px-3 py-2 text-sm font-mono" />
                    <div className="flex gap-2">
                      <input value={uQty} onChange={e => setUQty(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="qty" className="w-full border rounded-lg px-3 py-2 text-sm text-right tabular-nums" inputMode="decimal" />
                      <button onClick={addUnexpected} disabled={busy} className="bg-emerald-700 text-white px-3 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm">Add</button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {(tab === 'review' || applied) && (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>{['Bin', 'Item', 'Batch', 'System', 'Counted', 'Diff', 'Type', applied ? '' : 'Apply?'].map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {discreps.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-gray-400">No discrepancies — everything counted matches the system. 🎉</td></tr>}
                {discreps.map(l => {
                  const d = discrepancy(l)!; const diff = clean((l.counted_qty ?? 0) - l.expected_qty)
                  return (
                    <tr key={l.id} className={`border-b last:border-0 ${l.skip ? 'opacity-40' : ''}`}>
                      <td className="px-3 py-2 font-mono text-xs">{l.location_code}</td>
                      <td className="px-3 py-2"><span className="font-mono font-medium">{l.item_code}</span> <span className="text-gray-400 text-xs">{l.description}</span></td>
                      <td className="px-3 py-2 font-mono text-xs">{l.batch_no || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtQty(l.expected_qty)}</td>
                      <td className="px-3 py-2 tabular-nums font-medium">{fmtQty(l.counted_qty)}</td>
                      <td className={`px-3 py-2 tabular-nums font-medium ${diff < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{diff > 0 ? '+' : ''}{fmtQty(diff)}</td>
                      <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${d.chip}`}>{d.type}</span></td>
                      {!applied && <td className="px-3 py-2"><input type="checkbox" checked={!l.skip} onChange={() => toggleSkip(l)} title="Apply this correction" /></td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!applied && discreps.length > 0 && canEdit && (
              <div className="p-4 border-t flex items-center gap-3">
                <button onClick={apply} disabled={busy} className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">{busy ? 'Applying…' : `Apply ${discreps.filter(l => !l.skip).length} correction(s)`}</button>
                <span className="text-xs text-gray-500">Untick a row to skip it (e.g. recount needed). Uncounted lines are never changed.</span>
              </div>
            )}
          </div>
        )}
      </div>

      {scanOpen && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setScanOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-sm p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2"><h2 className="font-semibold">Scan a bin</h2><button onClick={() => setScanOpen(false)} className="text-gray-400 text-lg">✕</button></div>
            <QrScanner onDetect={onScan} onError={m => setErr(m)} />
            <p className="text-xs text-gray-400 mt-2">Point at the bin’s QR label.</p>
          </div>
        </div>
      )}

      {prodScanOpen && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setProdScanOpen(false)}>
          <div className="bg-white rounded-xl w-full max-w-sm p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2"><h2 className="font-semibold">Scan products into <span className="font-mono">{activeBin}</span></h2><button onClick={() => setProdScanOpen(false)} className="text-gray-400 text-lg">✕</button></div>
            <QrScanner onDetect={enqueueScan} onError={setScanMsg} />
            <div className={`mt-2 text-center text-sm font-medium min-h-[1.5rem] ${scanMsg.startsWith('✓') ? 'text-emerald-700' : scanMsg.startsWith('⚠') ? 'text-amber-600' : 'text-gray-500'}`}>{scanMsg || 'Scan each bag / pack…'}</div>
            <p className="text-xs text-gray-400 mt-1">Each unique label counts once. An item not expected here is added as “found”.</p>
            <button onClick={() => setProdScanOpen(false)} className="mt-3 w-full border py-2 rounded-lg text-sm font-medium hover:bg-gray-50">Done</button>
          </div>
        </div>
      )}
    </div>
  )
}
