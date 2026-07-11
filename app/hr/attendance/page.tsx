'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'
import { klTime, fmtMinutes } from '@/lib/attendance'
import {
  loadReport, prevMonthRange, dayNeedsAttn, weekdayOf, addDay, DOW_SHORT,
  LEAVE_TYPES, leaveBreakdown, tripBreakdown, type EmpBlock, type DayRow,
} from '@/lib/attendanceReport'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

// One short status label for a day on the printed card.
function dayStatusText(d: DayRow): string {
  if (d.kind === 'notEmployed') return 'Not employed'
  if (d.kind === 'off') return 'Rest day'
  if (d.kind === 'holiday') return 'Public holiday'
  if (d.kind === 'absent') return 'Absent' + (d.leaveType ? ` (${d.leaveType})` : '')
  if (d.kind === 'outstation') return d.leaveType ? `Leave (${d.leaveType})` : 'Outstation'
  const r = d.result
  if (r.needsReview) return 'Needs review'
  if (r.halfDay) return 'Half day' + (d.leaveType ? ` (${d.leaveType})` : '')
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
  const [onlyLeave, setOnlyLeave] = useState(false)
  const [search, setSearch] = useState('')
  const [location, setLocation] = useState('')   // '' = all locations/departments
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
      const res = await apiFetch('/api/attendance/sync')
      const json = await res.json()
      if (!res.ok) setError(json.error || 'Sync failed')
      else { setMsg(`Synced ${json.range?.from} → ${json.range?.to}: pulled ${json.pulled}, added ${json.inserted}.`); await load() }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSyncing(false) }
  }

  async function saveReview(code: string, date: string, decision: string, manual_minutes?: number) {
    const res = await apiFetch('/api/attendance/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, lunch_decision: decision, manual_minutes }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Review save failed') } else await load()
  }
  async function clearReview(code: string, date: string) {
    const res = await apiFetch('/api/attendance/review', {
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
    const res = await apiFetch('/api/attendance/review', {
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
    const res = await apiFetch('/api/attendance/review', {
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
    const res = await apiFetch('/api/attendance/outstation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, start_date: departure, end_date: end }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Failed') } else await load()
  }
  async function removeOutstation(id: string) {
    if (!confirm('Remove this outstation trip?')) return
    const res = await apiFetch('/api/attendance/outstation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Failed') } else await load()
  }

  // Set a driver's trip type for a day. Reload after saving so the OT-under-trip
  // rule recomputes — for a driver, switching a day to OS1/OS2 drops that day's OT.
  async function saveTrip(code: string, date: string, tripType: string) {
    setBlocks(bs => bs.map(b => b.code === code
      ? { ...b, days: b.days.map(d => d.dateKey === date ? { ...d, trip: tripType || null } : d) } : b))
    const res = await apiFetch('/api/attendance/driver-trip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, trip_type: tripType }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Trip save failed') } else await load()
  }

  // Set the leave type on an absent, outstation, or half-worked day. Optimistically
  // show the new label, then reload so the work/leave day counts are recomputed
  // correctly (each kind shifts the totals differently).
  async function saveLeave(code: string, date: string, leaveType: string) {
    setBlocks(bs => bs.map(b => b.code === code
      ? { ...b, days: b.days.map(d => d.dateKey === date ? { ...d, leaveType: leaveType || null } : d) } : b))
    const res = await apiFetch('/api/attendance/leave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, leave_type: leaveType }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Leave save failed') } else await load()
  }

  // Excuse (or un-excuse) one day's late/early so it isn't deducted from Total OT
  // on the Monthly Summary (optimistic — no full reload).
  async function saveExcuse(code: string, date: string, excused: boolean) {
    setBlocks(bs => bs.map(b => b.code === code
      ? { ...b, days: b.days.map(d => d.dateKey === date ? { ...d, lateExcused: excused } : d) } : b))
    const res = await apiFetch('/api/attendance/excuse-late', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, excused }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Excuse save failed') }
  }

  // Per-day flags: exclude that day's OT (exclude_ot) and/or force it to a half
  // day (force_half). Flip the day's flag OPTIMISTICALLY so the tick responds
  // instantly (the reload for correct totals takes a few seconds), then reload.
  async function saveDayFlag(code: string, date: string, patch: { exclude_ot?: boolean; force_half?: boolean }) {
    setBlocks(bs => bs.map(b => b.code === code ? { ...b, days: b.days.map(d => d.dateKey === date
      ? { ...d, otExcludedDay: patch.exclude_ot ?? d.otExcludedDay, forceHalf: patch.force_half ?? d.forceHalf } : d) } : b))
    const res = await apiFetch('/api/attendance/day-flag', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, ...patch }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
    await load()
  }

  // Month-level "total ignore" toggles (same as the Monthly summary). count OT off
  // skips all of this person's OT for the month; deduct off keeps late/early out of
  // Total OT. Reload after count-OT so the header OT total updates.
  async function saveCountOt(code: string, count: boolean) {
    setBlocks(bs => bs.map(b => b.code === code ? { ...b, otMonthOff: !count } : b))
    const res = await apiFetch('/api/attendance/ot-month', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, month: from.slice(0, 7), off: !count }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
    await load()
  }
  async function saveDeduct(code: string, deduct: boolean) {
    setBlocks(bs => bs.map(b => b.code === code ? { ...b, noDeductLate: !deduct } : b))
    const res = await apiFetch('/api/attendance/deduct-override', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, month: from.slice(0, 7), no_deduct: !deduct }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
  }

  // Ignore (or restore) one punch time on a day — drops a stray tap from pairing.
  async function toggleIgnorePunch(code: string, date: string, hm: string, ignore: boolean) {
    const res = await apiFetch('/api/attendance/ignore-punch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee_code: code, work_date: date, punch_hm: hm, ignore }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') } else await load()
  }

  // Build the printable HTML for one employee's attendance card.
  function cardHtml(b: EmpBlock): string {
    const leaveBreak = Object.entries(leaveBreakdown(b)).map(([k, v]) => `${k} ${v}`).join(', ')
    const rows = b.days.map(d => {
      const wend = weekdayOf(d.dateKey) === 0   // Sunday only (Saturday is a normal work day)
      const sessions = d.result.pairing.sessions
        .map(s => `${klTime(s.in)}–${s.out ? klTime(s.out) : '??'}`).join('<br>')
      const worked = d.kind === 'worked' && !d.result.needsReview ? fmtMinutes(d.result.workedMinutes) : ''
      const ot = d.kind === 'worked' && !d.result.needsReview && d.result.otMinutes > 0 ? fmtMinutes(d.result.otMinutes) : ''
      const le = [d.result.lateMinutes > 0 ? `late ${fmtMinutes(d.result.lateMinutes)}` : '',
      d.result.earlyOutMinutes > 0 ? `early ${fmtMinutes(d.result.earlyOutMinutes)}` : '',
      d.result.overLunchMinutes > 0 ? `lunch +${fmtMinutes(d.result.overLunchMinutes)}` : ''].filter(Boolean).join(', ')
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
        Late ${fmtMinutes(b.totalLate)} · Early-out ${fmtMinutes(b.totalEarlyOut)}${b.totalOverLunch > 0 ? ` · Over-lunch ${fmtMinutes(b.totalOverLunch)}` : ''} ·
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
  // A leave-relevant day: absent, a worked half-day, or an outstation day marked
  // as leave. Used by the "Only leave / ½ days" filter to jump straight to them.
  const dayIsLeave = (d: DayRow) => d.kind === 'absent' || (d.kind === 'worked' && d.result.halfDay) || (d.kind === 'outstation' && !!d.leaveType)
  // Location list = the distinct departments present, for the filter dropdown.
  const locations = [...new Set(blocks.map(b => b.department).filter(Boolean) as string[])].sort()
  const q = search.trim().toLowerCase()
  const shown = blocks.filter(b =>
    (!onlyReview || b.days.some(dayNeedsAttn)) &&
    (!onlyLeave || b.days.some(dayIsLeave)) &&
    (!location || b.department === location) &&
    (!q || b.name.toLowerCase().includes(q) || b.code.toLowerCase().includes(q))
  )
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
        <label className={`flex items-center gap-1.5 text-sm cursor-pointer rounded-md border px-3 py-1.5 ${onlyLeave ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-gray-300'}`}>
          <input type="checkbox" checked={onlyLeave} onChange={e => setOnlyLeave(e.target.checked)} />
          Only leave / ½ days
        </label>
        <label className="text-sm">Find person
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="name or code"
            className="block mt-1 rounded border border-gray-300 px-2 py-1" />
        </label>
        <label className="text-sm">Location
          <select value={location} onChange={e => setLocation(e.target.value)} className="block mt-1 rounded border border-gray-300 px-2 py-1">
            <option value="">All locations</option>
            {locations.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
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
        {loading ? 'Loading…' : `${punchCount} punches · ${shown.length === blocks.length ? blocks.length : `${shown.length} of ${blocks.length}`} people · OT total ${fmtMinutes(grandOt)} · ${fmtDate(from)} – ${fmtDate(to)}`}
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
                <label className="ml-2 inline-flex items-center gap-1 text-xs text-gray-600 cursor-pointer align-middle" title="Off = ignore ALL of this person's OT for the whole month">
                  <input type="checkbox" checked={!b.otMonthOff} onChange={e => saveCountOt(b.code, e.target.checked)} /> count OT
                </label>
                <label className="ml-2 inline-flex items-center gap-1 text-xs text-gray-600 cursor-pointer align-middle" title="Off = don't deduct this person's late/early from Total OT for the whole month">
                  <input type="checkbox" checked={!b.noDeductLate} onChange={e => saveDeduct(b.code, e.target.checked)} /> deduct late/early
                </label>
                {b.totalLate > 0 && <span className="ml-3 text-rose-600">Late {fmtMinutes(b.totalLate)}</span>}
                {b.totalEarlyOut > 0 && <span className="ml-3 text-rose-600">Early-out {fmtMinutes(b.totalEarlyOut)}</span>}
                {b.totalOverLunch > 0 && <span className="ml-3 text-rose-600" title="Lunch taken beyond the standard — deducted from OT, not from work hours">Over-lunch {fmtMinutes(b.totalOverLunch)}</span>}
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
                {(onlyReview ? b.days.filter(dayNeedsAttn) : onlyLeave ? b.days.filter(dayIsLeave) : b.days).map(({ dateKey, result, trip, manualTime, outstationId, kind, leaveType, lateExcused, otInTrip, otExcludedDay, forceHalf, punchTimes, ignoredTimes }) => (
                  <tr key={dateKey} className={`border-b border-gray-50 align-top ${result.needsReview ? 'bg-amber-50' : kind === 'absent' ? 'bg-rose-50' : (kind === 'worked' && result.halfDay) ? 'bg-amber-100' : kind === 'off' || kind === 'holiday' || kind === 'notEmployed' ? 'text-gray-400' : ''}`}>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {fmtDate(dateKey)} <span className={`ml-1 ${weekdayOf(dateKey) === 0 ? 'text-rose-500' : 'text-gray-400'}`}>{DOW_SHORT[weekdayOf(dateKey)]}</span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {punchTimes.map((hm, i) => {
                          const ign = ignoredTimes.includes(hm)
                          return (
                            <button key={i} type="button" onClick={() => toggleIgnorePunch(b.code, dateKey, hm, !ign)}
                              title={ign ? 'Ignored — click to use this punch again' : 'Click to ignore this punch (e.g. a fingerprint set-up tap)'}
                              className={`rounded px-1.5 py-0.5 text-xs cursor-pointer ${ign ? 'bg-gray-50 text-gray-400 line-through' : 'bg-gray-100 hover:bg-rose-100'}`}>
                              {hm}
                            </button>
                          )
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {result.pairing.sessions.map((s, i) => (
                        <div key={i} className="text-xs">{klTime(s.in)} → {s.out ? klTime(s.out) : <span className="text-red-600">??</span>}</div>
                      ))}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{kind === 'worked' ? (result.needsReview ? '—' : fmtMinutes(result.workedMinutes)) : '—'}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {kind === 'worked' && !result.needsReview && result.otMinutes > 0 ? (
                        otInTrip ? (
                          <span className="text-gray-400 line-through" title={`Driver on ${trip} — OT paid under the trip, not counted here`}>{fmtMinutes(result.otMinutes)}</span>
                        ) : b.otMonthOff ? (
                          <span className="text-gray-400 line-through" title="Count OT is off for this person this month">{fmtMinutes(result.otMinutes)}</span>
                        ) : (
                          <div>
                            <span className={otExcludedDay ? 'text-gray-400 line-through' : 'font-medium'}>{fmtMinutes(result.otMinutes)}</span>
                            <label className="mt-0.5 flex items-center gap-1 text-gray-500 text-xs cursor-pointer" title="Untick to NOT count this day's OT">
                              <input type="checkbox" checked={!otExcludedDay} onChange={e => saveDayFlag(b.code, dateKey, { exclude_ot: !e.target.checked })} />
                              OT
                            </label>
                          </div>
                        )
                      ) : '—'}
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
                        {result.overLunchMinutes > 0 && <span>{(result.lateMinutes > 0 || result.earlyOutMinutes > 0) ? ' · ' : ''}lunch +{fmtMinutes(result.overLunchMinutes)}</span>}
                      </span>
                      {kind === 'worked' && (result.lateMinutes > 0 || result.earlyOutMinutes > 0 || result.overLunchMinutes > 0) && (
                        <label className="mt-1 flex items-center gap-1 text-gray-500 cursor-pointer" title="Tick if there's a valid reason — this day's late/early won't be deducted from Total OT">
                          <input type="checkbox" checked={lateExcused} onChange={e => saveExcuse(b.code, dateKey, e.target.checked)} />
                          excuse
                        </label>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {kind === 'notEmployed' ? (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">Not employed</span>
                      ) : kind === 'off' ? (
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
                            <button onClick={() => saveReview(b.code, dateKey, 'span')} title="Ignore the missing/odd punch: count first punch → last punch, minus 1 hour lunch" className="rounded border border-green-300 bg-green-50 px-2 py-0.5 text-xs text-green-700 hover:bg-green-100">First→last −1h</button>
                            <button onClick={() => saveReview(b.code, dateKey, 'deduct')} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50">Deduct lunch</button>
                            <button onClick={() => saveReview(b.code, dateKey, 'worked_through')} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50">Worked through</button>
                            <button onClick={() => reviewManual(b.code, dateKey)} className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50">Manual mins…</button>
                            <button onClick={() => markOutstation(b.code, dateKey)} className="rounded border border-teal-300 bg-teal-50 px-2 py-0.5 text-xs text-teal-700 hover:bg-teal-100">Outstation…</button>
                          </div>
                        </div>
                      ) : result.outstation ? (
                        <span className="inline-flex items-center gap-2">
                          <span className={`rounded px-2 py-0.5 text-xs ${leaveType ? 'bg-rose-100 text-rose-800' : 'bg-teal-100 text-teal-800'}`}>{leaveType ? 'leave' : 'outstation'}</span>
                          <select value={leaveType ?? ''} onChange={e => saveLeave(b.code, dateKey, e.target.value)}
                            title="Mark the daytime as leave (e.g. absent by day, departed at night)"
                            className={`rounded border px-1 py-0.5 text-xs ${leaveType ? 'border-rose-300 bg-rose-50 text-rose-800' : 'border-gray-200 text-gray-400'}`}>
                            <option value="">leave type…</option>
                            {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
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
                          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">½ day worked</span>
                          <select value={leaveType ?? ''} onChange={e => saveLeave(b.code, dateKey, e.target.value)}
                            title="Choose what the OTHER (missing) half of the day is — e.g. Unpaid. Until you pick one it is not counted as that leave."
                            className={`rounded border px-1 py-0.5 text-xs ${leaveType ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-amber-400 bg-amber-50 text-amber-800 font-medium'}`}>
                            <option value="">other half = pick…</option>
                            {LEAVE_TYPES.filter(t => t !== 'Half').map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                          <button onClick={() => reviewSession(b.code, dateKey)} className="text-xs text-blue-600 underline">enter times…</button>
                          {forceHalf && <button onClick={() => saveDayFlag(b.code, dateKey, { force_half: false })} className="text-xs text-gray-400 underline" title="Undo — count as a full day again">undo ½</button>}
                        </span>
                      ) : result.presentDay ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">present</span>
                          <button onClick={() => saveDayFlag(b.code, dateKey, { force_half: true })} className="text-xs text-amber-600 underline" title="Count this as a half day (0.5 work + 0.5 leave)">make ½</button>
                        </span>
                      ) : result.dayType !== 'normal' ? (
                        <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-800">
                          {result.dayType === 'holiday' ? 'Public holiday' : 'Rest day'} · {result.dayUnits}d
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">OK</span>
                          <button onClick={() => saveDayFlag(b.code, dateKey, { force_half: true })} className="text-xs text-amber-600 underline" title="Count this as a half day (0.5 work + 0.5 leave)">make ½</button>
                        </span>
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
