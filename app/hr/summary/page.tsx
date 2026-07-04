'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  loadReport, prevMonthRange, leaveBreakdown, tripBreakdown, totalOtMinutes, type EmpBlock,
} from '@/lib/attendanceReport'

// Monthly Summary — one row per employee, the payroll-ready totals for a month.
// Every number here comes from the same loadReport() the Attendance & OT detail
// page uses, so the two always agree.

// Minutes → decimal hours with 2 places (e.g. 990 → "16.50"), matching the sheet.
const hrs = (min: number) => (min / 60).toFixed(2)
// Round days sensibly (0.5 kept, whole numbers clean).
const days = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(1))
// On-screen display: blank a zero so the table is easy to scan (CSV keeps the 0).
const hb = (min: number) => (min ? hrs(min) : '')
const db = (d: number) => (d ? days(d) : '')
const fmtDate = (k: string) => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}` }
const breakStr = (rec: Record<string, number>) => Object.entries(rec).map(([k, v]) => `${k} ${v}`).join(', ')

// The one row of numbers for an employee. `totalOtMin` = OT minus late/early time
// that is ACTUALLY deducted (excused days + a per-person exemption are skipped).
function rowFor(b: EmpBlock) {
  return {
    code: b.code,
    name: b.name,
    department: b.department ?? '',
    workDays: b.workDays,
    leaveDays: b.leaveDays,
    leaveBreak: breakStr(leaveBreakdown(b)),
    workedMin: b.totalWorked,
    otMin: b.totalOt,
    lateMin: b.totalLate,
    earlyMin: b.totalEarlyOut,
    excusedLateMin: b.excusedLate,
    excusedEarlyMin: b.excusedEarly,
    noDeductLate: b.noDeductLate,
    otMonthOff: b.otMonthOff,
    totalOtMin: totalOtMinutes(b),
    phDays: b.totalHolidayDays,
    restDays: b.totalRestDays,
    outstationDays: b.totalOutstation,
    trips: b.deliveryName ? breakStr(tripBreakdown(b)) : '',
    needsReview: b.needsReview,
  }
}
type Row = ReturnType<typeof rowFor>

// The report columns, driving both the on-screen table and the CSV/print export.
// `csv` returns the raw cell value for a row; `num` right-aligns the column.
const COLS: { key: string; label: string; num?: boolean; title?: string; csv: (r: Row) => string | number }[] = [
  { key: 'code', label: 'Code', csv: r => r.code },
  { key: 'name', label: 'Name', csv: r => r.name },
  { key: 'workDays', label: 'Work d', num: true, csv: r => days(r.workDays) },
  { key: 'leaveDays', label: 'Leave d', num: true, csv: r => days(r.leaveDays) },
  { key: 'leaveBreak', label: 'Leave breakdown', csv: r => r.leaveBreak },
  { key: 'workedMin', label: 'Worked h', num: true, csv: r => hrs(r.workedMin) },
  { key: 'otMin', label: 'OT h', num: true, csv: r => hrs(r.otMin) },
  { key: 'countOt', label: 'Count OT', csv: r => (r.otMonthOff ? 'no' : 'yes') },
  { key: 'lateMin', label: 'Late h', num: true, csv: r => hrs(r.lateMin) },
  { key: 'earlyMin', label: 'Early-out h', num: true, csv: r => hrs(r.earlyMin) },
  { key: 'totalOtMin', label: 'Total OT h', num: true, csv: r => hrs(r.totalOtMin) },
  { key: 'deduct', label: 'Deduct late/early', csv: r => (r.noDeductLate ? 'no' : 'yes') },
  { key: 'phDays', label: 'PH d', num: true, title: 'Days actually worked on a public holiday', csv: r => days(r.phDays) },
  { key: 'restDays', label: 'Rest d', num: true, title: 'Days actually worked on a rest day (e.g. Sunday)', csv: r => days(r.restDays) },
  { key: 'outstationDays', label: 'Outstation d', num: true, csv: r => days(r.outstationDays) },
  { key: 'trips', label: 'Trips', csv: r => r.trips },
]

export default function SummaryPage() {
  const [from, setFrom] = useState(() => prevMonthRange().from)
  const [to, setTo] = useState(() => prevMonthRange().to)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<EmpBlock[]>([])
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { blocks } = await loadReport(from, to)
      setBlocks(blocks)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [from, to])
  useEffect(() => { load() }, [load])

  // Toggle the per-person monthly late/early deduction (optimistic). deduct=true
  // means subtract late/early from Total OT; false exempts them for the month.
  async function saveDeduct(code: string, deduct: boolean) {
    setBlocks(bs => bs.map(b => b.code === code ? { ...b, noDeductLate: !deduct } : b))
    const res = await fetch('/api/attendance/deduct-override', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, month: from.slice(0, 7), no_deduct: !deduct }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
  }

  // Toggle whether this person's OT counts for the month (optimistic). count=true
  // (ticked) is the default; unticking skips all of their OT.
  async function saveCountOt(code: string, count: boolean) {
    setBlocks(bs => bs.map(b => b.code === code ? { ...b, otMonthOff: !count } : b))
    const res = await fetch('/api/attendance/ot-month', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, month: from.slice(0, 7), off: !count }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') } else await load()
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return blocks.map(rowFor).filter(r => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
  }, [blocks, query])

  // Column grand totals (hours/days summed, then formatted like the cells).
  const totals = useMemo(() => {
    const t = rows.reduce((a, r) => ({
      workDays: a.workDays + r.workDays, leaveDays: a.leaveDays + r.leaveDays,
      workedMin: a.workedMin + r.workedMin, otMin: a.otMin + r.otMin,
      lateMin: a.lateMin + r.lateMin, earlyMin: a.earlyMin + r.earlyMin,
      totalOtMin: a.totalOtMin + r.totalOtMin, phDays: a.phDays + r.phDays,
      restDays: a.restDays + r.restDays, outstationDays: a.outstationDays + r.outstationDays,
    }), { workDays: 0, leaveDays: 0, workedMin: 0, otMin: 0, lateMin: 0, earlyMin: 0, totalOtMin: 0, phDays: 0, restDays: 0, outstationDays: 0 })
    return t
  }, [rows])

  function exportCsv() {
    const header = COLS.map(c => c.label)
    const lines = [header, ...rows.map(r => COLS.map(c => {
      const v = String(c.csv(r))
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
    }))]
    const csv = lines.map(l => l.join(',')).join('\r\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `monthly-summary_${from}_to_${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function printTable() {
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const th = COLS.map(c => `<th class="${c.num ? 'n' : ''}">${esc(c.label)}</th>`).join('')
    const trs = rows.map(r => `<tr>${COLS.map(c => `<td class="${c.num ? 'n' : ''}">${esc(String(c.csv(r)))}</td>`).join('')}</tr>`).join('')
    const css = `* { font-family: -apple-system, Segoe UI, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @page { size: A4 landscape; margin: 10mm; }
      body { margin: 0; color: #111; }
      h1 { font-size: 15px; margin: 0 0 2px; }
      .meta { font-size: 11px; color: #444; margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; font-size: 10px; }
      th, td { border: 1px solid #bbb; padding: 2px 5px; text-align: left; }
      th { background: #eee; }
      td.n, th.n { text-align: right; white-space: nowrap; }`
    const win = window.open('', '_blank')
    if (!win) { setError('Please allow pop-ups for this site to print.'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Monthly summary</title><style>${css}</style></head><body>
      <h1>Monthly Summary</h1>
      <div class="meta">${fmtDate(from)} – ${fmtDate(to)} · ${rows.length} people</div>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
    </body></html>`)
    win.document.close(); win.focus()
    setTimeout(() => win.print(), 350)
  }

  return (
    <main className="max-w-full mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Monthly summary</h1>
          <p className="text-sm text-gray-500">One row per person — payroll totals for the month. Same numbers as Attendance &amp; OT.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} disabled={rows.length === 0}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-40">Export CSV</button>
          <button onClick={printTable} disabled={rows.length === 0}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Print</button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-sm">Month
          <input type="month" lang="en-GB" value={from.slice(0, 7)}
            onChange={e => {
              const v = e.target.value; if (!v) return
              const [y, m] = v.split('-').map(Number)
              const last = new Date(y, m, 0).getDate()
              setFrom(`${v}-01`); setTo(`${v}-${String(last).padStart(2, '0')}`)
            }}
            className="block mt-1 rounded border border-gray-300 px-2 py-1" />
        </label>
        <label className="text-sm">From<input type="date" lang="en-GB" value={from} onChange={e => setFrom(e.target.value)} className="block mt-1 rounded border border-gray-300 px-2 py-1" /></label>
        <label className="text-sm">To<input type="date" lang="en-GB" value={to} onChange={e => setTo(e.target.value)} className="block mt-1 rounded border border-gray-300 px-2 py-1" /></label>
        <button onClick={load} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Refresh</button>
        <label className="text-sm ml-auto">Search
          <input type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="name or code"
            className="block mt-1 rounded border border-gray-300 px-2 py-1" />
        </label>
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
      <p className="text-sm text-gray-500 mb-3">
        {loading ? 'Loading…' : `${rows.length} people · ${fmtDate(from)} – ${fmtDate(to)}`}
      </p>

      {!loading && rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-500">
          No data for this month. Sync punches on the Attendance &amp; OT page first.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-500 bg-gray-50">
              <tr className="border-b border-gray-200">
                {COLS.map(c => (
                  <th key={c.key} title={c.title} className={`px-3 py-2 font-medium whitespace-nowrap ${c.num ? 'text-right' : ''}`}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.code} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.code}</td>
                  <td className="px-3 py-2 whitespace-nowrap font-medium">
                    {r.name}
                    {r.needsReview > 0 && <span className="ml-2 text-xs text-amber-600" title="Days still needing review on the Attendance page">⚠ {r.needsReview}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{db(r.workDays)}</td>
                  <td className="px-3 py-2 text-right">{db(r.leaveDays)}</td>
                  <td className="px-3 py-2 text-rose-600 whitespace-nowrap">{r.leaveBreak}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{hb(r.workedMin)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap font-medium">{hb(r.otMin)}</td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={!r.otMonthOff} onChange={e => saveCountOt(r.code, e.target.checked)}
                      title="Untick to NOT count this person's OT for the month" className="cursor-pointer" />
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-rose-600">
                    {hb(r.lateMin)}
                    {r.noDeductLate && r.lateMin > 0
                      ? <div className="text-xs text-gray-400">not deducted</div>
                      : r.excusedLateMin > 0 && <div className="text-xs text-gray-400">exc {hrs(r.excusedLateMin)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap text-rose-600">
                    {hb(r.earlyMin)}
                    {r.noDeductLate && r.earlyMin > 0
                      ? <div className="text-xs text-gray-400">not deducted</div>
                      : r.excusedEarlyMin > 0 && <div className="text-xs text-gray-400">exc {hrs(r.excusedEarlyMin)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-gray-900">{hb(r.totalOtMin)}</td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={!r.noDeductLate} onChange={e => saveDeduct(r.code, e.target.checked)}
                      title="Untick to stop deducting this person's late/early from Total OT for the month" className="cursor-pointer" />
                  </td>
                  <td className="px-3 py-2 text-right">{db(r.phDays)}</td>
                  <td className="px-3 py-2 text-right">{db(r.restDays)}</td>
                  <td className="px-3 py-2 text-right">{db(r.outstationDays)}</td>
                  <td className="px-3 py-2 text-indigo-700 whitespace-nowrap">{r.trips}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-medium border-t-2 border-gray-200">
              <tr>
                <td className="px-3 py-2" colSpan={2}>Total ({rows.length})</td>
                <td className="px-3 py-2 text-right">{db(totals.workDays)}</td>
                <td className="px-3 py-2 text-right">{db(totals.leaveDays)}</td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-right">{hb(totals.workedMin)}</td>
                <td className="px-3 py-2 text-right">{hb(totals.otMin)}</td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-right">{hb(totals.lateMin)}</td>
                <td className="px-3 py-2 text-right">{hb(totals.earlyMin)}</td>
                <td className="px-3 py-2 text-right">{hb(totals.totalOtMin)}</td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-right">{db(totals.phDays)}</td>
                <td className="px-3 py-2 text-right">{db(totals.restDays)}</td>
                <td className="px-3 py-2 text-right">{db(totals.outstationDays)}</td>
                <td className="px-3 py-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </main>
  )
}
