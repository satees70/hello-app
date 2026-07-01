'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import {
  computeDay, outstationResult, emptyDay, klDateKey, klTime, fmtMinutes,
  type DayResult, type ShiftProfileLite, type ReviewLite,
} from '@/lib/attendance'

interface ShiftProfile extends ShiftProfileLite { id: string; name: string }
interface Employee { employee_code: string; name: string | null; shift_profile_id: string | null; delivery_name: string | null }
interface Punch { employee_code: string; punch_time: string; department_name: string | null }
interface Review extends ReviewLite { employee_code: string; work_date: string; manual_time: string | null }

type DayKind = 'worked' | 'outstation' | 'holiday' | 'off' | 'absent'
interface DayRow { dateKey: string; result: DayResult; trip: string | null; manualTime: string | null; outstationId: string | null; kind: DayKind; leaveType: string | null }
const LEAVE_TYPES = ['AL', 'MC', 'EL', 'Unpaid', 'Half']
// How much of a scheduled day a leave type consumes. A half-day is 0.5 leave +
// 0.5 work; every other type (and an untyped absence) is a full day off.
const leaveWeight = (t: string | null) => (t === 'Half' ? 0.5 : 1)
interface EmpBlock {
  code: string; name: string; department: string | null; profile: ShiftProfile | null; deliveryName: string | null
  days: DayRow[]; punches: number; totalWorked: number; totalOt: number; totalLate: number; totalEarlyOut: number
  totalRestDays: number; totalHolidayDays: number; totalPresentDays: number; totalOutstation: number
  workDays: number; leaveDays: number; needsReview: number
}

