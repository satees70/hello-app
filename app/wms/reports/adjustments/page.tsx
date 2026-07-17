'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { downloadCsv } from '@/lib/csv'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'

// Adjustments report — every 'adjust' stock movement (manual adjust/remove, cycle-count
// corrections, re-codes, batch fixes, import opening loads), totalled over a timeframe and
// grouped by day / month / year. Increase = stock added, Decrease = stock removed, Net = the two.

interface Move { id: string; item_code: string; description: string | null; from_location_code: string | null; to_location_code: string | null; batch_no: string; quantity: number; reference: string | null; moved_by_name: string | null; created_at: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtSigned = (n: number) => (n > 0 ? '+' : '') + fmtQty(n)
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

type GroupBy = 'day' | 'month' | 'year'
type Source = 'corr' | 'all' | 'manual' | 'count' | 'recode' | 'batch' | 'import'
const SOURCE_OPTS: { k: Source; label: string }[] = [
  { k: 'corr', label: 'Corrections (excl. import loads)' },
  { k: 'all', label: 'Everything (incl. import loads)' },
  { k: 'manual', label: 'Manual adjust / remove only' },
  { k: 'count', label: 'Cycle count only' },
  { k: 'recode', label: 'Re-code only' },
  { k: 'batch', label: 'Batch fix only' },
  { k: 'import', label: 'Import opening loads only' },
]
const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', count: 'Cycle count', recode: 'Re-code', batch: 'Batch fix', import: 'Import opening', other: 'Other' }

function adjustSource(ref: string | null): 'manual' | 'count' | 'recode' | 'batch' | 'import' | 'other' {
  const r = (ref || '').toLowerCase()
  if (r.startsWith('cycle count')) return 'count'
  if (r.startsWith('re-code')) return 'recode'
  if (r.startsWith('batch fix')) return 'batch'
  if (r.startsWith('opening balance')) return 'import'
  if (r.startsWith('manual') || r.startsWith('approved adjustment')) return 'manual'
  return 'other'
}
function periodKey(iso: string, g: GroupBy): string {
  return g === 'day' ? iso.slice(0, 10) : g === 'month' ? iso.slice(0, 7) : iso.slice(0, 4)
}
function periodLabel(key: string, g: GroupBy): string {
  if (g === 'year') return key
  if (g === 'month') { const [y, m] = key.split('-'); return `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m)]} ${y}` }
  return new Date(key + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function AdjustmentsReportPage() {
  const { profile, loading } = useProfile()
  const [moves, setMoves] = useState<Move[]>([])
  const [busy, setBusy] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [source, setSource] = useState<Source>('corr')
  const [wh, setWh] = useState<WhFilter>('all')
  const [q, setQ] = useState('')
  const [showDetail, setShowDetail] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    let query = supabase.from('wms_stock_moves')
      .select('id, item_code, description, from_location_code, to_location_code, batch_no, quantity, reference, moved_by_name, created_at')
      .eq('move_type', 'adjust').order('created_at', { ascending: false }).limit(5000)
    if (from) query = query.gte('created_at', from + 'T00:00:00')
    if (to) query = query.lte('created_at', to + 'T23:59:59')
    const { data } = await query
    const rows = (data as Move[]) || []
    setMoves(rows); setTruncated(rows.length >= 5000); setBusy(false)
  }, [from, to])
  useEffect(() => { if (profile) load() }, [profile, load])

  // Quick timeframe presets (compute in local time; the query bounds are date-only).
  function preset(kind: 'today' | 'month' | 'year' | 'all') {
    const now = new Date(); const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0'); const d = String(now.getDate()).padStart(2, '0')
    if (kind === 'today') { setFrom(`${y}-${m}-${d}`); setTo(`${y}-${m}-${d}`); setGroupBy('day') }
    else if (kind === 'month') { setFrom(`${y}-${m}-01`); setTo(`${y}-${m}-${d}`); setGroupBy('day') }
    else if (kind === 'year') { setFrom(`${y}-01-01`); setTo(`${y}-${m}-${d}`); setGroupBy('month') }
    else { setFrom(''); setTo(''); setGroupBy('month') }
  }

  const inOut = (m: Move) => ({ inc: m.to_location_code ? Number(m.quantity) : 0, dec: m.from_location_code ? Number(m.quantity) : 0 })

  const rowsShown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return moves
      .filter(m => passWh(wh, m.description))
      .filter(m => { const s = adjustSource(m.reference); return source === 'all' ? true : source === 'corr' ? s !== 'import' : s === source })
      .filter(m => !needle || [m.item_code, m.description, m.reference, m.batch_no].some(v => (v || '').toLowerCase().includes(needle)))
  }, [moves, wh, source, q])

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; inc: number; dec: number; count: number }>()
    for (const mv of rowsShown) {
      const k = periodKey(mv.created_at, groupBy)
      const e = m.get(k) || { key: k, inc: 0, dec: 0, count: 0 }
      const { inc, dec } = inOut(mv)
      e.inc = clean(e.inc + inc); e.dec = clean(e.dec + dec); e.count++
      m.set(k, e)
    }
    return [...m.values()].sort((a, b) => b.key.localeCompare(a.key))
  }, [rowsShown, groupBy])

  const totals = useMemo(() => {
    const inc = clean(rowsShown.reduce((s, m) => s + inOut(m).inc, 0))
    const dec = clean(rowsShown.reduce((s, m) => s + inOut(m).dec, 0))
    return { inc, dec, net: clean(inc - dec), count: rowsShown.length }
  }, [rowsShown])

  function exportCsv() {
    const head = ['Period', 'Adjustments', 'Increase', 'Decrease', 'Net']
    const body: (string | number)[][] = groups.map(g => [periodLabel(g.key, groupBy), g.count, fmtQty(g.inc), fmtQty(g.dec), fmtSigned(clean(g.inc - g.dec))])
    body.push(['TOTAL', totals.count, fmtQty(totals.inc), fmtQty(totals.dec), fmtSigned(totals.net)])
    downloadCsv(`Adjustments_${groupBy}_${from || 'all'}_${to || 'all'}.csv`, head, body)
  }
  async function exportPdf() {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS SDN BHD', 14, 15)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.text('STOCK ADJUSTMENTS REPORT', 14, 22)
    doc.setFontSize(9)
    doc.text([`Group: by ${groupBy}`, SOURCE_OPTS.find(s => s.k === source)?.label || '', (from || to) ? `Period: ${from || '…'} → ${to || '…'}` : 'Period: all'].join('    '), 14, 29)
    autoTable(doc, {
      startY: 34, styles: { fontSize: 8 }, headStyles: { fillColor: [4, 120, 87] },
      head: [['Period', 'Adjustments', 'Increase', 'Decrease', 'Net']],
      body: groups.map(g => [periodLabel(g.key, groupBy), String(g.count), fmtQty(g.inc), fmtQty(g.dec), fmtSigned(clean(g.inc - g.dec))]),
      foot: [['TOTAL', String(totals.count), fmtQty(totals.inc), fmtQty(totals.dec), fmtSigned(totals.net)]],
      footStyles: { fillColor: [235, 235, 235], textColor: 20, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    })
    doc.save(`Adjustments_${groupBy}_${from || 'all'}_${to || 'all'}.pdf`)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold">Adjustments Report</h1>
            <p className="text-gray-500 text-sm mt-1">Total adjusted quantity over time. <Link href="/wms/reports" className="text-emerald-700 underline">Stock Reports</Link> · <Link href="/wms/reports/activity" className="text-emerald-700 underline">Activity</Link> · <Link href="/wms/reports/stock-card" className="text-emerald-700 underline">Stock Card</Link></p>
          </div>
          <div className="flex gap-2">
            <button onClick={exportCsv} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button>
            <button onClick={exportPdf} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ PDF</button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-4 mb-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 mr-1">Quick:</span>
            {([['today', 'Today'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => preset(k)} className="px-3 py-1 rounded-lg text-xs font-medium border bg-white hover:bg-gray-50">{lbl}</button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div><label className="block text-xs text-gray-500 mb-1">From</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">To</label><input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Group by</label>
              <select value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)} className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="day">Day</option><option value="month">Month</option><option value="year">Year</option>
              </select>
            </div>
            <div><label className="block text-xs text-gray-500 mb-1">Warehouse</label><WarehouseTabs value={wh} onChange={setWh} className="w-full" /></div>
            <div className="lg:col-span-2"><label className="block text-xs text-gray-500 mb-1">Source</label>
              <select value={source} onChange={e => setSource(e.target.value as Source)} className="w-full border rounded-lg px-3 py-2 text-sm">
                {SOURCE_OPTS.map(o => <option key={o.k} value={o.k}>{o.label}</option>)}
              </select>
            </div>
            <div className="lg:col-span-2"><label className="block text-xs text-gray-500 mb-1">Search item / reference <span className="text-gray-400">(optional)</span></label>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="item code, description, reference…" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold tabular-nums">{totals.count}</div><div className="text-xs text-gray-500 mt-0.5">Adjustments</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-emerald-600 tabular-nums">{fmtQty(totals.inc)}</div><div className="text-xs text-gray-500 mt-0.5">Increase (+)</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-amber-600 tabular-nums">{fmtQty(totals.dec)}</div><div className="text-xs text-gray-500 mt-0.5">Decrease (−)</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className={`text-2xl font-bold tabular-nums ${totals.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(totals.net)}</div><div className="text-xs text-gray-500 mt-0.5">Net change</div></div>
        </div>

        {truncated && <p className="text-xs text-amber-600 mb-2">Showing the most recent 5,000 adjustments — narrow the date range for an exact total over a long period.</p>}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Period', 'Adjustments', 'Increase', 'Decrease', 'Net'].map(h => <th key={h} className={`px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap ${h === 'Period' ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {busy && <tr><td colSpan={5} className="text-center py-10 text-gray-400">Loading…</td></tr>}
              {!busy && groups.length === 0 && <tr><td colSpan={5} className="text-center py-10 text-gray-400">No adjustments in this timeframe.</td></tr>}
              {!busy && groups.map(g => { const net = clean(g.inc - g.dec); return (
                <tr key={g.key} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">{periodLabel(g.key, groupBy)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{g.count}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{g.inc ? fmtQty(g.inc) : ''}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-amber-700">{g.dec ? fmtQty(g.dec) : ''}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-medium ${net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(net)}</td>
                </tr>
              )})}
              {!busy && groups.length > 0 && <tr className="border-t-2 bg-gray-50 font-semibold"><td className="px-3 py-2">TOTAL</td><td className="px-3 py-2 text-right tabular-nums">{totals.count}</td><td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmtQty(totals.inc)}</td><td className="px-3 py-2 text-right tabular-nums text-amber-700">{fmtQty(totals.dec)}</td><td className={`px-3 py-2 text-right tabular-nums ${totals.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(totals.net)}</td></tr>}
            </tbody>
          </table>
        </div>

        <button onClick={() => setShowDetail(s => !s)} className="text-sm text-emerald-700 hover:underline mt-3">{showDetail ? 'Hide' : 'Show'} each adjustment ({rowsShown.length})</button>
        {showDetail && (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mt-2">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>{['When', 'Item', 'Batch', 'Bin', 'Change', 'Source', 'Reference', 'By'].map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {rowsShown.slice(0, 1000).map(m => { const { inc, dec } = inOut(m); const net = clean(inc - dec); const src = adjustSource(m.reference); return (
                  <tr key={m.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtTime(m.created_at)}</td>
                    <td className="px-3 py-2"><span className="font-mono font-medium">{m.item_code}</span> <span className="text-gray-400 text-xs">{m.description}</span></td>
                    <td className="px-3 py-2 font-mono text-xs">{m.batch_no || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{m.from_location_code || m.to_location_code || '—'}</td>
                    <td className={`px-3 py-2 tabular-nums font-medium ${net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(net)}</td>
                    <td className="px-3 py-2 text-xs">{SOURCE_LABEL[src] || src}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{m.reference || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{m.moved_by_name || '—'}</td>
                  </tr>
                )})}
              </tbody>
            </table>
            {rowsShown.length > 1000 && <p className="text-xs text-gray-400 px-3 py-2">Showing first 1,000 of {rowsShown.length} — use the summary above for totals.</p>}
          </div>
        )}
      </div>
    </div>
  )
}
