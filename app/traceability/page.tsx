'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'

// A produced finished batch (what the recall report is run against).
interface Batch {
  id: string
  batch_no: string
  item_code: string
  description: string | null
  factory_code: string
  produced_qty: number
  total_quantity: number
  exp_date: string | null
  status: string | null
  pack_date: string | null
}

// One raw-material consumption row logged when production was recorded.
interface Consumption {
  production_batch_id: string
  lot_id: string | null
  item_id: string | null
  item_code: string
  description: string | null
  batch_no: string | null
  exp_date: string | null
  qty_consumed: number
}

// A raw-material line on the report (one per lot / item+batch, summed across runs).
interface RmLine {
  key: string
  item_code: string
  description: string | null
  batch_no: string | null
  exp_date: string | null
  qty_consumed: number
  do_number: string | null
  received_at: string | null
}

// Another finished batch affected by the same raw material (recall scope).
interface Affected {
  batch: Batch
  shared: { item_code: string; batch_no: string | null; qty_consumed: number }[]
}

export default function TraceabilityPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'traceability')
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('')

  const [selected, setSelected] = useState<Batch | null>(null)
  const [qc, setQc] = useState<Record<string, unknown> | null>(null)
  const [rmLines, setRmLines] = useState<RmLine[]>([])
  const [affected, setAffected] = useState<Affected[]>([])
  const [busy, setBusy] = useState(false)

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  async function loadBatches() {
    const { data } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, produced_qty, total_quantity, exp_date, status, pack_date')
      .gt('produced_qty', 0)
      .order('batch_no', { ascending: false })
    setBatches((data as Batch[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }

  useEffect(() => { if (profile) { loadBatches(); loadFactories() } }, [profile])

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const fmt = (d: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const num = (n: number | null | undefined) => (n == null ? '—' : Number(Number(n).toPrecision(12)).toString())
  const val = (v: unknown) => { const s = (v == null ? '' : String(v)).trim(); return s === '' ? '—' : s }

  async function buildReport(id: string) {
    setSelectedId(id)
    if (!id) { setSelected(null); setQc(null); setRmLines([]); setAffected([]); return }
    setBusy(true)
    try {
      const batch = batches.find(b => b.id === id) || null
      setSelected(batch)

      // ① QC result — latest inspection record for this batch
      const { data: rec } = await supabase.from('inspection_records')
        .select('data').eq('production_batch_id', id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      setQc((rec?.data as Record<string, unknown>) || null)

      // ② Raw materials consumed by this batch
      const { data: consRaw } = await supabase.from('production_consumption')
        .select('production_batch_id, lot_id, item_id, item_code, description, batch_no, exp_date, qty_consumed')
        .eq('production_batch_id', id)
      const cons = (consRaw as Consumption[]) || []

      // DO numbers come from the stock lot each consumption row points at
      const lotIds = [...new Set(cons.map(c => c.lot_id).filter(Boolean) as string[])]
      const lotMap: Record<string, { do_number: string | null; received_at: string | null }> = {}
      if (lotIds.length) {
        const { data: lots } = await supabase.from('stock_lots')
          .select('id, do_number, received_at').in('id', lotIds)
        ;(lots || []).forEach(l => { lotMap[l.id] = { do_number: l.do_number, received_at: l.received_at } })
      }

      // Sum consumption per raw-material lot (or item+batch when the lot link is gone)
      const lineMap: Record<string, RmLine> = {}
      cons.forEach(c => {
        const key = c.lot_id || `${c.item_id || c.item_code}|${c.batch_no || ''}`
        const lot = c.lot_id ? lotMap[c.lot_id] : undefined
        if (!lineMap[key]) lineMap[key] = {
          key, item_code: c.item_code, description: c.description, batch_no: c.batch_no,
          exp_date: c.exp_date, qty_consumed: 0,
          do_number: lot?.do_number || null, received_at: lot?.received_at || null,
        }
        lineMap[key].qty_consumed += Number(c.qty_consumed || 0)
      })
      const lines = Object.values(lineMap).sort((a, b) => a.item_code.localeCompare(b.item_code))
      setRmLines(lines)

      // ③ Recall scope — every OTHER finished batch that used any of the same RM lots/batches
      const lotIdSet = new Set(lotIds)
      const pairSet = new Set(cons.map(c => `${c.item_id || c.item_code}|${c.batch_no || ''}`))
      const itemIds = [...new Set(cons.map(c => c.item_id).filter(Boolean) as string[])]
      let others: Consumption[] = []
      if (itemIds.length) {
        const { data: oc } = await supabase.from('production_consumption')
          .select('production_batch_id, lot_id, item_id, item_code, description, batch_no, exp_date, qty_consumed')
          .in('item_id', itemIds)
        others = ((oc as Consumption[]) || []).filter(c =>
          c.production_batch_id !== id &&
          ((c.lot_id && lotIdSet.has(c.lot_id)) || pairSet.has(`${c.item_id || c.item_code}|${c.batch_no || ''}`)))
      }

      // Group the matches by affected batch
      const byBatch: Record<string, Affected['shared']> = {}
      others.forEach(c => {
        ;(byBatch[c.production_batch_id] = byBatch[c.production_batch_id] || []).push({
          item_code: c.item_code, batch_no: c.batch_no, qty_consumed: Number(c.qty_consumed || 0),
        })
      })
      const affectedIds = Object.keys(byBatch)
      let affBatches: Batch[] = []
      if (affectedIds.length) {
        const { data: ab } = await supabase.from('production_batches')
          .select('id, batch_no, item_code, description, factory_code, produced_qty, total_quantity, exp_date, status, pack_date')
          .in('id', affectedIds)
        affBatches = (ab as Batch[]) || []
      }
      // Merge duplicate shared lines (same item+batch) per affected batch
      const result: Affected[] = affBatches.map(b => {
        const m: Record<string, Affected['shared'][number]> = {}
        byBatch[b.id].forEach(s => {
          const k = `${s.item_code}|${s.batch_no || ''}`
          if (!m[k]) m[k] = { ...s, qty_consumed: 0 }
          m[k].qty_consumed += s.qty_consumed
        })
        return { batch: b, shared: Object.values(m).sort((a, c) => a.item_code.localeCompare(c.item_code)) }
      }).sort((a, b) => b.batch.batch_no.localeCompare(a.batch.batch_no))
      setAffected(result)
    } finally {
      setBusy(false)
    }
  }

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return batches
    return batches.filter(b => `${b.batch_no} ${b.item_code} ${b.description || ''}`.toLowerCase().includes(q))
  }, [batches, search])

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  // QC fields to surface on the report (label → key in the inspection data)
  const qcRows: { label: string; v: unknown }[] = qc ? [
    { label: 'Inspected by', v: qc.done_by },
    { label: 'Checked by', v: qc.checked_by },
    { label: 'Verified by', v: qc.verified_by },
    { label: 'Metal detector — Ferrous', v: qc.md_ferrous },
    { label: 'Metal detector — Non-ferrous', v: qc.md_nonferrous },
    { label: 'Metal detector — Stainless', v: qc.md_stainless },
    { label: 'Qty rejected (MD)', v: qc.md_qty_reject },
    { label: 'Action on reject', v: qc.md_action },
    { label: 'Colour', v: qc.qc_colour },
    { label: 'Odour', v: qc.qc_odour },
    { label: 'Physical', v: qc.qc_physical },
    { label: 'Cleanliness', v: qc.cleanliness },
    { label: 'Moisture %', v: qc.moisture_pct },
  ] : []

  return (
    <div className="min-h-screen bg-gray-50">
      <style>{`@media print { nav, .no-print { display: none !important } body { background: white } .printable { box-shadow: none !important; border: none !important } .page-break { page-break-before: always } }`}</style>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1 no-print">
          <h1 className="text-2xl font-bold">Traceability / Recall report</h1>
          {selected && <button onClick={() => window.print()} className="border px-4 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium">🖨 Print / PDF</button>}
        </div>
        <p className="text-gray-500 text-sm mb-5 no-print">
          Pick a produced batch to trace every raw-material batch that went into it, the Delivery Order each arrived on, and every other finished batch affected if those raw materials are recalled.
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>

        {/* Batch picker */}
        <div className="flex flex-wrap gap-2 items-center mb-5 text-sm no-print">
          <input placeholder="Search batch no, item code or product…" value={search} onChange={e => setSearch(e.target.value)}
            className="w-full sm:w-80 border rounded-lg px-3 py-2 bg-white" />
          <select value={selectedId} onChange={e => buildReport(e.target.value)} className="w-full sm:w-96 border rounded-lg px-3 py-2 bg-white">
            <option value="">— Select a produced batch —</option>
            {shown.map(b => (
              <option key={b.id} value={b.id}>{b.batch_no} · {b.item_code} · {b.description || ''}{isHO ? ` · ${b.factory_code}` : ''}</option>
            ))}
          </select>
        </div>

        {busy && <p className="text-gray-400 text-sm no-print">Building report…</p>}

        {!selected ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400 no-print">
            Select a produced batch above to generate its traceability &amp; recall report.
          </div>
        ) : (
          <div className="printable bg-white rounded-xl shadow-sm border p-6 space-y-7">
            {/* Report header */}
            <div className="border-b pb-3">
              <div className="font-bold text-lg">SRRI EASWARI MILLS SDN BHD</div>
              <div className="text-gray-600">Traceability &amp; Recall Report</div>
              <div className="text-xs text-gray-400 mt-1">Generated {new Date().toLocaleString()} · by {profile.full_name}</div>
            </div>

            {/* ① Finished batch + QC */}
            <section>
              <h2 className="font-semibold text-gray-800 mb-2">① Finished batch</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                <Detail label="Batch no" value={selected.batch_no} mono />
                <Detail label="Product code" value={selected.item_code} mono />
                <Detail label="Product" value={selected.description || '—'} />
                <Detail label="Factory" value={factoryName(selected.factory_code)} />
                <Detail label="Produced qty" value={num(selected.produced_qty)} />
                <Detail label="Planned qty" value={num(selected.total_quantity)} />
                <Detail label="Expiry" value={fmt(selected.exp_date)} />
                <Detail label="Pack date" value={fmt(selected.pack_date)} />
                <Detail label="Status" value={selected.status || '—'} />
              </div>

              <h3 className="font-medium text-gray-700 mt-4 mb-2 text-sm">QC inspection result</h3>
              {qc ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
                  {qcRows.map(r => <Detail key={r.label} label={r.label} value={val(r.v)} />)}
                  {val(qc.remarks) !== '—' && <div className="col-span-2 sm:col-span-3"><Detail label="Remarks" value={val(qc.remarks)} /></div>}
                </div>
              ) : (
                <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">No QC inspection record was found for this batch.</p>
              )}
            </section>

            {/* ② Raw materials consumed */}
            <section>
              <h2 className="font-semibold text-gray-800 mb-2">② Raw materials consumed</h2>
              {rmLines.length === 0 ? (
                <p className="text-sm text-gray-400">No raw-material consumption was recorded for this batch.</p>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>{['Item code', 'Description', 'Batch no', 'Expiry', 'Qty used', 'Arrived on DO', 'Received'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {rmLines.map(l => (
                        <tr key={l.key} className="border-b last:border-0">
                          <td className="px-3 py-2 font-mono">{l.item_code}</td>
                          <td className="px-3 py-2 text-gray-600">{l.description || '—'}</td>
                          <td className="px-3 py-2 font-mono">{l.batch_no || '—'}</td>
                          <td className="px-3 py-2">{fmt(l.exp_date)}</td>
                          <td className="px-3 py-2 text-right font-semibold">{num(l.qty_consumed)}</td>
                          <td className="px-3 py-2 font-mono">{l.do_number || '—'}</td>
                          <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{l.received_at ? new Date(l.received_at).toLocaleDateString() : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ③ Recall scope */}
            <section>
              <h2 className="font-semibold text-gray-800 mb-1">③ Recall scope — other finished batches using the same raw materials</h2>
              <p className="text-xs text-gray-400 mb-2">If any raw-material batch above is recalled, these finished batches are also affected.</p>
              {affected.length === 0 ? (
                <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  No other finished batch used any of these raw-material batches. The recall is limited to <span className="font-mono">{selected.batch_no}</span>.
                </p>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>{['Batch no', 'Product', 'Factory', 'Produced', 'Expiry', 'Status', 'Shared raw material(s)'].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {affected.map(a => (
                        <tr key={a.batch.id} className="border-b last:border-0 align-top">
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{a.batch.batch_no}</td>
                          <td className="px-3 py-2"><span className="font-mono">{a.batch.item_code}</span> <span className="text-gray-500">{a.batch.description || ''}</span></td>
                          <td className="px-3 py-2 whitespace-nowrap">{factoryName(a.batch.factory_code)}</td>
                          <td className="px-3 py-2 text-right">{num(a.batch.produced_qty)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmt(a.batch.exp_date)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{a.batch.status || '—'}</td>
                          <td className="px-3 py-2 text-xs">
                            {a.shared.map((s, i) => (
                              <div key={i} className="whitespace-nowrap"><span className="font-mono">{s.item_code}</span> · batch <span className="font-mono">{s.batch_no || '—'}</span> · {num(s.qty_consumed)}</div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="border-t pt-3 text-xs text-gray-400">
              End of report · {selected.batch_no} · {new Date().toLocaleDateString()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className={mono ? 'font-mono' : ''}>{value}</div>
    </div>
  )
}
