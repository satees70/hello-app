'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { klTime, fmtMinutes } from '@/lib/attendance'
import {
  loadReport, prevMonthRange, leaveWeight, dayNeedsAttn, weekdayOf, addDay, DOW_SHORT,
  LEAVE_TYPES, leaveBreakdown, tripBreakdown, type EmpBlock, type DayRow,
} from '@/lib/attendanceReport'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

// One short status label for a day on the printed card.
function dayStatusText(d: DayRow): string {
  if (d.kind === 'off') return 'Rest day'
  if (d.kind === 'holiday') return 'Public holiday'
  if (d.kind === 'absent') return 'Absent' + (d.leaveType ? ` (${d.leaveType})` : '')
  if (d.kind === 'outstation') return 'Outstation'
  const r = d.result
  if (r.needsReview) return 'Needs review'
  if (r.halfDay) return 'Half day'
  if (r.presentDay) return 'Present'
  if (r.dayType !== 'normal') return `${r.dayType === 'holiday' ? 'Public holiday' : 'Rest day'} ${r.dayUnits}d`
  return 'OK'
}

// Stylesheet for the printable attendance cards — one employee per page.
const PRINT_CSS = `
  * { font-family: -apple-system, Segoe UI, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  @page { size: A4; margin: 12mm; }
  body { margin: 0; color: #111; }
  .card { page-break-after: always; }
  .card:last-child { page-break-after: auto; }
  h1 { font-size: 15px; margin: 0; }
  .meta { font-size: 12px; color: #333; margin: 2px 0 6px; }
  .summary { font-size: 11px; margin: 6px 0 8px; line-height: 1.6; }
  .summary b { color: #000; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th, td { border: 1px solid #bbb; padding: 2px 5px; text-align: left; }
  th { background: #eee; }
  td.n { text-align: right; white-space: nowrap; }
  .wend { color: #b00020; }
  .sub { color: #666; }
`

