'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface MRItem {
  id: string
  item_code: string
  description: string
  unit: string
  required_qty: number
  stock_qty: number
  shortfall_qty: number
  requested_qty: number
  received_qty: number
}
interface MaterialRequest {
  id: string
  request_no: string
  factory_code: string
  status: string
  created_at: string
  released_at: string | null
  pick_run_no: string | null
  batch_id: string
  production_batches: { batch_no: string; item_code: string; description: string; exp_date: string | null } | null
  material_request_items: MRItem[]
}

const FILTERS = ['Open', 'Partially Received', 'Fulfilled', 'All', 'Combined picking'] as const
type Filter = typeof FILTERS[number]

// Statuses that still need picking — pooled into the combined list
const ACTIVE = ['Open', 'Partially Received']

const STATUS_STYLE: Record<string, string> = {
  Open: 'bg-amber-100 text-amber-700',
  'Partially Received': 'bg-blue-100 text-blue-700',
  Fulfilled: 'bg-green-100 text-green-700',
}

// Inline control to record one received delivery: quantity + batch no + expiry date
function ReceiveControl({ disabled, onReceive }: { disabled: boolean; onReceive: (qty: number, batch: string, exp: string) => Promise<boolean> }) {
  const [qty, setQty] = useState('')
  const [batch, setBatch] = useState('')
  const [exp, setExp] = useState('')
  return (
    <div className="flex items-center gap-1">
      <input type="number" step="any" min="0" placeholder="qty" value={qty} onChange={e => setQty(e.target.value)} className="w-16 border rounded px-2 py-1 text-right text-xs" />
      <input placeholder="batch #" value={batch} onChange={e => setBatch(e.target.value)} className="w-24 border rounded px-2 py-1 text-xs" />
      <input type="date" min="2020-01-01" max="2100-12-31" value={exp} onChange={e => setExp(e.target.value)} className="border rounded px-2 py-1 text-xs" title="Expiry date of the received batch" />
      <button disabled={disabled} onClick={async () => { const ok = await onReceive(Number(qty || 0), batch.trim(), exp); if (ok) { setQty(''); setBatch(''); setExp('') } }}
        className="bg-blue-600 text-white px-3 py-1 rounded text-xs disabled:opacity-50 whitespace-nowrap">Receive</button>
    </div>
  )
}

