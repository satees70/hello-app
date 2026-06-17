'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Hourly { time: string; weight: string; ink: string; temp: string; speed: string; bubble: string; drop: string; alu: string; speed_belt: string; fe: string; nonfe: string; ss: string; remarks: string }
type Form = Record<string, string | boolean | Hourly[]>

const blankHour = (): Hourly => ({ time: '', weight: '', ink: '', temp: '', speed: '', bubble: '', drop: '', alu: '', speed_belt: '', fe: '', nonfe: '', ss: '', remarks: '' })
const EMPTY: Form = {
  date: '', area_machine: '', no: '', code: '', product: '',
  prod_start: '', prod_end: '', qty_produced: '',
  bn_raw_material: '', rm_weight_in: '', total_used: '', plastic: '', bn_plastic: '', wastage: '',
  moisture_pct: '', moisture_max: '', temp_in: '', temp_out: '', speed_in: '', speed_out: '', time_in: '', time_out: '',
  printing_clear: false, product_weigh: '', exp_in: '', exp_out: '', bubble: '', broken: '', ok: '',
  sample1: '', sample2: '', sample3: '', alu_pad: '',
  md_ferrous: '', md_nonferrous: '', md_stainless: '', md_qty_pass: '', md_qty_reject: '', md_action: '', speed_belt: '',
  yield_pack: '', yield_bottle: '', yield_balance: '', done_by: '', checked_by: '', verified_by: '',
  retained: '', retained_qty: '', weighed_by: '', remarks: '',
  hourly: [blankHour(), blankHour(), blankHour(), blankHour()],
}