export default function AttendancePage() {
  const [from, setFrom] = useState(() => prevMonthRange().from)
  const [to, setTo] = useState(() => prevMonthRange().to)
  const [onlyReview, setOnlyReview] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tripOptions, setTripOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [punchCount, setPunchCount] = useState(0)
  const [blocks, setBlocks] = useState<EmpBlock[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { blocks, tripOptions, punchCount } = await loadReport(from, to)
      setBlocks(blocks)
      setTripOptions(tripOptions)
      setPunchCount(punchCount)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  async function syncNow() {
    setSyncing(true); setMsg(null); setError(null)
    try {
      const res = await fetch('/api/attendance/sync')
      const json = await res.json()
      if (!res.ok) setError(json.error || 'Sync failed')
      else { setMsg(`Synced ${json.range?.from} → ${json.range?.to}: pulled ${json.pulled}, added ${json.inserted}.`); await load() }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSyncing(false) }
  }

  async function saveReview(code: string, date: string, decision: string, manual_minutes?: number) {
    const res = await fetch('/api/attendance/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, lunch_decision: decision, manual_minutes }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Review save failed') } else await load()
  }
  async function clearReview(code: string, date: string) {
    const res = await fetch('/api/attendance/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, action: 'clear' }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Clear failed') } else await load()
  }
  function reviewManual(code: string, date: string) {
    const v = prompt('Worked minutes for this day (e.g. 450 = 7h 30m):')
    if (v == null || v.trim() === '') return
    saveReview(code, date, 'manual', Number(v))
  }
  async function reviewTime(code: string, date: string) {
    const v = prompt('Enter the missing clock time (24-hour, e.g. 19:00):')
    if (v == null || v.trim() === '') return
    const m = /^(\d{1,2}):(\d{2})/.exec(v.trim())
    if (!m) { setError('Please enter the time as HH:mm, e.g. 19:00'); return }
    const time = `${m[1].padStart(2, '0')}:${m[2]}`
    const res = await fetch('/api/attendance/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, lunch_decision: 'manual_time', manual_time: time }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') } else await load()
  }
  // Enter one or more worked clock times (24-hour). They're ADDED to the day's
  // existing punches and re-paired, so OT is computed from the shift window —
  // e.g. entering 08:30 19:00 gives a full day plus OT after 17:00.
  async function reviewSession(code: string, date: string) {
    const v = prompt('Enter the worked clock times (24-hour) — one or more, e.g. 08:30 19:00.\nThese are ADDED to any existing punches:')
    if (v == null || v.trim() === '') return
    const toks = v.match(/\d{1,2}:\d{2}/g)
    if (!toks || toks.length === 0) { setError('Enter times as HH:mm, e.g. 08:30 19:00'); return }
    const span = toks.map(t => t.padStart(5, '0')).join(', ')
    const res = await fetch('/api/attendance/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, lunch_decision: 'manual_time', manual_time: span }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') } else await load()
  }

  async function markOutstation(code: string, departure: string) {
    const v = prompt(`Outstation from ${fmtDate(departure)}.\nEnter the RETURN date (dd/mm/yyyy):`)
    if (v == null || v.trim() === '') return
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v.trim())
    if (!m) { setError('Enter the return date as dd/mm/yyyy'); return }
    const end = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    const res = await fetch('/api/attendance/outstation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, start_date: departure, end_date: end }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Failed') } else await load()
  }
  async function removeOutstation(id: string) {
    if (!confirm('Remove this outstation trip?')) return
    const res = await fetch('/api/attendance/outstation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Failed') } else await load()
  }

  // Set a driver's trip type for a day (optimistic — no full reload).
  async function saveTrip(code: string, date: string, tripType: string) {
    setBlocks(bs => bs.map(b => b.code === code
      ? { ...b, days: b.days.map(d => d.dateKey === date ? { ...d, trip: tripType || null } : d) } : b))
    const res = await fetch('/api/attendance/driver-trip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, trip_type: tripType }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Trip save failed') }
  }

  // Set the leave type on an absent day (optimistic — no full reload).
  async function saveLeave(code: string, date: string, leaveType: string) {
    setBlocks(bs => bs.map(b => {
      if (b.code !== code) return b
      const old = b.days.find(d => d.dateKey === date)
      if (!old || old.kind !== 'absent') return b
      const oldW = leaveWeight(old.leaveType), newW = leaveWeight(leaveType || null)
      return {
        ...b,
        days: b.days.map(d => d.dateKey === date ? { ...d, leaveType: leaveType || null } : d),
        leaveDays: b.leaveDays - oldW + newW,
        workDays: b.workDays - (1 - oldW) + (1 - newW),
      }
    }))
    const res = await fetch('/api/attendance/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, leave_type: leaveType }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Leave save failed') }
  }

  // Excuse (or un-excuse) one day's late/early so it isn't deducted from Total OT
  // on the Monthly Summary (optimistic — no full reload).
  async function saveExcuse(code: string, date: string, excused: boolean) {
    setBlocks(bs => bs.map(b => b.code === code
      ? { ...b, days: b.days.map(d => d.dateKey === date ? { ...d, lateExcused: excused } : d) } : b))
    const res = await fetch('/api/attendance/excuse-late', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, excused }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Excuse save failed') }
  }

  // Build the printable HTML for one employee's attendance card.
  function cardHtml(b: EmpBlock): string {
    const leaveBreak = Object.entries(leaveBreakdown(b)).map(([k, v]) => `${k} ${v}`).join(', ')
    const rows = b.days.map(d => {
      const wend = [0, 6].includes(weekdayOf(d.dateKey))
      const sessions = d.result.pairing.sessions
        .map(s => `${klTime(s.in)}–${s.out ? klTime(s.out) : '??'}`).join('<br>')
      const worked = d.kind === 'worked' && !d.result.needsReview ? fmtMinutes(d.result.workedMinutes) : ''
      const ot = d.kind === 'worked' && !d.result.needsReview && d.result.otMinutes > 0 ? fmtMinutes(d.result.otMinutes) : ''
      const le = [d.result.lateMinutes > 0 ? `late ${fmtMinutes(d.result.lateMinutes)}` : '',
      d.result.earlyOutMinutes > 0 ? `early ${fmtMinutes(d.result.earlyOutMinutes)}` : ''].filter(Boolean).join(', ')
      return `<tr>
        <td class="${wend ? 'wend' : ''}">${fmtDate(d.dateKey)} ${DOW_SHORT[weekdayOf(d.dateKey)]}</td>
        <td>${sessions}</td>
        <td class="n">${worked}</td>
        <td class="n">${ot}</td>
        ${b.deliveryName ? `<td>${esc(d.trip || '')}</td>` : ''}
        <td class="sub">${esc(le)}</td>
        <td>${esc(dayStatusText(d))}</td>
      </tr>`
    }).join('')
    return `<div class="card">
      <h1>Attendance Card — ${esc(b.name)}</h1>
      <div class="meta">${esc(b.code)}${b.department ? ' · ' + esc(b.department) : ''}${b.profile ? ' · ' + esc(b.profile.name) : ''} &nbsp;|&nbsp; ${fmtDate(from)} – ${fmtDate(to)}</div>
      <div class="summary">
        <b>Work ${b.workDays}d</b> ·
        Leave ${b.leaveDays}d${leaveBreak ? ` (${leaveBreak})` : ''} ·
        Worked ${fmtMinutes(b.totalWorked)} · <b>OT ${fmtMinutes(b.totalOt)}</b> ·
        Late ${fmtMinutes(b.totalLate)} · Early-out ${fmtMinutes(b.totalEarlyOut)} ·
        Rest ${b.totalRestDays}d · PH ${b.totalHolidayDays}d ·
        Present ${b.totalPresentDays}d · Outstation ${b.totalOutstation}d
      </div>
      <table>
        <thead><tr>
          <th>Date</th><th>In–Out</th><th>Worked</th><th>OT</th>
          ${b.deliveryName ? '<th>Trip</th>' : ''}<th>Late / early</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
  }

  // Open a print window with one attendance card per selected employee (1 per page).
  function printCards(codes: string[]) {
    const chosen = blocks.filter(b => codes.includes(b.code))
    if (chosen.length === 0) { setError('Select at least one person to print.'); return }
    const win = window.open('', '_blank')
    if (!win) { setError('Please allow pop-ups for this site to print.'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Attendance cards</title><style>${PRINT_CSS}</style></head><body>${chosen.map(cardHtml).join('')}</body></html>`)
    win.document.close()
    win.focus()
    setTimeout(() => { win.print() }, 350)
  }

  const fmtDate = (k: string) => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}` }
  const grandOt = blocks.reduce((s, b) => s + b.totalOt, 0)
  const totalToReview = blocks.reduce((s, b) => s + b.days.filter(dayNeedsAttn).length, 0)
  const shown = blocks.filter(b => !onlyReview || b.days.some(dayNeedsAttn))
  const toggleSelect = (code: string) => setSelected(s => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n })
  const selectAllShown = () => setSelected(new Set(shown.map(b => b.code)))

  return (
    <main className="max-w-6xl mx-auto p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Attendance &amp; OT</h1>
          <p className="text-sm text-gray-500">Worked hours and overtime (over each shift&apos;s threshold). Kuala Lumpur time.</p>
        </div>
        <button onClick={syncNow} disabled={syncing}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
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
        <label className={`flex items-center gap-1.5 text-sm cursor-pointer rounded-md border px-3 py-1.5 ${onlyReview ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-gray-300'}`}>
          <input type="checkbox" checked={onlyReview} onChange={e => setOnlyReview(e.target.checked)} />
          Only needs review{totalToReview > 0 ? ` (${totalToReview})` : ''}
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={selectAllShown} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Select all</button>
          {selected.size > 0 && <button onClick={() => setSelected(new Set())} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50">Clear</button>}
          <button onClick={() => printCards([...selected])} disabled={selected.size === 0}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
            Print cards{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>

      {msg && <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">{msg}</div>}
      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}

      <p className="text-sm text-gray-500 mb-4">
        {loading ? 'Loading…' : `${punchCount} punches · ${blocks.length} people · OT total ${fmtMinutes(grandOt)} · ${fmtDate(from)} – ${fmtDate(to)}`}
      </p>

      {!loading && punchCount === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-500">
          No punches yet. Hit <b>Sync now</b> to pull from ZKLink.
        </div>
      )}

      <div className="space-y-6">
        {shown.map(b => (
          <section key={b.code} className="rounded-lg border border-gray-200 overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 px-4 py-2 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selected.has(b.code)} onChange={() => toggleSelect(b.code)} title="Select for printing" className="cursor-pointer" />
                <span className="font-medium">{b.name}</span>
                <span className="text-gray-400 text-sm ml-2">{b.code}</span>
                {b.department && <span className="text-gray-400 text-sm ml-2">· {b.department}</span>}
                <span className="text-gray-400 text-sm ml-2">· {b.punches} punches · {b.days.length} days</span>
                <button onClick={() => printCards([b.code])} className="text-sm text-indigo-600 underline ml-2">print</button>
              </div>
              <div className="text-sm text-gray-600">
                {b.profile ? <span>{b.profile.name} · OT &gt; {b.profile.normal_hours}h · {b.profile.lunch_rule}</span>
                  : <span className="text-amber-600">no shift profile</span>}
                {b.profile && <span className="ml-3 font-medium text-gray-800">Work {b.workDays}d</span>}
                {b.leaveDays > 0 && (() => {
                  const parts = Object.entries(leaveBreakdown(b)).map(([k, v]) => `${k} ${v}`)
                  return <span className="ml-3 text-rose-600">Leave {b.leaveDays}d{parts.length ? ` (${parts.join(', ')})` : ''}</span>
                })()}
                <span className="ml-3">Worked {fmtMinutes(b.totalWorked)}</span>
                <span className="ml-3 font-medium text-gray-800">OT {fmtMinutes(b.totalOt)}</span>
                {b.totalLate > 0 && <span className="ml-3 text-rose-600">Late {fmtMinutes(b.totalLate)}</span>}
                {b.totalEarlyOut > 0 && <span className="ml-3 text-rose-600">Early-out {fmtMinutes(b.totalEarlyOut)}</span>}
                {b.totalRestDays > 0 && <span className="ml-3 text-purple-700">Rest {b.totalRestDays}d</span>}
                {b.totalHolidayDays > 0 && <span className="ml-3 text-purple-700">PH {b.totalHolidayDays}d</span>}
                {b.totalPresentDays > 0 && <span className="ml-3 font-medium text-gray-800">Present {b.totalPresentDays}d</span>}
                {b.totalOutstation > 0 && <span className="ml-3 text-teal-700">Outstation {b.totalOutstation}d</span>}
                {b.needsReview > 0 && <span className="ml-3 text-amber-700">{b.needsReview} to review</span>}
                {b.deliveryName && (() => {
                  const parts = Object.entries(tripBreakdown(b)).map(([k, v]) => `${k} ${v}`)
                  return <span className="ml-3 text-indigo-700">Trips ({b.deliveryName}): {parts.length ? parts.join(', ') : '0'}</span>
                })()}
              </div>
            </header>
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500">
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Punches</th>
                  <th className="px-4 py-2 font-medium">Sessions</th>
                  <th className="px-4 py-2 font-medium">Worked</th>
                  <th className="px-4 py-2 font-medium">OT</th>
                  {b.deliveryName && <th className="px-4 py-2 font-medium">Trip</th>}
                  <th className="px-4 py-2 font-medium">Late / early</th>
                  <th className="px-4 py-2 font-medium">Status / review</th>
                </tr>
              </thead>
              <tbody>
                {(onlyReview ? b.days.filter(dayNeedsAttn) : b.days).map(({ dateKey, result, trip, manualTime, outstationId, kind, leaveType, lateExcused, otInTrip }) => (
                  <tr key={dateKey} className={`border-b border-gray-50 align-top ${result.needsReview ? 'bg-amber-50' : kind === 'absent' ? 'bg-rose-50' : kind === 'off' || kind === 'holiday' ? 'text-gray-400' : ''}`}>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {fmtDate(dateKey)} <span className={`ml-1 ${[0, 6].includes(weekdayOf(dateKey)) ? 'text-rose-500' : 'text-gray-400'}`}>{DOW_SHORT[weekdayOf(dateKey)]}</span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {result.pairing.sessions.flatMap(s => [s.in, s.out].filter(Boolean) as Date[]).map((t, i) => (
                          <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{klTime(t)}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {result.pairing.sessions.map((s, i) => (
                        <div key={i} className="text-xs">{klTime(s.in)} → {s.out ? klTime(s.out) : <span className="text-red-600">??</span>}</div>
                      ))}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{kind === 'worked' ? (result.needsReview ? '—' : fmtMinutes(result.workedMinutes)) : '—'}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {kind === 'worked' && !result.needsReview && result.otMinutes > 0
                        ? (otInTrip
                          ? <span className="text-gray-400 line-through" title={`Driver on ${trip} — OT paid under the trip, not counted here`}>{fmtMinutes(result.otMinutes)}</span>
                          : <span className="font-medium">{fmtMinutes(result.otMinutes)}</span>)
                        : '—'}
                    </td>
                    {b.deliveryName && (
                      <td className="px-4 py-2 whitespace-nowrap">
                        {kind === 'worked' || kind === 'outstation' ? (
                          <select value={trip ?? ''} onChange={e => saveTrip(b.code, dateKey, e.target.value)}
                            className={`rounded border px-1 py-0.5 text-xs ${trip ? 'border-indigo-200 bg-indigo-50 text-indigo-800' : 'border-gray-200 text-gray-400'}`}>
                            <option value="">—</option>
                            {tripOptions.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                    )}
                    <td className="px-4 py-2 whitespace-nowrap text-xs">
                      <span className={lateExcused ? 'text-gray-400 line-through' : 'text-rose-600'}>
                        {result.lateMinutes > 0 && <span>late {fmtMinutes(result.lateMinutes)}</span>}
                        {result.lateMinutes > 0 && result.earlyOutMinutes > 0 && <span> · </span>}
                        {result.earlyOutMinutes > 0 && <span>early {fmtMinutes(result.earlyOutMinutes)}</span>}
                      </span>
                      {kind === 'worked' && (result.lateMinutes > 0 || result.earlyOutMinutes > 0) && (
                        <label className="mt-1 flex items-center gap-1 text-gray-500 cursor-pointer" title="Tick if there's a valid reason — this day's late/early won't be deducted from Total OT">
                          <input type="checkbox" checked={lateExcused} onChange={e => saveExcuse(b.code, dateKey, e.target.checked)} />
                          excuse
                        </label>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {kind === 'off' ? (
                        <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-800">Rest day</span>
                      ) : kind === 'holiday' ? (
                        <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-800">Public holiday</span>
                      ) : kind === 'absent' ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">absent</span>
                          <select value={leaveType ?? ''} onChange={e => saveLeave(b.code, dateKey, e.target.value)}
                            className={`rounded border px-1 py-0.5 text-xs ${leaveType ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-gray-200 text-gray-400'}`}>
                            <option value="">leave type…</option>
                            {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <button onClick={() => reviewSession(b.code, dateKey)} className="text-xs text-blue-600 underline">enter times…</button>
                        </span>
                      ) : result.needsReview ? (
                        <div>
                          <div className="text-xs text-amber-700 mb-1">{result.reviewReason}</div>
                          <div className="flex flex-wrap gap-1">
                            <button onClick={() => reviewTime(b.code, dateKey)} className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-100">Enter time…</button>
                            <button onClick={() => saveReview(b.code, dateKey, 'deduct')} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50">Deduct lunch</button>
                            <button onClick={() => saveReview(b.code, dateKey, 'worked_through')} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50">Worked through</button>
                            <button onClick={() => reviewManual(b.code, dateKey)} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50">Manual mins…</button>
                            <button onClick={() => markOutstation(b.code, dateKey)} className="rounded border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-700 hover:bg-teal-100">Outstation…</button>
                          </div>
                        </div>
                      ) : result.outstation ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="rounded bg-teal-100 px-2 py-0.5 text-xs text-teal-800">outstation</span>
                          {outstationId && <button onClick={() => removeOutstation(outstationId)} className="text-xs text-gray-400 underline">remove</button>}
                        </span>
                      ) : result.reviewed ? (
                        <span className="inline-flex items-center gap-2">
                          {manualTime
                            ? <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-800" title="A clock time was entered manually">✎ manual ({manualTime})</span>
                            : <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800">reviewed</span>}
                          <button onClick={() => clearReview(b.code, dateKey)} className="text-xs text-gray-400 underline">clear</button>
                        </span>
                      ) : result.halfDay ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">½ day</span>
                          <button onClick={() => reviewSession(b.code, dateKey)} className="text-xs text-blue-600 underline">enter times…</button>
                        </span>
                      ) : result.presentDay ? (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">present</span>
                      ) : result.dayType !== 'normal' ? (
                        <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-800">
                          {result.dayType === 'holiday' ? 'Public holiday' : 'Rest day'} · {result.dayUnits}d
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </main>
  )
}