export default function MaterialRequestsPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [requests, setRequests] = useState<MaterialRequest[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<Filter>('Open')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [factoryItems, setFactoryItems] = useState<Set<string>>(new Set()) // item codes supplied by the factory
  const [expEdits, setExpEdits] = useState<Record<string, string>>({}) // request id -> EXP date being typed

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories(); loadFactoryItems() } }, [profile])

  async function load() {
    const { data } = await supabase
      .from('material_requests')
      .select('*, production_batches!batch_id(batch_no, item_code, description, exp_date), material_request_items(*)')
      .order('created_at', { ascending: false })
    setRequests((data as MaterialRequest[]) || [])
  }
  async function loadFactoryItems() {
    const { data } = await supabase.from('items').select('code').eq('supplied_by_factory', true)
    setFactoryItems(new Set((data || []).map(r => r.code)))
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'
  // Show stored dates (YYYY-MM-DD) as DD/MM/YYYY
  const fmtExp = (d: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '')
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || '')
  }

  const validExp = (exp: string) => !exp || (/^\d{4}-\d{2}-\d{2}$/.test(exp) && exp >= '2020-01-01' && exp <= '2100-12-31')

  // Record one received delivery against a single request line: makes a stock lot,
  // bumps the factory's stock, and updates the request (Open → Partially Received → Fulfilled).
  async function doReceiveItem(item: MRItem, qty: number, batch: string, exp: string): Promise<boolean> {
    if (!(qty > 0)) { setError('Enter a received quantity greater than zero.'); return false }
    if (!validExp(exp)) { setError('Enter a valid expiry date (year 2020–2100) or leave it blank.'); return false }
    setBusy(item.id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('receive_material_lot', { p_item_id: item.id, p_qty: qty, p_batch_no: batch || null, p_exp_date: exp || null })
    if (e) { setError(e.message); setBusy(''); return false }
    setSuccess(`Received ${qty} ${item.item_code} into stock.`); setBusy(''); load(); return true
  }

  // Combined warehouse receiving: one physical delivery (one lot) split across the underlying lines.
  async function doReceiveCombined(key: string, items: { id: string }[], qty: number, batch: string, exp: string): Promise<boolean> {
    if (!(qty > 0)) { setError('Enter a received quantity greater than zero.'); return false }
    if (!validExp(exp)) { setError('Enter a valid expiry date (year 2020–2100) or leave it blank.'); return false }
    setBusy(key); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('receive_combined_lot', { p_item_ids: items.map(i => i.id), p_qty: qty, p_batch_no: batch || null, p_exp_date: exp || null })
    if (e) { setError(e.message); setBusy(''); return false }
    setSuccess(`Received ${qty} into stock and applied to the request(s).`); setBusy(''); load(); return true
  }

  // Release the waiting (unreleased) requests of a factory to the warehouse as one pick run,
  // stamping them with the same released_at so they group together and stop growing.
  async function release(factory: string) {
    const key = `release|${factory}`
    setBusy(key); setError(''); setSuccess('')
    const { data, error: relErr } = await supabase.rpc('release_pick_run', { p_factory: factory })
    if (relErr) { setError(relErr.message); setBusy(''); return }
    setSuccess(`Released to the warehouse as pick run ${data}.`)
    setBusy('')
    load()
  }

  // Save an expiry date entered inline on the factory list (writes to the product's batch)
  async function saveExp(r: MaterialRequest) {
    const val = expEdits[r.id] ?? r.production_batches?.exp_date ?? ''
    if (!val) { setError('Pick an expiry date first.'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || val < '2020-01-01' || val > '2100-12-31') {
      setError('Enter a valid expiry date (year between 2020 and 2100).'); return
    }
    setBusy(`exp|${r.id}`); setError(''); setSuccess('')
    const { error: upErr } = await supabase.from('production_batches').update({ exp_date: val }).eq('id', r.batch_id)
    if (upErr) { setError(upErr.message); setBusy(''); return }
    setSuccess(`Expiry date saved for ${r.production_batches?.item_code}.`)
    setBusy('')
    setExpEdits(prev => { const n = { ...prev }; delete n[r.id]; return n })
    load()
  }


  // Build a printable Material Picking List PDF for a released run, and download it
  async function downloadPickRunPdf(runNo: string, factory: string, released_at: string, mats: MatMap, audience: string) {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const list = Object.values(mats).sort((a, b) => a.code.localeCompare(b.code))
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN BHD', 14, 16)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal')
    doc.text(`Material List — for ${audience}`, 14, 23)
    doc.setFontSize(10)
    doc.text(`Pick run: ${runNo}`, 14, 32)
    doc.text(`Factory: ${factoryName(factory)} (${factory})`, 14, 38)
    doc.text(`Released: ${new Date(released_at).toLocaleString()}`, 14, 44)
    doc.text(`Printed: ${new Date().toLocaleString()}`, 120, 44)
    autoTable(doc, {
      startY: 50,
      head: [['#', 'Material', 'Description', 'Unit', 'Qty to pick', 'Picked', 'Remarks']],
      body: list.map((g, i) => [String(i + 1), g.code, g.description, g.unit, String(g.requested), '', '']),
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [37, 99, 235] },
      columnStyles: { 4: { halign: 'right' } },
    })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 16
    doc.text('Picked by: ____________________   Date: __________', 14, endY)
    doc.text('Received by: ___________________   Date: __________', 14, endY + 10)
    doc.save(`PickRun_${runNo.replace(/\//g, '-')}_${factory}_${audience}.pdf`)
  }

  // Factory (label) list PDF: one row per product so labels carry the product name + expiry date (not combined)
  async function downloadFactoryPdf(runNo: string, factory: string, released_at: string, reqs: MaterialRequest[]) {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const docNo = `L${runNo}`
    const doc = new jsPDF({ orientation: 'landscape' })
    const body: string[][] = []
    let n = 1
    reqs.forEach(r => {
      (r.material_request_items || []).filter(it => factoryItems.has(it.item_code)).forEach(it => {
        body.push([String(n++), r.production_batches?.item_code || '', r.production_batches?.description || '',
          fmtExp(r.production_batches?.exp_date) || '—', it.item_code, it.description, it.unit, String(it.requested_qty), ''])
      })
    })
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN BHD', 14, 16)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal')
    doc.text('Label Request — for Factory', 14, 23)
    doc.setFontSize(10)
    doc.text(`Document: ${docNo}`, 14, 32)
    doc.text(`Factory: ${factoryName(factory)} (${factory})`, 14, 38)
    doc.text(`Released: ${new Date(released_at).toLocaleString()}`, 150, 32)
    doc.text(`Printed: ${new Date().toLocaleString()}`, 150, 38)
    autoTable(doc, {
      startY: 44,
      head: [['#', 'Product', 'Product name', 'EXP date', 'Material', 'Description', 'Unit', 'Qty to make', 'Made']],
      body,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [126, 58, 242] },
      columnStyles: { 7: { halign: 'right' } },
    })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 16
    doc.text('Prepared by: __________________   Date: __________', 14, endY)
    doc.text('Received by: ___________________   Date: __________', 14, endY + 10)
    doc.save(`${docNo.replace(/\//g, '-')}_${factory}.pdf`)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' || filter === 'Combined picking' ? requests : requests.filter(r => r.status === filter)
  const counts: Record<string, number> = { Open: 0, 'Partially Received': 0, Fulfilled: 0 }
  requests.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })

  // Pool active requests by material, summing quantities. Underlying request lines stay
  // intact. Unreleased requests sit in a per-factory "waiting" pool until released; once
  // released they form a frozen pick run (grouped by factory + released_at) the warehouse picks.
  interface CombMat { code: string; description: string; unit: string; requested: number; received: number; items: { id: string; requested_qty: number; received_qty: number }[] }
  type MatMap = Record<string, CombMat>
  const addItem = (mats: MatMap, it: MRItem) => {
    const g = (mats[it.item_code] = mats[it.item_code] || { code: it.item_code, description: it.description, unit: it.unit, requested: 0, received: 0, items: [] })
    g.requested += Number(it.requested_qty)
    g.received += Number(it.received_qty)
    g.items.push({ id: it.id, requested_qty: Number(it.requested_qty), received_qty: Number(it.received_qty) })
  }
  const waiting: Record<string, MatMap> = {}                                  // factory -> materials not yet released
  const runs: Record<string, { runNo: string; factory: string; released_at: string; mats: MatMap; reqs: MaterialRequest[] }> = {} // run id -> run
  requests.filter(r => ACTIVE.includes(r.status)).forEach(r => {
    const runId = r.pick_run_no || (r.released_at ? `${r.factory_code}|${r.released_at}` : '')
    if (r.released_at) {
      const run = (runs[runId] = runs[runId] || { runNo: r.pick_run_no || '(unnumbered)', factory: r.factory_code, released_at: r.released_at, mats: {}, reqs: [] })
      run.reqs.push(r)
      r.material_request_items?.forEach(it => addItem(run.mats, it))
    } else {
      const target = (waiting[r.factory_code] = waiting[r.factory_code] || {})
      r.material_request_items?.forEach(it => addItem(target, it))
    }
  })
  // Oldest request first for allocation: requests arrive newest-first, so reverse the pooled lines
  const allMaps = [...Object.values(waiting), ...Object.values(runs).map(run => run.mats)]
  allMaps.forEach(mats => Object.values(mats).forEach(g => g.items.reverse()))
  const waitingFactories = Object.keys(waiting).sort()
  const runList = Object.values(runs).sort((a, b) => b.released_at.localeCompare(a.released_at) || a.factory.localeCompare(b.factory))
  const hasCombined = waitingFactories.length > 0 || runList.length > 0

  // Split a material pool into warehouse-picked vs factory-supplied (e.g. printed labels)
  const splitBySource = (mats: MatMap) => {
    const warehouse: MatMap = {}, factory: MatMap = {}
    Object.entries(mats).forEach(([code, g]) => { (factoryItems.has(code) ? factory : warehouse)[code] = g })
    return { warehouse, factory }
  }

  // One material table; editable=true adds the Received/Remaining columns + receiving (released runs only)
  const renderMatTable = (mats: MatMap, prefix: string, editable: boolean) => {
    const list = Object.values(mats).sort((a, b) => a.code.localeCompare(b.code))
    const heads = ['Material', 'Description', 'Unit', 'To pick', ...(editable ? ['Received', 'Remaining', 'Add received (qty · batch · expiry)'] : [])]
    return (
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>{heads.map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
          </thead>
          <tbody>
            {list.map(g => {
              const key = `${prefix}|${g.code}`
              const remaining = Math.max(0, g.requested - g.received)
              const done = g.received >= g.requested
              return (
                <tr key={key} className={`border-b last:border-0 ${editable && done ? 'bg-green-50/40' : ''}`}>
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{g.code}</td>
                  <td className="px-3 py-2 text-gray-600">{g.description}</td>
                  <td className="px-3 py-2 text-gray-500">{g.unit}</td>
                  <td className="px-3 py-2 text-right font-semibold text-blue-700">{g.requested}</td>
                  {editable && <>
                    <td className="px-3 py-2 text-right text-gray-700">{g.received}</td>
                    <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{remaining}</td>
                    <td className="px-3 py-2">
                      <ReceiveControl disabled={busy === key} onReceive={(q, b, e) => doReceiveCombined(key, g.items, q, b, e)} />
                    </td>
                  </>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Material Requests</h1>
        <p className="text-gray-500 text-sm mb-5">
          Shortfall materials requested from the warehouse.
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>
        <p className="text-gray-400 text-xs mb-5 -mt-3">Open requests refresh automatically when the BOM or stock changes. Once you start recording received quantities, the request is frozen. To receive a whole Delivery Order at once, use the <strong>Goods Received</strong> tab.</p>

        <div className="flex gap-2 mb-5">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {filter === 'Combined picking' ? (
          !hasCombined ? (
            <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
              Nothing to pick — no open requests.
              <br />Raise material requests from batches on the Production board.
            </div>
          ) : (
            <div className="space-y-8">
              {waitingFactories.length > 0 && (
                <div>
                  <h2 className="font-semibold text-gray-800 mb-1">⏳ Waiting to release</h2>
                  <p className="text-gray-500 text-sm mb-3">
                    New requests collect here. When ready, <strong>Release to warehouse</strong> to send a fixed pick run —
                    anything raised afterwards waits for the next release, so the warehouse always has a clear cut-off.
                  </p>
                  <div className="space-y-4">
                    {waitingFactories.map(fac => (
                      <div key={fac} className="bg-white rounded-xl shadow-sm border p-5">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="font-semibold">{isHO ? factoryName(fac) : fac}</span>
                          <span className="text-sm text-gray-400">· {Object.keys(waiting[fac]).length} material(s) waiting</span>
                          <button onClick={() => release(fac)} disabled={busy === `release|${fac}`}
                            className="ml-auto bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
                            {busy === `release|${fac}` ? 'Releasing…' : 'Release to warehouse →'}
                          </button>
                        </div>
                        {renderMatTable(waiting[fac], `wait|${fac}`, false)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {runList.length > 0 && (
                <div>
                  <h2 className="font-semibold text-gray-800 mb-1">📦 Released pick runs</h2>
                  <p className="text-gray-500 text-sm mb-3">
                    Pick each run's totals in one trip. Type the <strong>total received</strong> for a material —
                    it is split back across the original requests automatically.
                  </p>
                  <div className="space-y-4">
                    {runList.map(run => {
                      const rkey = run.runNo
                      const { warehouse } = splitBySource(run.mats)
                      const facReqs = run.reqs.filter(r => (r.material_request_items || []).some(it => factoryItems.has(it.item_code)))
                      return (
                        <div key={rkey} className="bg-white rounded-xl shadow-sm border p-5">
                          <div className="flex flex-wrap items-center gap-3 mb-4">
                            <span className="font-semibold">{isHO ? factoryName(run.factory) : run.factory}</span>
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700 font-mono">{run.runNo}</span>
                            <span className="text-sm text-gray-400">released {new Date(run.released_at).toLocaleString()}</span>
                          </div>
                          {Object.keys(warehouse).length > 0 && (
                            <div className="mb-5">
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-sm font-semibold text-gray-700">📦 From warehouse</span>
                                <button onClick={() => downloadPickRunPdf(run.runNo, run.factory, run.released_at, warehouse, 'Warehouse')}
                                  className="ml-auto border border-blue-600 text-blue-600 px-3 py-1 rounded-lg hover:bg-blue-50 text-xs font-medium">⬇ Warehouse PDF</button>
                              </div>
                              {renderMatTable(warehouse, `${rkey}|wh`, true)}
                            </div>
                          )}
                          {facReqs.length > 0 && (() => {
                            const missingExp = facReqs.some(r => !r.production_batches?.exp_date)
                            return (
                            <div>
                              <div className="flex flex-wrap items-center gap-2 mb-2">
                                <span className="text-sm font-semibold text-purple-700">🏭 Made at factory <span className="font-normal text-gray-400">— per product (not combined)</span></span>
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 font-mono">L{run.runNo}</span>
                                <button onClick={() => downloadFactoryPdf(run.runNo, run.factory, run.released_at, facReqs)}
                                  className="ml-auto border border-purple-600 text-purple-600 px-3 py-1 rounded-lg hover:bg-purple-50 text-xs font-medium">⬇ Factory PDF</button>
                              </div>
                              {missingExp && (
                                <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg p-2 mb-2">
                                  ⚠ Some products have no expiry date. Enter it below before sending the labels to the factory.
                                </p>
                              )}
                              <div className="space-y-3">
                                {facReqs.map(r => {
                                  const facItems = (r.material_request_items || []).filter(it => factoryItems.has(it.item_code))
                                  const hasExp = !!r.production_batches?.exp_date
                                  return (
                                    <div key={r.id} className={`border rounded-lg p-3 ${hasExp ? '' : 'border-red-300'}`}>
                                      <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
                                        <span className="font-semibold">{r.production_batches?.item_code}</span>
                                        <span className="text-gray-500">{r.production_batches?.description}</span>
                                        <span className="flex items-center gap-1 ml-1">
                                          <span className={`text-xs font-medium ${hasExp ? 'text-gray-500' : 'text-red-600'}`}>EXP</span>
                                          <input type="date" min="2020-01-01" max="2100-12-31"
                                            value={expEdits[r.id] ?? r.production_batches?.exp_date ?? ''}
                                            onChange={e => setExpEdits(prev => ({ ...prev, [r.id]: e.target.value }))}
                                            className={`border rounded px-2 py-1 text-xs ${hasExp ? '' : 'border-red-400 bg-red-50'}`} />
                                          <button onClick={() => saveExp(r)} disabled={busy === `exp|${r.id}`}
                                            className="text-blue-600 hover:underline text-xs disabled:opacity-50">Save</button>
                                          {hasExp && <span className="text-gray-400 text-xs">({fmtExp(r.production_batches?.exp_date)})</span>}
                                        </span>
                                        <span className="text-gray-400 text-xs font-mono ml-auto">{r.request_no}</span>
                                      </div>
                                      <div className="overflow-x-auto border rounded-lg">
                                        <table className="w-full text-sm">
                                          <thead className="bg-gray-50 border-b">
                                            <tr>{['Material', 'Description', 'Unit', 'To make', 'Made', 'Remaining', 'Add received (qty · batch · expiry)'].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
                                          </thead>
                                          <tbody>
                                            {facItems.map(it => {
                                              const done = it.received_qty >= it.requested_qty
                                              const remaining = Math.max(0, it.requested_qty - it.received_qty)
                                              return (
                                                <tr key={it.id} className={`border-b last:border-0 ${done ? 'bg-green-50/40' : ''}`}>
                                                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{it.item_code}</td>
                                                  <td className="px-3 py-2 text-gray-600">{it.description}</td>
                                                  <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                                                  <td className="px-3 py-2 text-right font-semibold text-purple-700">{it.requested_qty}</td>
                                                  <td className="px-3 py-2 text-right text-gray-700">{it.received_qty}</td>
                                                  <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{remaining}</td>
                                                  <td className="px-3 py-2">
                                                    <ReceiveControl disabled={busy === it.id} onReceive={(q, b, e) => doReceiveItem(it, q, b, e)} />
                                                  </td>
                                                </tr>
                                              )
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ) })()}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        ) : shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No {filter !== 'All' ? filter.toLowerCase() : ''} material requests.
            <br />Raise one from a batch on the Production board.
          </div>
        ) : (
          <div className="space-y-5">
            {shown.map(r => (
              <div key={r.id} className="bg-white rounded-xl shadow-sm border p-5">
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <span className="font-mono font-semibold">{r.request_no}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status}</span>
                  <span className="text-sm text-gray-500">
                    Batch <span className="font-mono">{r.production_batches?.batch_no}</span> · {r.production_batches?.item_code}
                  </span>
                  <span className="text-sm text-gray-500">· {isHO ? factoryName(r.factory_code) : r.factory_code}</span>
                  <span className="text-sm text-gray-400 ml-auto">{new Date(r.created_at).toLocaleString()}</span>
                </div>

                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>{['Material', 'Description', 'Unit', 'Requested', 'Received', 'Remaining', 'Add received (qty · batch · expiry)'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {r.material_request_items?.map(it => {
                        const done = it.received_qty >= it.requested_qty
                        const remaining = Math.max(0, it.requested_qty - it.received_qty)
                        return (
                          <tr key={it.id} className={`border-b last:border-0 ${done ? 'bg-green-50/40' : ''}`}>
                            <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{it.item_code}</td>
                            <td className="px-3 py-2 text-gray-600">{it.description}</td>
                            <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                            <td className="px-3 py-2 text-right font-semibold text-blue-700">{it.requested_qty}</td>
                            <td className="px-3 py-2 text-right text-gray-700">{it.received_qty}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{remaining}</td>
                            <td className="px-3 py-2">
                              <ReceiveControl disabled={busy === it.id} onReceive={(q, b, e) => doReceiveItem(it, q, b, e)} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