export default function InspectionPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [batchId, setBatchId] = useState('')
  const [recordId, setRecordId] = useState('')
  const [f, setF] = useState<Form>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [factoryCode, setFactoryCode] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [planned, setPlanned] = useState(0)
  const [produced, setProduced] = useState(0)   // total produced on the batch so far
  const [recordedQty, setRecordedQty] = useState(0) // qty already recorded by THIS inspection record
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('batch') || ''
    setBatchId(id)
  }, [])

  useEffect(() => { if (profile && batchId) loadForBatch(batchId) }, [profile, batchId])

  async function loadForBatch(id: string) {
    const { data: batch } = await supabase.from('production_batches').select('batch_no, item_code, description, factory_code, exp_date, total_quantity, produced_qty').eq('id', id).single()
    if (batch) { setFactoryCode(batch.factory_code); setBatchNo(batch.batch_no); setPlanned(Number(batch.total_quantity || 0)); setProduced(Number(batch.produced_qty || 0)) }
    // existing inspection record for this batch?
    const { data: rec } = await supabase.from('inspection_records').select('*').eq('production_batch_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (rec) {
      setRecordId(rec.id)
      const d = rec.data as Record<string, unknown>
      setRecordedQty(Number(d.recorded_qty || 0))
      setF({ ...EMPTY, ...(d as Form) })
      return
    }
    // new — prefill from the batch + the raw-material batches we consumed
    const { data: cons } = await supabase.from('production_consumption').select('batch_no').eq('production_batch_id', id)
    const rmBatches = [...new Set((cons || []).map(c => c.batch_no).filter(Boolean))].join(', ')
    setF({
      ...EMPTY,
      date: new Date().toISOString().slice(0, 10),
      code: batch?.item_code || '', product: batch?.description || '',
      bn_raw_material: rmBatches,
      exp_in: batch?.exp_date || '', exp_out: batch?.exp_date || '',
    })
  }

  const set = (k: string, v: string | boolean) => setF(prev => ({ ...prev, [k]: v }))
  const setHour = (i: number, k: keyof Hourly, v: string) => setF(prev => {
    const h = [...(prev.hourly as Hourly[])]; h[i] = { ...h[i], [k]: v }; return { ...prev, hourly: h }
  })
  const addHour = () => setF(prev => ({ ...prev, hourly: [...(prev.hourly as Hourly[]), blankHour()] }))

  // Save the form (incl. recorded_qty); returns the record id
  async function persist(recQty: number): Promise<string | null> {
    if (!profile) return null
    const payload = { production_batch_id: batchId || null, factory_code: factoryCode || profile.factory_code, data: { ...f, recorded_qty: recQty }, updated_at: new Date().toISOString() }
    if (recordId) { const { error: e } = await supabase.from('inspection_records').update(payload).eq('id', recordId); if (e) { setError(e.message); return null } return recordId }
    const { data, error: e } = await supabase.from('inspection_records').insert({ ...payload, created_by: profile.id }).select('id').single()
    if (e || !data) { setError(e?.message || 'Save failed'); return null }
    setRecordId(data.id); return data.id
  }

  async function save() {
    setBusy(true); setError(''); setSuccess('')
    const id = await persist(recordedQty)
    setBusy(false); if (id) setSuccess('Inspection record saved.')
  }

  // Record production into stock from the inspection's "quantity produced" — consumes raw materials (FEFO).
  // Records the delta vs what this inspection already booked, so pressing again only books the new amount.
  async function recordProductionFromForm() {
    if (!batchId) { setError('No production batch linked.'); return }
    const qty = Number(s('qty_produced') || 0)
    if (!(qty > 0)) { setError('Enter the quantity produced first.'); return }
    const delta = qty - recordedQty
    if (delta <= 0) { setError(`This inspection has already recorded ${recordedQty}. Increase the quantity produced to record more.`); return }
    setRecording(true); setError(''); setSuccess('')
    const id = await persist(qty)
    if (!id) { setRecording(false); return }
    const { data, error: rpcErr } = await supabase.rpc('record_production', { p_batch_id: batchId, p_qty: delta })
    if (rpcErr) { setError(rpcErr.message); await persist(recordedQty); setRecording(false); return } // roll the stored qty back on failure
    const short = (data as { shortfalls?: { item_code: string; short: number }[] })?.shortfalls || []
    setRecordedQty(qty); setProduced(p => p + delta)
    setSuccess(`Recorded ${delta} produced (total ${qty}). Raw materials consumed from stock.`
      + (short.length ? ` ⚠ Short on: ${short.map(x => `${x.item_code} (${x.short})`).join(', ')}.` : ''))
    setRecording(false)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const s = (k: string) => (f[k] as string) || ''
  const b = (k: string) => f[k] as boolean
  const In = ({ k, type = 'text', cls = '' }: { k: string; type?: string; cls?: string }) =>
    <input type={type} value={s(k)} onChange={e => set(k, e.target.value)} className={`border rounded px-2 py-1 text-sm ${cls}`} />
  const Radio = ({ k, val, label }: { k: string; val: string; label: string }) =>
    <label className="inline-flex items-center gap-1 text-xs cursor-pointer mr-3">
      <input type="checkbox" checked={s(k) === val} onChange={() => set(k, s(k) === val ? '' : val)} className="h-3.5 w-3.5" />{label}
    </label>
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) =>
    <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">{label}</span>{children}</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <style>{`@media print { nav, .no-print { display: none !important } body { background: white } .printable { box-shadow: none !important; border: none !important } }`}</style>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 no-print">
          <h1 className="text-2xl font-bold">Packing &amp; Finished Good Inspection Record <span className="text-gray-400 font-normal text-sm">P07-F01</span></h1>
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
            <div className="font-semibold text-center">Packing &amp; Finished Good Inspection Record</div>
            <div className="text-xs text-gray-500 text-right">Ver. 3 · P07-F01<br />Eff. 01.02.2024</div>
          </div>

          {/* Header */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Date"><In k="date" type="date" /></Field>
            <Field label="Area / Machine"><In k="area_machine" /></Field>
            <Field label="No."><In k="no" /></Field>
            <Field label="Code"><In k="code" /></Field>
            <Field label="Product"><In k="product" cls="sm:col-span-1" /></Field>
            <Field label="B/N Raw Material"><In k="bn_raw_material" /></Field>
            <Field label="RM Weight (In)"><In k="rm_weight_in" /></Field>
            <Field label="Total Used"><In k="total_used" /></Field>
            <Field label="Plastic name, size & weight"><In k="plastic" /></Field>
            <Field label="B/N Plastic"><In k="bn_plastic" /></Field>
            <Field label="Weigh of wastage & type"><In k="wastage" /></Field>
          </div>

          {/* Production run — start/end + quantity produced (drives stock consumption) */}
          {batchId && (
            <div className="border-t pt-3 bg-blue-50/40 -mx-5 px-5 py-3">
              <div className="font-semibold text-sm mb-2">Production run <span className="font-normal text-gray-500">· batch {batchNo}</span></div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
                <Field label="Production start"><In k="prod_start" type="datetime-local" /></Field>
                <Field label="Production end"><In k="prod_end" type="datetime-local" /></Field>
                <Field label="Quantity produced"><In k="qty_produced" type="number" /></Field>
                <div className="flex items-end">
                  <button onClick={recordProductionFromForm} disabled={recording} className="bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium w-full no-print">
                    {recording ? 'Recording…' : 'Record production'}
                  </button>
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

          {/* Process */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t pt-3">
            <Field label="Moisture content %"><In k="moisture_pct" /></Field>
            <Field label="Max %"><In k="moisture_max" /></Field>
            <div /><div />
            <Field label="Temp (In)"><In k="temp_in" /></Field>
            <Field label="Temp (Out)"><In k="temp_out" /></Field>
            <Field label="Speed (In)"><In k="speed_in" /></Field>
            <Field label="Speed (Out)"><In k="speed_out" /></Field>
            <Field label="Time (In)"><In k="time_in" /></Field>
            <Field label="Time (Out)"><In k="time_out" /></Field>
          </div>

          {/* Sealing integrity */}
          <div className="border-t pt-3">
            <div className="font-semibold text-sm mb-2">Sealing Integrity</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Exp date (In)"><In k="exp_in" type="date" /></Field>
              <Field label="Exp date (Out)"><In k="exp_out" type="date" /></Field>
              <Field label="Product weigh, g"><In k="product_weigh" /></Field>
              <Field label="Cond. of aluminium pad seal (bottle)"><In k="alu_pad" /></Field>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3">
              <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={b('printing_clear')} onChange={e => set('printing_clear', e.target.checked)} className="h-3.5 w-3.5" /> Printing &amp; expiry date clear &amp; permanent</label>
              <span className="text-xs"><span className="font-medium">Bubble test:</span> <Radio k="bubble" val="no" label="No bubble" /><Radio k="bubble" val="rework" label="Bubble (Rework)" /></span>
              <span className="text-xs"><span className="font-medium">Dropping test (Auto):</span> <Radio k="broken" val="no" label="No broken" /><Radio k="broken" val="rework" label="Broken (Rework)" /></span>
              <span className="text-xs"><Radio k="ok" val="ok" label="Ok" /><Radio k="ok" val="rework" label="Rework" /></span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-2">
              {['sample1', 'sample2', 'sample3'].map((k, i) => (
                <span key={k} className="text-xs"><span className="font-medium">Sample {i + 1}:</span> <Radio k={k} val="clear" label="Clear" /><Radio k={k} val="unclear" label="Unclear" /></span>
              ))}
            </div>
          </div>

          {/* Metal detector */}
          <div className="border-t pt-3">
            <div className="font-semibold text-sm mb-2">Metal Detector</div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <span className="text-xs"><span className="font-medium">Ferrous:</span> <Radio k="md_ferrous" val="good" label="Good" /><Radio k="md_ferrous" val="notgood" label="Not good" /></span>
              <span className="text-xs"><span className="font-medium">Non-Ferrous:</span> <Radio k="md_nonferrous" val="good" label="Good" /><Radio k="md_nonferrous" val="notgood" label="Not good" /></span>
              <span className="text-xs"><span className="font-medium">Stainless Steel:</span> <Radio k="md_stainless" val="good" label="Good" /><Radio k="md_stainless" val="notgood" label="Not good" /></span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              <Field label="Qty Pass"><In k="md_qty_pass" /></Field>
              <Field label="Qty Reject"><In k="md_qty_reject" /></Field>
              <Field label="Speed Belt"><In k="speed_belt" /></Field>
              <Field label="Action taken for Reject"><In k="md_action" /></Field>
            </div>
          </div>

          {/* Yield + sign-offs */}
          <div className="border-t pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Out / Yield — Pack"><In k="yield_pack" /></Field>
            <Field label="Bottle"><In k="yield_bottle" /></Field>
            <Field label="Balance"><In k="yield_balance" /></Field>
            <Field label="Weighed by (bulk pack)"><In k="weighed_by" /></Field>
            <Field label="Done by"><In k="done_by" /></Field>
            <Field label="Checked by"><In k="checked_by" /></Field>
            <Field label="Verified by"><In k="verified_by" /></Field>
            <Field label="Retained Sample">
              <span className="flex items-center gap-2"><span><Radio k="retained" val="yes" label="Yes" /><Radio k="retained" val="no" label="No" /></span><input value={s('retained_qty')} onChange={e => set('retained_qty', e.target.value)} placeholder="Qty" className="border rounded px-2 py-1 text-sm w-20" /></span>
            </Field>
          </div>
          <Field label="Remarks"><textarea value={s('remarks')} onChange={e => set('remarks', e.target.value)} className="border rounded px-2 py-1 text-sm w-full" rows={2} /></Field>

          {/* Hourly checking log (form b) */}
          <div className="border-t pt-3">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold text-sm">Hourly Checking <span className="font-normal text-gray-400">(metal detector every 4 hours)</span></div>
              <button onClick={addHour} className="text-blue-600 hover:underline text-xs no-print">+ Add row</button>
            </div>
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>{['Time', 'Weight', 'Ink', 'Temp °C', 'Speed', 'Bubble', 'Drop (Auto)', 'Al pad (bottle)', 'Speed belt', 'Fe', 'Non-Fe', 'SS', 'Remarks / Action'].map(h => (
                    <th key={h} className="px-2 py-1.5 font-medium text-gray-600 text-left whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {(f.hourly as Hourly[]).map((h, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {(['time', 'weight', 'ink', 'temp', 'speed', 'bubble', 'drop', 'alu', 'speed_belt'] as (keyof Hourly)[]).map(k => (
                        <td key={k} className="px-1 py-1"><input value={h[k]} onChange={e => setHour(i, k, e.target.value)} className="border rounded px-1 py-0.5 w-16 text-xs" /></td>
                      ))}
                      {(['fe', 'nonfe', 'ss'] as (keyof Hourly)[]).map(k => (
                        <td key={k} className="px-1 py-1"><select value={h[k]} onChange={e => setHour(i, k, e.target.value)} className="border rounded px-1 py-0.5 text-xs"><option value="">—</option><option value="G">G</option><option value="NG">NG</option></select></td>
                      ))}
                      <td className="px-1 py-1"><input value={h.remarks} onChange={e => setHour(i, 'remarks', e.target.value)} className="border rounded px-1 py-0.5 w-32 text-xs" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="text-xs text-gray-400 flex justify-between pt-2 border-t">
            <span>Prepared by: Sn QC Executive</span><span>Approved by: Factory Manager</span>
          </div>
        </div>
      </div>
    </div>
  )
}
