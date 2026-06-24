'use client'
import { createContext, useContext, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { requestTimerCancel } from '@/lib/corrections'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface Hourly { time: string; weight: string; ink: string; qc_color: string; qc_odour: string; qc_phy: string; temp: string; speed: string; press: string; drop: string; alu: string; fe: string; nonfe: string; ss: string; remarks: string }
// One batch of a material used: which stock batch and how much
interface MatUse { batch: string; qty: string }
// One BOM component on the production record: planned (from recipe) vs actually used (one or more batches)
interface Mat { code: string; desc: string; unit: string; planned: number; main: boolean; uses: MatUse[] }
type Form = Record<string, string | boolean | Hourly[] | Mat[]>
// Old records stored a single { batch, used }; lift them to the new { uses: [...] } shape
function normMat(m: Record<string, unknown>): Mat {
  const uses = Array.isArray(m.uses) ? (m.uses as MatUse[]) : [{ batch: (m.batch as string) || '', qty: (m.used as string) || '' }]
  return { code: (m.code as string) || '', desc: (m.desc as string) || '', unit: (m.unit as string) || '', planned: Number(m.planned || 0), main: !!m.main, uses: uses.length ? uses : [{ batch: '', qty: '' }] }
}
const matTotal = (m: Mat) => m.uses.reduce((t, u) => t + Number(u.qty || 0), 0)

// Form-field helpers are module-level (stable component identities) and read the
// live form through context — so typing a character doesn't remount the input
// and steal focus (the old in-render definitions did exactly that).
const FormCtx = createContext<{ s: (k: string) => string; set: (k: string, v: string | boolean) => void }>({ s: () => '', set: () => {} })
function In({ k, type = 'text', cls = '' }: { k: string; type?: string; cls?: string }) {
  const { s, set } = useContext(FormCtx)
  return <input type={type} value={s(k)} onChange={e => set(k, e.target.value)} className={`border rounded px-3 py-2 text-sm w-full ${cls}`} />
}
function Radio({ k, val, label }: { k: string; val: string; label: string }) {
  const { s, set } = useContext(FormCtx)
  return <label className="inline-flex items-center gap-1 text-xs cursor-pointer mr-3"><input type="checkbox" checked={s(k) === val} onChange={() => set(k, s(k) === val ? '' : val)} className="h-3.5 w-3.5" />{label}</label>
}
function GoodBad({ k, label }: { k: string; label: string }) {
  return <span className="text-xs"><span className="font-medium">{label}:</span> <Radio k={k} val="good" label="Good" /><Radio k={k} val="notgood" label="Not good" /></span>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">{label}</span>{children}</div>
}

interface Seg { s: string; e: string | null }
interface Timer { status: 'idle' | 'running' | 'paused' | 'stopped'; segments: Seg[] }
const EMPTY_TIMER: Timer = { status: 'idle', segments: [] }
const segMs = (seg: Seg, nowMs: number) => (seg.e ? Date.parse(seg.e) : nowMs) - Date.parse(seg.s)
const totalMs = (t: Timer, nowMs: number) => t.segments.reduce((sum, seg) => sum + segMs(seg, nowMs), 0)
// Total paused time = gaps between work segments, plus the ongoing pause if currently paused
const pauseMs = (t: Timer, nowMs: number) => {
  let total = 0
  for (let i = 1; i < t.segments.length; i++) { const prevEnd = t.segments[i - 1].e; if (prevEnd) total += Date.parse(t.segments[i].s) - Date.parse(prevEnd) }
  if (t.status === 'paused' && t.segments.length) { const last = t.segments[t.segments.length - 1]; if (last.e) total += nowMs - Date.parse(last.e) }
  return total
}
const fmtDur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` }
const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'

// Live timer displays own their own per-second tick, so the rest of the form
// doesn't re-render every second (which was interrupting typing).
function useTick(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!active) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [active])
  return now
}
function TimerClock({ timer }: { timer: Timer }) {
  const now = useTick(timer.status === 'running' || timer.status === 'paused')
  return <span className="font-mono text-xl font-bold ml-1">{fmtDur(totalMs(timer, now))}</span>
}
function TimerStats({ timer }: { timer: Timer }) {
  const now = useTick(timer.status === 'running' || timer.status === 'paused')
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
      <span>Started: {fmtTime(timer.segments[0]?.s || null)}</span>
      <span>Ended: {fmtTime(timer.status === 'stopped' ? (timer.segments[timer.segments.length - 1]?.e || null) : null)}</span>
      <span>Run time <span className="text-gray-400">(excl. breaks)</span>: <strong className="text-gray-700">{fmtDur(totalMs(timer, now))}</strong></span>
      <span>Pause time: <strong className="text-amber-700">{fmtDur(pauseMs(timer, now))}</strong></span>
      <span>Total: <strong className="text-gray-700">{fmtDur(totalMs(timer, now) + pauseMs(timer, now))}</strong></span>
    </div>
  )
}

const blankHour = (): Hourly => ({ time: '', weight: '', ink: '', qc_color: '', qc_odour: '', qc_phy: '', temp: '', speed: '', press: '', drop: '', alu: '', fe: '', nonfe: '', ss: '', remarks: '' })
const EMPTY: Form = {
  date: '', area_machine: '', no: '', code: '', product: '',
  prod_start: '', prod_end: '', qty_produced: '',
  bn_raw_material: '', rm_weight_in: '', total_used: '', plastic: '', bn_plastic: '', wastage: '', food_loss_a: '',
  moisture_pct: '', moisture_max: '', temp_in: '', temp_out: '', speed_in: '', speed_out: '', time_in: '', time_out: '',
  printing_clear: false, product_weigh: '', exp_in: '', exp_out: '', bubble: '', broken: '', ok: '',
  sample1: '', sample2: '', sample3: '', alu_pad: '',
  s1_print: '', s1_bubble: '', s1_drop: '', s1_ok: '',
  s2_print: '', s2_bubble: '', s2_drop: '', s2_ok: '',
  s3_print: '', s3_bubble: '', s3_drop: '', s3_ok: '',
  md_ferrous: '', md_nonferrous: '', md_stainless: '', md_qty_reject: '', md_remark: '', md_action: '',
  qc_colour: '', qc_odour: '', qc_physical: '', cleanliness: '', prev_batch_removed: '', prev_batch_remark: '',
  yield_pack: '', yield_bottle: '', yield_balance: '', done_by: '', checked_by: '', verified_by: '',
  retained: '', retained_qty: '', weighed_by: '', remarks: '',
  hourly: [blankHour(), blankHour(), blankHour(), blankHour()],
  materials: [],
}

export default function InspectionPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'inspection')
  const [batchId, setBatchId] = useState('')
  const [recordId, setRecordId] = useState('')
  const [f, setF] = useState<Form>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [factoryCode, setFactoryCode] = useState('')
  // Per-factory view-only: once the batch's factory is known, honour it.
  const canEditHere = () => can(profile, 'inspection', 'edit', factoryCode || profile?.factory_code)
  const [batchNo, setBatchNo] = useState('')
  const [planned, setPlanned] = useState(0)
  const [produced, setProduced] = useState(0)
  const [recordedQty, setRecordedQty] = useState(0)
  const [recording, setRecording] = useState(false)
  const [timer, setTimer] = useState<Timer>(EMPTY_TIMER)
  const [packLines, setPackLines] = useState<{ name: string; line_code: string | null; line_mode: string | null }[]>([])
  const [batchMode, setBatchMode] = useState('')   // batch run mode: auto | manual
  const [stockLots, setStockLots] = useState<Record<string, { batch_no: string; qty_remaining: number; exp_date: string | null }[]>>({})

  useEffect(() => { setBatchId(new URLSearchParams(window.location.search).get('batch') || '') }, [])
  useEffect(() => { if (profile && batchId) loadForBatch(batchId) }, [profile, batchId])
  // Auto-fill No. once the scheduled line + date + packing lines are known (don't overwrite an existing one)
  useEffect(() => { if (f.area_machine && !f.no && packLines.length && f.date && factoryCode) genNo(String(f.area_machine), String(f.date)) }, [f.area_machine, f.date, packLines, factoryCode]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadForBatch(id: string) {
    const { data: batch } = await supabase.from('production_batches').select('batch_no, item_code, description, factory_code, exp_date, total_quantity, produced_qty, pack_line, pack_date, run_mode, material_request_id').eq('id', id).single()
    if (batch) { setFactoryCode(batch.factory_code); setBatchNo(batch.batch_no); setPlanned(Number(batch.total_quantity || 0)); setProduced(Number(batch.produced_qty || 0)); setBatchMode(batch.run_mode || 'auto')
      const { data: pl } = await supabase.from('packing_lines').select('name, line_code, line_mode').eq('factory_code', batch.factory_code).eq('active', true).order('name'); setPackLines(pl || [])
    }
    // Stock allocated to this batch's material request → pushed in as the batches/qty to use.
    // (Stock received against a request line is tagged with request_item_id on the lot.)
    const allocByCode: Record<string, { batch: string; qty: string }[]> = {}
    if (batch?.material_request_id) {
      const { data: mri } = await supabase.from('material_request_items').select('id, item_code').eq('request_id', batch.material_request_id)
      const ids = (mri || []).map(x => x.id)
      if (ids.length) {
        const { data: alots } = await supabase.from('stock_lots').select('item_code, batch_no, qty_received, qty_remaining, request_item_id').in('request_item_id', ids)
        ;(alots || []).forEach(l => { if (!l.batch_no) return; (allocByCode[l.item_code] = allocByCode[l.item_code] || []).push({ batch: l.batch_no, qty: String(Number(l.qty_received ?? l.qty_remaining ?? 0)) }) })
      }
    }
    // Build the materials table from the product's BOM (planned = recipe qty × planned units)
    const total = Number(batch?.total_quantity || 0)
    let bomMats: Mat[] = []
    if (batch?.item_code) {
      const { data: parent } = await supabase.from('items').select('id').eq('code', batch.item_code).maybeSingle()
      if (parent) {
        const { data: comps } = await supabase.from('bom_components')
          .select('quantity, main_ingredient, items:component_item_id(code, description, unit)').eq('parent_item_id', parent.id)
        bomMats = (comps || []).map(c => { const it = c.items as unknown as { code: string; description: string; unit: string } | null
          const code = it?.code || ''; const alloc = allocByCode[code] || []
          return { code, desc: it?.description || '', unit: it?.unit || '', planned: Number(c.quantity || 0) * total, main: !!c.main_ingredient, uses: alloc.length ? alloc : [{ batch: '', qty: '' }] } })
      }
    }
    const { data: rec } = await supabase.from('inspection_records').select('*').eq('production_batch_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const recData = rec ? (rec.data as Record<string, unknown>) : null
    const savedMats = ((recData?.materials as Record<string, unknown>[]) || []).map(normMat)
    const mats = savedMats.length ? savedMats : bomMats
    // Available stock batches per material (from GRN → stock), oldest expiry first — for both new & saved records
    const codes = mats.map(m => m.code).filter(Boolean)
    const lotMap: Record<string, { batch_no: string; qty_remaining: number; exp_date: string | null }[]> = {}
    if (codes.length && batch?.factory_code) {
      const { data: lots } = await supabase.from('stock_lots').select('item_code, batch_no, qty_remaining, exp_date')
        .eq('factory_code', batch.factory_code).gt('qty_remaining', 0).in('item_code', codes)
        .order('exp_date', { ascending: true, nullsFirst: false }).order('received_at', { ascending: true })
      ;(lots || []).forEach(l => { if (!l.batch_no) return; (lotMap[l.item_code] = lotMap[l.item_code] || []).push({ batch_no: l.batch_no, qty_remaining: Number(l.qty_remaining), exp_date: l.exp_date }) })
    }
    // Make sure every allocated/used batch is selectable even if its remaining qty has since changed
    const ensureBatch = (code: string, b: string) => { if (!code || !b) return; const arr = lotMap[code] = lotMap[code] || []; if (!arr.some(x => x.batch_no === b)) arr.push({ batch_no: b, qty_remaining: 0, exp_date: null }) }
    Object.entries(allocByCode).forEach(([code, us]) => us.forEach(u => ensureBatch(code, u.batch)))
    mats.forEach(m => m.uses.forEach(u => ensureBatch(m.code, u.batch)))
    setStockLots(lotMap)
    if (rec && recData) {
      setRecordId(rec.id)
      setRecordedQty(Number(recData.recorded_qty || 0))
      setTimer((recData.timer as Timer) || EMPTY_TIMER)
      setF({ ...EMPTY, ...(recData as Form), materials: mats })
      return
    }
    const { data: cons } = await supabase.from('production_consumption').select('batch_no').eq('production_batch_id', id)
    const rmBatches = [...new Set((cons || []).map(c => c.batch_no).filter(Boolean))].join(', ')
    const td = new Date(); const localToday = `${td.getFullYear()}-${String(td.getMonth() + 1).padStart(2, '0')}-${String(td.getDate()).padStart(2, '0')}`
    setF({ ...EMPTY, date: batch?.pack_date || localToday, area_machine: batch?.pack_line || '', code: batch?.item_code || '', product: batch?.description || '', bn_raw_material: rmBatches, exp_in: batch?.exp_date || '', exp_out: batch?.exp_date || '', materials: mats })
  }
  // Edit one batch-line of a material (i = material row, j = batch line)
  const setUse = (i: number, j: number, k: keyof MatUse, v: string) => setF(prev => { const m = [...(prev.materials as Mat[])]; const uses = [...m[i].uses]; uses[j] = { ...uses[j], [k]: v }; m[i] = { ...m[i], uses }; return { ...prev, materials: m } })
  const addUse = (i: number) => setF(prev => { const m = [...(prev.materials as Mat[])]; m[i] = { ...m[i], uses: [...m[i].uses, { batch: '', qty: '' }] }; return { ...prev, materials: m } })
  const removeUse = (i: number, j: number) => setF(prev => { const m = [...(prev.materials as Mat[])]; const uses = m[i].uses.filter((_, x) => x !== j); m[i] = { ...m[i], uses: uses.length ? uses : [{ batch: '', qty: '' }] }; return { ...prev, materials: m } })

  const set = (k: string, v: string | boolean) => setF(prev => ({ ...prev, [k]: v }))
  // Auto No. = PR<location digits><line letter>-YYMMDD/<running>, e.g. PR101A-260622/00001
  async function genNo(area: string, dateStr: string) {
    const letter = (packLines.find(p => p.name === area)?.line_code || '').toUpperCase()
    const loc = factoryCode.match(/\d+/)?.[0] || factoryCode
    const d = (dateStr || '').replaceAll('-', '').slice(2)
    if (!letter || !d) return
    const prefix = `PR${loc}${letter}-${d}/`
    const { data } = await supabase.from('inspection_records').select('data').eq('factory_code', factoryCode)
    const used = (data || []).map(r => String((r.data as Record<string, unknown>)?.no || '')).filter(n => n.startsWith(prefix))
    const maxN = used.reduce((m, n) => { const x = parseInt(n.split('/')[1] || '0', 10); return Number.isFinite(x) && x > m ? x : m }, 0)
    setF(prev => ({ ...prev, area_machine: area, no: prefix + String(maxN + 1).padStart(5, '0') }))
  }
  const setHour = (i: number, k: keyof Hourly, v: string) => setF(prev => { const h = [...(prev.hourly as Hourly[])]; h[i] = { ...h[i], [k]: v }; return { ...prev, hourly: h } })
  const addHour = () => setF(prev => ({ ...prev, hourly: [...(prev.hourly as Hourly[]), blankHour()] }))

  async function persist(recQty: number, t: Timer = timer, form: Form = f): Promise<string | null> {
    if (!canEditHere()) { setError("You have view-only access at this factory."); return null }
    if (!profile) return null
    const payload = { production_batch_id: batchId || null, factory_code: factoryCode || profile.factory_code, data: { ...form, recorded_qty: recQty, timer: t }, updated_at: new Date().toISOString() }
    if (recordId) { const { error: e } = await supabase.from('inspection_records').update(payload).eq('id', recordId); if (e) { setError(e.message); return null } return recordId }
    const { data, error: e } = await supabase.from('inspection_records').insert({ ...payload, created_by: profile.id }).select('id').single()
    if (e || !data) { setError(e?.message || 'Save failed'); return null }
    setRecordId(data.id); return data.id
  }
  async function save() { if (!canEditHere()) { setError("You have view-only access at this factory."); return } setBusy(true); setError(''); setSuccess(''); const id = await persist(recordedQty); setBusy(false); if (id) setSuccess('Inspection record saved.') }

  // Production timer — Start / Pause / Resume / Stop. Net run time excludes pauses.
  async function applyTimer(t: Timer, form: Form = f) { setTimer(t); setF(form); await persist(recordedQty, t, form) }
  const startTimer = () => { const iso = new Date().toISOString(); applyTimer({ status: 'running', segments: [{ s: iso, e: null }] }, { ...f, prod_start: iso }) }
  const pauseTimer = () => { const iso = new Date().toISOString(); const segs = timer.segments.map((sg, i) => i === timer.segments.length - 1 && !sg.e ? { ...sg, e: iso } : sg); applyTimer({ status: 'paused', segments: segs }) }
  const resumeTimer = () => { const iso = new Date().toISOString(); applyTimer({ status: 'running', segments: [...timer.segments, { s: iso, e: null }] }) }
  const stopTimer = () => { const iso = new Date().toISOString(); const segs = timer.segments.map((sg, i) => i === timer.segments.length - 1 && !sg.e ? { ...sg, e: iso } : sg); applyTimer({ status: 'stopped', segments: segs }, { ...f, prod_end: iso }) }

  async function recordProductionFromForm() {
    if (!canEditHere()) { setError("You have view-only access at this factory."); return null }
    if (!profile) return
    if (!batchId) { setError('No production batch linked.'); return }
    const qty = Number((f.qty_produced as string) || 0)
    if (!(qty > 0)) { setError('Enter the quantity produced first.'); return }
    const delta = qty - recordedQty
    if (delta <= 0) { setError(`This inspection has already recorded ${recordedQty}. Increase the quantity produced to record more.`); return }
    setRecording(true); setError(''); setSuccess('')
    const id = await persist(qty)
    if (!id) { setRecording(false); return }
    const { data, error: rpcErr } = await supabase.rpc('record_production', { p_batch_id: batchId, p_qty: delta })
    if (rpcErr) { setError(rpcErr.message); await persist(recordedQty); setRecording(false); return }
    const short = (data as { shortfalls?: { item_code: string; short: number }[] })?.shortfalls || []
    setRecordedQty(qty); setProduced(p => p + delta)
    // Food-loss alert to Head Office when over 5% (one open alert per batch)
    if (loss.over && loss.pct != null) {
      const { data: existing } = await supabase.from('food_loss_alerts').select('id').eq('production_batch_id', batchId).eq('status', 'Pending').limit(1)
      if (!existing || existing.length === 0) {
        await supabase.from('food_loss_alerts').insert({ production_batch_id: batchId, factory_code: factoryCode, batch_no: batchNo, item_code: s('code'), pct: Number(loss.pct.toFixed(2)), created_by: profile.id, created_by_name: profile.full_name || null })
      }
    }
    setSuccess(`Recorded ${delta} produced (total ${qty}). Raw materials consumed from stock.` + (short.length ? ` ⚠ Short on: ${short.map(x => `${x.item_code} (${x.short})`).join(', ')}.` : '') + (loss.over ? ` ⚠ Food loss ${loss.pct?.toFixed(2)}% — flagged to Head Office.` : ''))
    setRecording(false)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const s = (k: string) => (f[k] as string) || ''

  const n = (x: number) => Number(Number(x).toFixed(3))
  // Food loss % = ((main ingredient used − main planned) + wastage) ÷ main used × 100. Alert HO when > 5%.
  const loss = (() => {
    const mats = (f.materials as Mat[]) || []
    const main = mats.filter(m => m.main)
    const used = main.reduce((t, m) => t + matTotal(m), 0)
    const planned = main.reduce((t, m) => t + Number(m.planned || 0), 0)
    const waste = Number(s('food_loss_a') || 0)
    if (!(used > 0)) return { pct: null as number | null, over: false }
    const pct = ((used - planned) + waste) / used * 100
    return { pct, over: pct > 5 }
  })()

  return (
    <FormCtx.Provider value={{ s, set }}>
    <div className="min-h-screen bg-gray-50">
      <style>{`@media print { nav, .no-print { display: none !important } body { background: white } .printable { box-shadow: none !important; border: none !important } }`}</style>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 no-print">
          <h1 className="text-2xl font-bold">Packing &amp; Finished Goods Inspection Record <span className="text-gray-400 font-normal text-sm">P07-F01 Ver.06</span></h1>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="border px-4 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium">🖨 Print / PDF</button>
            <button onClick={save} disabled={busy} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3 no-print">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3 no-print">{success}</p>}

        <div className="printable bg-white rounded-xl shadow-sm border p-5 space-y-5">
          <div className="flex items-center justify-between border-b pb-2">
            <div className="font-bold text-lg text-green-700">EASWARI</div>
            <div className="font-semibold text-center">Packing &amp; Finished Goods Inspection Record</div>
            <div className="text-xs text-gray-500 text-right">Ver. 06 · P07-F01<br />Eff. 26.01.2026 · Page 1 of 2</div>
          </div>

          {/* Production run — at the top */}
          {batchId && (
            <div className="border-t pt-3 bg-blue-50/40 -mx-5 px-5 py-3">
              <div className="font-semibold text-sm mb-2">Production run <span className="font-normal text-gray-500">· batch {batchNo}</span></div>
              <div className="mb-3">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {timer.status === 'idle' && <button onClick={startTimer} className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium no-print">▶ Start</button>}
                  {timer.status === 'running' && <>
                    <button onClick={pauseTimer} className="bg-amber-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium no-print">⏸ Pause</button>
                    <button onClick={stopTimer} className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium no-print">⏹ Stop</button>
                  </>}
                  {timer.status === 'paused' && <>
                    <button onClick={resumeTimer} className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium no-print">▶ Resume</button>
                    <button onClick={stopTimer} className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium no-print">⏹ Stop</button>
                  </>}
                  {timer.status === 'stopped' && <button onClick={startTimer} className="border px-4 py-1.5 rounded-lg text-sm no-print">↻ Restart</button>}
                  <TimerClock timer={timer} />
                  <span className={`text-xs px-2 py-0.5 rounded-full ${timer.status === 'running' ? 'bg-green-100 text-green-700' : timer.status === 'paused' ? 'bg-amber-100 text-amber-700' : timer.status === 'stopped' ? 'bg-gray-200 text-gray-700' : 'bg-gray-100 text-gray-500'}`}>{timer.status === 'idle' ? 'not started' : timer.status}</span>
                  {timer.status !== 'idle' && recordId && (
                    <button onClick={async () => { const res = await requestTimerCancel({ table: 'inspection_records', record_id: recordId, timer_key: 'inspection_production', label: `Inspection — production timer (batch ${batchNo})`, factory_code: factoryCode, requested_by_name: profile?.full_name }); if (res === null) return; if (res) setError(res); else alert('Cancellation request sent to Head Office for approval.') }}
                      className="text-orange-600 hover:underline text-xs no-print">Request to cancel</button>
                  )}
                </div>
                <TimerStats timer={timer} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-2">
                <Field label="Quantity produced"><In k="qty_produced" type="number" /></Field>
                <div className="flex items-end">
                  <button onClick={recordProductionFromForm} disabled={recording} className="bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium w-full no-print">{recording ? 'Recording…' : 'Record production'}</button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-gray-600">
                <span>Planned: <strong>{planned}</strong></span>
                <span>Produced so far: <strong className="text-green-700">{produced}</strong></span>
                <span>Backorder: <strong className={planned - produced > 0 ? 'text-red-600' : 'text-green-600'}>{Math.max(0, planned - produced)}</strong></span>
                {recordedQty > 0 && <span className="text-gray-400 no-print">(this record has booked {recordedQty})</span>}
                <span className="text-gray-400 no-print">Recording consumes raw materials (earliest expiry / oldest batch first) from stock.</span>
              </div>
            </div>
          )}

          {/* Header */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t pt-3">
            <Field label="Date">{(() => { const t = new Date(); const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; const notToday = !!s('date') && s('date') !== today; return (<>
              <div className={`border rounded px-3 py-2 text-sm min-h-[2.5rem] ${notToday ? 'bg-red-50 border-red-300 text-red-700' : 'bg-gray-50 text-gray-700'}`}>{s('date') ? s('date').split('-').reverse().join('/') : '—'}</div>
              {notToday && <span className="text-xs text-red-600">⚠ Not today’s date — this is the scheduled pack date. Amend it in Packing Schedule if it’s wrong.</span>}
            </>) })()}</Field>
            <Field label={`Area / Line${batchMode ? ` · ${batchMode} run` : ''}`}><div className="border rounded px-3 py-2 text-sm bg-gray-50 text-gray-700 min-h-[2.5rem]">{s('area_machine') || '—'}</div></Field>
            <Field label="No. (auto)"><div className="border rounded px-3 py-2 text-sm bg-gray-50 text-gray-700 font-mono min-h-[2.5rem]">{s('no') || '—'}</div></Field>
            <Field label="Code"><div className="border rounded px-3 py-2 text-sm bg-gray-50 text-gray-700 min-h-[2.5rem]">{s('code') || '—'}</div></Field>
            <Field label="Product"><div className="border rounded px-3 py-2 text-sm bg-gray-50 text-gray-700 min-h-[2.5rem]">{s('product') || '—'}</div></Field>
            <Field label="Plastic weight (g)"><In k="plastic" type="number" /></Field>
            <Field label="Type of waste"><In k="wastage" /></Field>
            <Field label="Weight of wastage (g)"><In k="food_loss_a" type="number" /></Field>
            <Field label="Food Loss %"><div className={`border rounded px-2 py-1 text-sm ${loss.over ? 'bg-red-50 text-red-700 font-semibold' : 'bg-gray-50 text-gray-700'}`}>{loss.pct == null ? '—' : loss.pct.toFixed(2) + '%'}{loss.over ? ' ⚠' : ''}</div></Field>
          </div>

          {/* Materials used — from the BOM (planned vs actually used) */}
          <div className="border-t pt-3">
            <div className="font-semibold text-sm mb-2">Materials used <span className="font-normal text-gray-400">— from recipe (BOM)</span></div>
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>{['Item', 'Description', 'Unit', 'Planned', 'Batch', 'Qty used', 'Difference', 'Main'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {(f.materials as Mat[]).length === 0 && <tr><td colSpan={8} className="text-center py-4 text-gray-400">No BOM for this product — set up its recipe in BOM.</td></tr>}
                  {(f.materials as Mat[]).map((m, i) => { const total = matTotal(m); const diff = total - m.planned; const blank = m.uses.every(u => u.qty === ''); const lots = stockLots[m.code] || []; return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono font-medium whitespace-nowrap align-top">{m.code}{m.main && <span className="text-amber-600" title="Main ingredient"> ★</span>}</td>
                      <td className="px-3 py-2 text-gray-600 align-top">{m.desc}</td>
                      <td className="px-3 py-2 text-gray-500 align-top">{m.unit}</td>
                      <td className="px-3 py-2 text-right font-medium align-top">{n(m.planned)}</td>
                      <td className="px-3 py-2 align-top">
                        <div className="space-y-1">
                          {m.uses.map((u, j) => lots.length > 0
                            ? <select key={j} value={u.batch} onChange={e => setUse(i, j, 'batch', e.target.value)} className="border rounded px-2 py-1.5 text-sm w-44 bg-white block">
                                <option value="">Choose batch…</option>
                                {lots.map(lt => <option key={lt.batch_no} value={lt.batch_no}>{lt.batch_no} · {n(lt.qty_remaining)} {m.unit}{lt.exp_date ? ` · exp ${lt.exp_date.split('-').reverse().join('/')}` : ''}</option>)}
                              </select>
                            : <input key={j} value={u.batch} onChange={e => setUse(i, j, 'batch', e.target.value)} placeholder="no stock — type" className="border rounded px-2 py-1.5 text-sm w-44 block" />)}
                          <button type="button" onClick={() => addUse(i)} className="text-blue-600 hover:underline text-xs no-print">+ add batch</button>
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="space-y-1">
                          {m.uses.map((u, j) => (
                            <div key={j} className="flex items-center gap-1">
                              <input type="number" step="any" value={u.qty} onChange={e => setUse(i, j, 'qty', e.target.value)} className="border rounded px-2 py-1.5 text-sm w-24 text-right" />
                              {m.uses.length > 1 && <button type="button" onClick={() => removeUse(i, j)} className="text-red-500 text-xs no-print" title="Remove this batch">✕</button>}
                            </div>
                          ))}
                          {m.uses.length > 1 && <div className="text-right text-gray-500 text-xs pr-6">Total {n(total)}</div>}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-right align-top ${blank ? 'text-gray-300' : diff > 0 ? 'text-red-600' : 'text-green-600'}`}>{blank ? '—' : (diff > 0 ? '+' : '') + n(diff)}</td>
                      <td className="px-3 py-2 align-top">{m.main ? '★' : ''}</td>
                    </tr>
                  ) })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Process (CCP #2) */}
          <div className="border-t pt-3">
            <div className="text-xs text-gray-400 mb-1">CCP #2</div>
            <div className="grid grid-cols-2 gap-3 max-w-2xl">
              <Field label="Moisture content %"><In k="moisture_pct" /></Field>
              <Field label="Max %"><In k="moisture_max" /></Field>
              <Field label="Temp (In)"><In k="temp_in" /></Field>
              <Field label="Temp (Out)"><In k="temp_out" /></Field>
              <Field label="Speed (In)"><In k="speed_in" /></Field>
              <Field label="Speed (Out)"><In k="speed_out" /></Field>
            </div>
          </div>

          {/* Sealing integrity */}
          <div className="border-t pt-3">
            <div className="font-semibold text-sm mb-2">Sealing Integrity</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Product weigh, g"><In k="product_weigh" /></Field>
              <Field label="Cond. of aluminium pad seal (bottle)"><In k="alu_pad" /></Field>
            </div>
            {/* 3 samples — one row each, per the manual form */}
            <div className="overflow-x-auto border rounded-lg mt-3">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>{['Sample', 'Printing & expiry date', 'Bubble test', 'Dropping test (Auto / Press)', 'Result'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {[1, 2, 3].map(i => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium whitespace-nowrap">Sample {i}</td>
                      <td className="px-3 py-2"><Radio k={`s${i}_print`} val="clear" label="Clear" /><Radio k={`s${i}_print`} val="unclear" label="Unclear" /></td>
                      <td className="px-3 py-2"><Radio k={`s${i}_bubble`} val="no" label="No bubble" /><Radio k={`s${i}_bubble`} val="rework" label="Bubble (Rework)" /></td>
                      <td className="px-3 py-2"><Radio k={`s${i}_drop`} val="no" label="No broken" /><Radio k={`s${i}_drop`} val="rework" label="Broken (Rework)" /></td>
                      <td className="px-3 py-2"><Radio k={`s${i}_ok`} val="ok" label="Ok" /><Radio k={`s${i}_ok`} val="rework" label="Rework" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Metal detector (OFRP #4) */}
          <div className="border-t pt-3">
            <div className="font-semibold text-sm mb-2">Metal Detector <span className="font-normal text-gray-400">· OFRP #4</span></div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <GoodBad k="md_ferrous" label="Ferrous" />
              <GoodBad k="md_nonferrous" label="Non-Ferrous" />
              <GoodBad k="md_stainless" label="Stainless Steel" />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
              <Field label="Qty Reject"><In k="md_qty_reject" /></Field>
              <Field label="Remark"><In k="md_remark" /></Field>
              <Field label="Action taken for Reject"><In k="md_action" /></Field>
            </div>
          </div>

          {/* Quality check + cleanliness + previous batch */}
          <div className="border-t pt-3">
            <div className="font-semibold text-sm mb-2">Quality Check</div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <GoodBad k="qc_colour" label="Colour" />
              <GoodBad k="qc_odour" label="Odour" />
              <GoodBad k="qc_physical" label="Physical" />
              <GoodBad k="cleanliness" label="Cleanliness" />
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
              <span className="font-medium">Previous batch removed:</span>
              <Radio k="prev_batch_removed" val="yes" label="Yes" /><Radio k="prev_batch_removed" val="no" label="No" />
              <input value={s('prev_batch_remark')} onChange={e => set('prev_batch_remark', e.target.value)} placeholder="Remark" className="border rounded px-2 py-1 text-sm flex-1 min-w-[10rem]" />
            </div>
          </div>

          {/* Sign-offs */}
          <div className="border-t pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Weighed by (bulk pack)"><In k="weighed_by" /></Field>
            <Field label="Done by"><In k="done_by" /></Field>
            <Field label="Checked by"><In k="checked_by" /></Field>
            <Field label="Verified by"><In k="verified_by" /></Field>
            <Field label="Retained Sample">
              <span className="flex items-center gap-2"><span><Radio k="retained" val="yes" label="Yes" /><Radio k="retained" val="no" label="No" /></span><input value={s('retained_qty')} onChange={e => set('retained_qty', e.target.value)} placeholder="Qty" className="border rounded px-2 py-1 text-sm w-20" /></span>
            </Field>
          </div>
          <Field label="Remarks"><textarea value={s('remarks')} onChange={e => set('remarks', e.target.value)} className="border rounded px-2 py-1 text-sm w-full" rows={2} /></Field>

          <div className="text-xs text-gray-400 flex justify-between pt-2 border-t">
            <span>Prepared by: Sn QC Executive</span><span>Approved by: Factory Manager</span>
          </div>
        </div>
      </div>
    </div>
    </FormCtx.Provider>
  )
}