// Add one day to a 'yyyy-MM-dd' date string (UTC-stable).
function addDay(dk: string): string {
  const [y, m, d] = dk.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

// JS weekday (0=Sun..6=Sat) for a yyyy-MM-dd calendar date (tz-stable via UTC).
function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The previous complete month (payroll is usually run for the month just ended).
function prevMonthRange(): { from: string; to: string } {
  const [y, m] = klDateKey(new Date()).split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  const mm = String(pm).padStart(2, '0')
  const last = new Date(py, pm, 0).getDate()   // last day of month `pm` (1-based)
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, '0')}` }
}

export default function AttendancePage() {
  const [from, setFrom] = useState(() => prevMonthRange().from)
  const [to, setTo] = useState(() => prevMonthRange().to)
  const [onlyReview, setOnlyReview] = useState(false)
  const [tripOptions, setTripOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [punchCount, setPunchCount] = useState(0)
  const [blocks, setBlocks] = useState<EmpBlock[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const fromUtc = `${from}T00:00:00+08:00`
    const toUtc = `${to}T23:59:59+08:00`

    // Punches can be thousands — page past Supabase's 1000-row limit with fetchAll.
    const [punches, { data: emps }, { data: profs }, { data: reviews }] = await Promise.all([
      fetchAll<Punch>('attendance_punches', 'employee_code, punch_time, department_name',
        q => q.gte('punch_time', fromUtc).lte('punch_time', toUtc).order('punch_time')),
      supabase.from('employees').select('employee_code, name, shift_profile_id, delivery_name'),
      supabase.from('shift_profiles').select('id, name, normal_hours, lunch_rule, lunch_minutes, shift_start, shift_end, week_schedule, attendance_mode'),
      supabase.from('attendance_reviews').select('employee_code, work_date, lunch_decision, manual_minutes, manual_time')
        .gte('work_date', from).lte('work_date', to),
    ])
    const { data: hols } = await supabase.from('public_holidays').select('holiday_date').gte('holiday_date', from).lte('holiday_date', to)
    const holidaySet = new Set((hols || []).map(h => h.holiday_date))
    // Driver trips from the delivery schedule: (driver name | date) → category.
    const { data: trips } = await supabase.from('delivery_trips').select('driver, delivery_date, category').gte('delivery_date', from).lte('delivery_date', to)
    const tripByKey = new Map<string, string>()
    for (const t of trips || []) if (t.driver && t.category) tripByKey.set(`${t.driver}|${t.delivery_date}`, t.category)
    // Manual per-day trip overrides (employee_code | date) → trip_type.
    const { data: tripOv } = await supabase.from('driver_trip_overrides').select('employee_code, work_date, trip_type').gte('work_date', from).lte('work_date', to)
    const overrideByKey = new Map<string, string>()
    for (const o of tripOv || []) if (o.trip_type) overrideByKey.set(`${o.employee_code}|${o.work_date}`, o.trip_type)
    // Trip-type options for the dropdown = the schedule's categories + overrides.
    const opts = new Set<string>(['LOCAL', 'GCH', 'OS1', 'OS2'])
    for (const t of trips || []) if (t.category) opts.add(t.category)
    for (const o of tripOv || []) if (o.trip_type) opts.add(o.trip_type)
    setTripOptions([...opts].sort())
    // Leave types set on absent days: (employee_code | date) → leave_type.
    const { data: leaves } = await supabase.from('leave_days').select('employee_code, work_date, leave_type').gte('work_date', from).lte('work_date', to)
    const leaveByKey = new Map<string, string>()
    for (const l of leaves || []) if (l.leave_type) leaveByKey.set(`${l.employee_code}|${l.work_date}`, l.leave_type)
    // Outstation trips overlapping the range → per-employee map of dateKey → trip id.
    const { data: ostrips } = await supabase.from('outstation_trips').select('id, employee_code, start_date, end_date')
      .lte('start_date', to).gte('end_date', from)
    const outstationByEmp = new Map<string, Map<string, string>>()
    for (const t of ostrips || []) {
      const m = outstationByEmp.get(t.employee_code) ?? new Map<string, string>()
      let d = t.start_date < from ? from : t.start_date
      const end = t.end_date > to ? to : t.end_date
      while (d <= end) { m.set(d, t.id); d = addDay(d) }
      outstationByEmp.set(t.employee_code, m)
    }

    const empByCode = new Map<string, Employee>((emps || []).map(e => [e.employee_code, e as Employee]))
    const profById = new Map<string, ShiftProfile>((profs || []).map(p => [p.id, p as ShiftProfile]))
    const reviewByKey = new Map<string, Review>((reviews || []).map(r => [`${r.employee_code}|${r.work_date}`, r as Review]))

    // Group punches: code -> dateKey -> Date[]
    const grouped = new Map<string, Map<string, Date[]>>()
    const deptByCode = new Map<string, string | null>()
    for (const row of (punches || []) as Punch[]) {
      const d = new Date(row.punch_time)
      const key = klDateKey(d)
      if (!grouped.has(row.employee_code)) grouped.set(row.employee_code, new Map())
      const days = grouped.get(row.employee_code)!
      if (!days.has(key)) days.set(key, [])
      days.get(key)!.push(d)
      if (!deptByCode.has(row.employee_code)) deptByCode.set(row.employee_code, row.department_name)
    }

    // Every calendar date in the range (for counting scheduled work vs leave days).
    const rangeDates: string[] = []
    for (let d = from; d <= to; d = addDay(d)) rangeDates.push(d)

    const out: EmpBlock[] = []
    for (const [code, days] of grouped) {
      const emp = empByCode.get(code)
      const prof = emp?.shift_profile_id ? profById.get(emp.shift_profile_id) ?? null : null
      const deliveryName = emp?.delivery_name ?? null
      const osDates = outstationByEmp.get(code) ?? new Map<string, string>()
      const dayRows: DayRow[] = []
      let punches = 0, totalWorked = 0, totalOt = 0, totalLate = 0, totalEarlyOut = 0, totalRestDays = 0, totalHolidayDays = 0, totalPresentDays = 0, totalOutstation = 0, needsReview = 0
      let workDays = 0, leaveDays = 0
      const ws = prof?.week_schedule ?? null
      // Walk every calendar day in the range, so absent (leave) days show as rows too.
      for (const dateKey of rangeDates) {
        const times = days.get(dateKey) ?? []
        const isHol = holidaySet.has(dateKey)
        const win = ws ? ws[String(weekdayOf(dateKey))] : null
        // true = scheduled work day, false = rest/off, null = unknown (no profile).
        const scheduledWorking = ws ? !!(win && win.start && win.end) : null
        const autoTrip = deliveryName ? (tripByKey.get(`${deliveryName}|${dateKey}`) ?? null) : null
        const trip = overrideByKey.get(`${code}|${dateKey}`) ?? autoTrip
        const leaveType = leaveByKey.get(`${code}|${dateKey}`) ?? null

        // Outstation day → present, no OT, no review (punches still shown).
        if (osDates.has(dateKey)) {
          punches += times.length
          totalOutstation++
          if (scheduledWorking && !isHol) workDays++
          dayRows.push({ dateKey, result: outstationResult(times), trip, manualTime: null, outstationId: osDates.get(dateKey)!, kind: 'outstation', leaveType: null })
          continue
        }
        // A day with punches → the normal computed row.
        if (times.length > 0) {
          punches += times.length
          const review = reviewByKey.get(`${code}|${dateKey}`) ?? null
          // A manually-entered missing punch (HH:mm) is injected before pairing.
          const manualTime = review?.lunch_decision === 'manual_time' ? (review.manual_time ?? null) : null
          const dayTimes = manualTime ? [...times, new Date(`${dateKey}T${manualTime}:00+08:00`)] : times
          const result = computeDay(dayTimes, prof, review, { weekday: weekdayOf(dateKey), isHoliday: isHol })
          if (result.needsReview) needsReview++
          totalWorked += result.workedMinutes
          totalOt += result.otMinutes
          totalLate += result.lateMinutes
          totalEarlyOut += result.earlyOutMinutes
          if (result.dayType === 'rest') totalRestDays += result.dayUnits
          if (result.dayType === 'holiday') totalHolidayDays += result.dayUnits
          if (result.presentDay) totalPresentDays++
          if (scheduledWorking && !isHol) workDays++
          dayRows.push({ dateKey, result, trip, manualTime, outstationId: null, kind: 'worked', leaveType: null })
          continue
        }
        // No punches. Public holiday → shown, counted, not leave.
        if (isHol) {
          totalHolidayDays += 1
          dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'holiday', leaveType: null })
          continue
        }
        // No profile → we can't tell work day from rest day, so skip empty days.
        if (scheduledWorking === null) continue
        // Rest / off day.
        if (!scheduledWorking) {
          totalRestDays += 1
          dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'off', leaveType: null })
          continue
        }
        // Scheduled work day with no attendance → absent / leave (half-day = 0.5).
        const w = leaveWeight(leaveType)
        leaveDays += w
        workDays += 1 - w
        dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'absent', leaveType })
      }
      out.push({
        code, name: emp?.name || code, department: deptByCode.get(code) ?? null,
        profile: prof, deliveryName, days: dayRows, punches, totalWorked, totalOt, totalLate, totalEarlyOut, totalRestDays, totalHolidayDays, totalPresentDays, totalOutstation, workDays, leaveDays, needsReview,
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))

    setBlocks(out)
    setPunchCount((punches || []).length)
    setLoading(false)
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

  const fmtDate = (k: string) => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}` }
  const grandOt = blocks.reduce((s, b) => s + b.totalOt, 0)
  const totalToReview = blocks.reduce((s, b) => s + b.needsReview, 0)

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
        {blocks.filter(b => !onlyReview || b.needsReview > 0).map(b => (
          <section key={b.code} className="rounded-lg border border-gray-200 overflow-hidden">
            <header className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 px-4 py-2 border-b border-gray-200">
              <div>
                <span className="font-medium">{b.name}</span>
                <span className="text-gray-400 text-sm ml-2">{b.code}</span>
                {b.department && <span className="text-gray-400 text-sm ml-2">· {b.department}</span>}
                <span className="text-gray-400 text-sm ml-2">· {b.punches} punches · {b.days.length} days</span>
              </div>
              <div className="text-sm text-gray-600">
                {b.profile ? <span>{b.profile.name} · OT &gt; {b.profile.normal_hours}h · {b.profile.lunch_rule}</span>
                  : <span className="text-amber-600">no shift profile</span>}
                {b.profile && <span className="ml-3 font-medium text-gray-800">Work {b.workDays}d</span>}
                {b.leaveDays > 0 && (() => {
                  const lc: Record<string, number> = {}
                  for (const d of b.days) if (d.kind === 'absent' && d.leaveType) lc[d.leaveType] = (lc[d.leaveType] || 0) + 1
                  const parts = Object.entries(lc).map(([k, v]) => `${k} ${v}`)
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
                  const tc: Record<string, number> = {}
                  for (const d of b.days) if (d.trip) tc[d.trip] = (tc[d.trip] || 0) + 1
                  const parts = Object.entries(tc).map(([k, v]) => `${k} ${v}`)
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
                {(onlyReview ? b.days.filter(d => d.result.needsReview) : b.days).map(({ dateKey, result, trip, manualTime, outstationId, kind, leaveType }) => (
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
                    <td className="px-4 py-2 whitespace-nowrap">{kind === 'worked' && !result.needsReview && result.otMinutes > 0 ? <span className="font-medium">{fmtMinutes(result.otMinutes)}</span> : '—'}</td>
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
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-rose-600">
                      {result.lateMinutes > 0 && <span>late {fmtMinutes(result.lateMinutes)}</span>}
                      {result.lateMinutes > 0 && result.earlyOutMinutes > 0 && <span> · </span>}
                      {result.earlyOutMinutes > 0 && <span>early {fmtMinutes(result.earlyOutMinutes)}</span>}
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
