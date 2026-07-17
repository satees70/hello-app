'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { downloadCsv } from '@/lib/csv'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'

// Count Adjustments by counter — the stock changes that came from cycle counts, attributed to the
// person who actually COUNTED each line (not who approved/applied the count). Sourced from the
// count lines of Applied counts: each line's change = counted − system, grouped by counter / item / count.

interface Task { count_no: string | null; status: string; created_at: string; completed_at: string | null; applied_at: string | null }
interface Line { item_code: string; description: string | null; location_code: string; batch_no: string; expected_qty: number; counted_qty: number | null; is_unexpected: boolean; counted_by_name: string | null; counted_at: string | null; wms_count_tasks: Task | Task[] | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtSigned = (n: number) => (n > 0 ? '+' : '') + fmtQty(n)
const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const dOnly = (iso: string) => iso.slice(0, 10)
const taskOf = (l: Line): Task | null => Array.isArray(l.wms_count_tasks) ? (l.wms_count_tasks[0] || null) : l.wms_count_tasks
const taskDate = (t: Task | null) => t?.applied_at || t?.completed_at || t?.created_at || ''

export default function CountingReportPage() {
  const { profile, loading } = useProfile()
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [view, setView] = useState<'person' | 'item' | 'count'>('person')
  const [wh, setWh] = useState<WhFilter>('all')
  const [q, setQ] = useState('')
  const [showDetail, setShowDetail] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    // Applied counts only, lines that were counted and not skipped.
    const { data } = await supabase.from('wms_count_lines')
      .select('item_code, description, location_code, batch_no, expected_qty, counted_qty, is_unexpected, counted_by_name, counted_at, wms_count_tasks!inner(count_no, status, created_at, completed_at, applied_at)')
      .eq('wms_count_tasks.status', 'Applied').eq('skip', false).not('counted_qty', 'is', null).limit(8000)
    const rows = (data as Line[]) || []
    setLines(rows); setTruncated(rows.length >= 8000); setBusy(false)
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  function preset(kind: 'today' | 'month' | 'year' | 'all') {
    const now = new Date(); const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0'); const d = String(now.getDate()).padStart(2, '0')
    if (kind === 'today') { setFrom(`${y}-${m}-${d}`); setTo(`${y}-${m}-${d}`) }
    else if (kind === 'month') { setFrom(`${y}-${m}-01`); setTo(`${y}-${m}-${d}`) }
    else if (kind === 'year') { setFrom(`${y}-01-01`); setTo(`${y}-${m}-${d}`) }
    else { setFrom(''); setTo('') }
  }

  // Each counted line becomes an adjustment: counted − system. Only lines that actually changed stock.
  const rowsShown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return lines.map(l => {
      const t = taskOf(l)
      const delta = clean(Number(l.counted_qty || 0) - Number(l.expected_qty || 0))
      return { l, t, delta, person: l.counted_by_name || '—', when: taskDate(t) }
    }).filter(x => x.delta !== 0)
      .filter(x => { const d = x.when ? dOnly(x.when) : ''; if (from && (!d || d < from)) return false; if (to && (!d || d > to)) return false; return true })
      .filter(x => passWh(wh, x.l.description))
      .filter(x => !needle || [x.l.item_code, x.l.description, x.person, x.t?.count_no].some(v => (v || '').toLowerCase().includes(needle)))
  }, [lines, from, to, wh, q])

  const groupCol = view === 'item' ? 'Item' : view === 'count' ? 'Count' : 'Counted by'
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; sub: string; inc: number; dec: number; count: number }>()
    for (const x of rowsShown) {
      const k = view === 'item' ? x.l.item_code : view === 'count' ? (x.t?.count_no || '—') : x.person
      const label = k
      const sub = view === 'item' ? (x.l.description || '') : ''
      const e = m.get(k) || { key: k, label, sub, inc: 0, dec: 0, count: 0 }
      if (x.delta > 0) e.inc = clean(e.inc + x.delta); else e.dec = clean(e.dec - x.delta)
      e.count++; m.set(k, e)
    }
    return [...m.values()].sort((a, b) => (b.inc + b.dec) - (a.inc + a.dec))
  }, [rowsShown, view])

  const totals = useMemo(() => {
    let inc = 0, dec = 0
    for (const x of rowsShown) { if (x.delta > 0) inc = clean(inc + x.delta); else dec = clean(dec - x.delta) }
    return { inc, dec, net: clean(inc - dec), count: rowsShown.length }
  }, [rowsShown])

  function exportCsv() {
    const head = [groupCol, 'Lines', 'Increase', 'Decrease', 'Net']
    const body: (string | number)[][] = groups.map(g => [g.sub ? `${g.label} — ${g.sub}` : g.label, g.count, fmtQty(g.inc), fmtQty(g.dec), fmtSigned(clean(g.inc - g.dec))])
    body.push(['TOTAL', totals.count, fmtQty(totals.inc), fmtQty(totals.dec), fmtSigned(totals.net)])
    downloadCsv(`CountAdjustments_${view}_${from || 'all'}_${to || 'all'}.csv`, head, body)
  }
  async function exportPdf() {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS SDN BHD', 14, 15)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.text('COUNT ADJUSTMENTS — BY PERSON WHO COUNTED', 14, 22)
    doc.setFontSize(9); doc.text([`By: ${view}`, (from || to) ? `Period: ${from || '…'} → ${to || '…'}` : 'Period: all'].join('    '), 14, 29)
    autoTable(doc, {
      startY: 34, styles: { fontSize: 8 }, headStyles: { fillColor: [4, 120, 87] },
      head: [[groupCol, 'Lines', 'Increase', 'Decrease', 'Net']],
      body: groups.map(g => [g.sub ? `${g.label} — ${g.sub}` : g.label, String(g.count), fmtQty(g.inc), fmtQty(g.dec), fmtSigned(clean(g.inc - g.dec))]),
      foot: [['TOTAL', String(totals.count), fmtQty(totals.inc), fmtQty(totals.dec), fmtSigned(totals.net)]],
      footStyles: { fillColor: [235, 235, 235], textColor: 20, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
    })
    doc.save(`CountAdjustments_${view}_${from || 'all'}_${to || 'all'}.pdf`)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold">Count Adjustments · by counter</h1>
            <p className="text-gray-500 text-sm mt-1">Stock changes from cycle counts, credited to the person who <b>counted</b> (not who approved). <Link href="/wms/reports/adjustments" className="text-emerald-700 underline">All adjustments</Link> · <Link href="/wms/reports" className="text-emerald-700 underline">Stock Reports</Link></p>
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
            <div><label className="block text-xs text-gray-500 mb-1">Warehouse</label><WarehouseTabs value={wh} onChange={setWh} className="w-full" /></div>
            <div className="lg:col-span-1"><label className="block text-xs text-gray-500 mb-1">Search <span className="text-gray-400">(optional)</span></label><input value={q} onChange={e => setQ(e.target.value)} placeholder="item / person / count…" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold tabular-nums">{totals.count}</div><div className="text-xs text-gray-500 mt-0.5">Lines adjusted</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-emerald-600 tabular-nums">{fmtQty(totals.inc)}</div><div className="text-xs text-gray-500 mt-0.5">Increase (+)</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-amber-600 tabular-nums">{fmtQty(totals.dec)}</div><div className="text-xs text-gray-500 mt-0.5">Decrease (−)</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className={`text-2xl font-bold tabular-nums ${totals.net < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(totals.net)}</div><div className="text-xs text-gray-500 mt-0.5">Net change</div></div>
        </div>

        {truncated && <p className="text-xs text-amber-600 mb-2">Showing the most recent 8,000 counted lines — narrow the date range for an exact total.</p>}

        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-xs text-gray-500 mr-1">Break down by:</span>
          {([['person', '👤 Counter'], ['item', '📦 Item'], ['count', '🔢 Count']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setView(k)} className={`px-3 py-1 rounded-lg text-xs font-medium border ${view === k ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-gray-50'}`}>{lbl}</button>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{[groupCol, 'Lines', 'Increase', 'Decrease', 'Net'].map(h => <th key={h} className={`px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap ${h === groupCol ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {busy && <tr><td colSpan={5} className="text-center py-10 text-gray-400">Loading…</td></tr>}
              {!busy && groups.length === 0 && <tr><td colSpan={5} className="text-center py-10 text-gray-400">No count adjustments in this timeframe.</td></tr>}
              {!busy && groups.map(g => { const net = clean(g.inc - g.dec); return (
                <tr key={g.key} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium">{view === 'item' ? <span className="font-mono">{g.label}</span> : g.label}{g.sub && <span className="text-gray-400 font-normal text-xs"> {g.sub}</span>}</td>
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

        <button onClick={() => setShowDetail(s => !s)} className="text-sm text-emerald-700 hover:underline mt-3">{showDetail ? 'Hide' : 'Show'} each counted line ({rowsShown.length})</button>
        {showDetail && (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mt-2">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>{['When', 'Count', 'Item', 'Batch', 'Bin', 'System', 'Counted', 'Change', 'Counted by'].map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {rowsShown.slice(0, 1000).map((x, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtTime(x.when)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{x.t?.count_no || '—'}</td>
                    <td className="px-3 py-2"><span className="font-mono font-medium">{x.l.item_code}</span> <span className="text-gray-400 text-xs">{x.l.description}</span></td>
                    <td className="px-3 py-2 font-mono text-xs">{x.l.batch_no || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{x.l.location_code}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtQty(Number(x.l.expected_qty))}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtQty(Number(x.l.counted_qty))}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${x.delta < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{fmtSigned(x.delta)}</td>
                    <td className="px-3 py-2 text-xs">{x.person}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rowsShown.length > 1000 && <p className="text-xs text-gray-400 px-3 py-2">Showing first 1,000 of {rowsShown.length} — use the summary above for totals.</p>}
          </div>
        )}
      </div>
    </div>
  )
}
