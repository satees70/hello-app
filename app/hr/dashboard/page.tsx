'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'
import { computeDay, klDateKey, klTime, type ShiftProfileLite } from '@/lib/attendance'
import { weekdayOf, addDay, DOW_SHORT, LEAVE_TYPES, loadReport } from '@/lib/attendanceReport'

// Live-ish HR attendance dashboard — "who is working / late / absent / on leave"
// today, computed from the ZKLink punches already synced into attendance_punches.
// Numbers use the same computeDay() the Attendance & OT page uses, so they agree.

interface Prof extends ShiftProfileLite { id: string }
interface Emp { employee_code: string; name: string | null; shift_profile_id: string | null; department: string | null }
type Status = 'working' | 'present' | 'absent' | 'leave' | 'off' | 'holiday' | 'unknown'
interface Row { code: string; name: string; department: string; status: Status; late: boolean; inTime: string | null; leaveType: string | null }

const STATUS_LABEL: Record<Status, string> = {
  working: 'Working', present: 'Done', absent: 'Absent', leave: 'On leave', off: 'Rest day', holiday: 'Holiday', unknown: '—',
}
const STATUS_STYLE: Record<Status, string> = {
  working: 'bg-green-100 text-green-700', present: 'bg-teal-100 text-teal-700', absent: 'bg-red-100 text-red-700',
  leave: 'bg-blue-100 text-blue-700', off: 'bg-gray-100 text-gray-500', holiday: 'bg-purple-100 text-purple-700', unknown: 'bg-gray-100 text-gray-400',
}

function Kpi({ label, value, color, active, onClick }: { label: string; value: number; color: string; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`text-left bg-white rounded-xl border shadow-sm p-4 w-full transition ${onClick ? 'cursor-pointer hover:border-gray-400' : ''} ${active ? 'ring-2 ring-blue-500 border-blue-400' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold ${color}`}>{value}</div>
    </button>
  )
}

function Donut({ segments }: { segments: { value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  const R = 54, C = 2 * Math.PI * R
  let offset = 0
  return (
    <svg viewBox="0 0 140 140" className="w-36 h-36 shrink-0">
      <g transform="translate(70,70) rotate(-90)">
        <circle r={R} fill="none" stroke="#eef0f2" strokeWidth="18" />
        {segments.filter(s => s.value > 0).map((s, i) => {
          const len = (s.value / total) * C
          const el = <circle key={i} r={R} fill="none" stroke={s.color} strokeWidth="18" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} strokeLinecap="butt" />
          offset += len
          return el
        })}
      </g>
      <text x="70" y="68" textAnchor="middle" className="fill-gray-800" fontSize="26" fontWeight="700">{total}</text>
      <text x="70" y="86" textAnchor="middle" className="fill-gray-400" fontSize="10">expected today</text>
    </svg>
  )
}

export default function HrDashboardPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [trendRaw, setTrendRaw] = useState<{ day: string; codes: string[] }[]>([])
  const [locFilter, setLocFilter] = useState('')   // '' = all locations
  const [sortBy, setSortBy] = useState<'latest' | 'name'>('latest')
  const [saving, setSaving] = useState(false)
  const today = klDateKey(new Date())

  // Record (or clear) a person's leave for today — straight from the dashboard.
  async function setLeave(code: string, type: string) {
    setSaving(true); setError(null)
    try {
      const res = await apiFetch('/api/attendance/leave', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_code: code, work_date: today, leave_type: type }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error || 'Could not save leave.'); return }
      await load()
    } finally { setSaving(false) }
  }
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [filter, setFilter] = useState<'working' | 'late' | 'absent' | 'leave' | null>(null)
  const [viewDate, setViewDate] = useState<string>(() => klDateKey(new Date()))   // yyyy-MM-dd being viewed
  const [punchIssues, setPunchIssues] = useState<{ code: string; name: string; date: string; reason: string }[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const today = viewDate
      const isToday = today === klDateKey(new Date())
      // 7-day window start (6 days before today).
      let weekStart = today
      for (let i = 0; i < 6; i++) weekStart = subDay(weekStart)
      const weekFromUtc = `${weekStart}T00:00:00+08:00`
      const todayToUtc = `${today}T23:59:59+08:00`

      const [emps, profs, punches, { data: leaves }, { data: hols }, { data: state }] = await Promise.all([
        supabase.from('employees').select('employee_code, name, shift_profile_id, department').eq('active', true),
        supabase.from('shift_profiles').select('id, normal_hours, lunch_rule, lunch_minutes, shift_start, shift_end, week_schedule, attendance_mode'),
        fetchAll<{ employee_code: string; punch_time: string; department_name: string | null }>(
          'attendance_punches', 'employee_code, punch_time, department_name',
          q => q.gte('punch_time', weekFromUtc).lte('punch_time', todayToUtc).order('punch_time')),
        supabase.from('leave_days').select('employee_code, leave_type').eq('work_date', today),
        supabase.from('public_holidays').select('holiday_date').eq('holiday_date', today),
        supabase.from('sync_state').select('last_synced_at').eq('key', 'zklink').maybeSingle(),
      ])
      setLastSync(state?.last_synced_at ?? null)

      const empList = (emps.data as Emp[]) || []
      const profById = new Map<string, Prof>(((profs.data as Prof[]) || []).map(p => [p.id, p]))
      const leaveByEmp = new Map<string, string>((leaves || []).map(l => [l.employee_code, l.leave_type]))
      const isHoliday = (hols || []).length > 0

      // Punches → per employee, per KL day.
      const byEmpDay = new Map<string, Map<string, Date[]>>()
      for (const p of punches || []) {
        const d = new Date(p.punch_time); const key = klDateKey(d)
        if (!byEmpDay.has(p.employee_code)) byEmpDay.set(p.employee_code, new Map())
        const m = byEmpDay.get(p.employee_code)!
        if (!m.has(key)) m.set(key, [])
        m.get(key)!.push(d)
      }

      const wd = weekdayOf(today)
      const out: Row[] = []
      for (const e of empList) {
        const prof = e.shift_profile_id ? profById.get(e.shift_profile_id) ?? null : null
        const ws = prof?.week_schedule ?? null
        const win = ws ? ws[String(wd)] : null
        const scheduled = ws ? !!(win && win.start && win.end) : null   // null = no profile
        const times = byEmpDay.get(e.employee_code)?.get(today) ?? []
        const leaveType = leaveByEmp.get(e.employee_code)

        let status: Status = 'unknown'; let late = false; let inTime: string | null = null
        if (leaveType) status = 'leave'
        else if (isHoliday && !times.length) status = 'holiday'
        else if (scheduled === false && !times.length) status = 'off'
        else if (times.length > 0) {
          const res = computeDay(times, prof, null, { weekday: wd, isHoliday })
          inTime = klTime([...times].sort((a, b) => a.getTime() - b.getTime())[0])
          late = res.lateMinutes > 0
          // Odd punches = still clocked in → "working" only makes sense for today;
          // on a past day everyone with punches was simply "present".
          status = (res.pairing.needsReview && isToday) ? 'working' : 'present'
        } else if (scheduled) status = 'absent'
        else status = 'unknown'

        out.push({ code: e.employee_code, name: e.name || e.employee_code, department: e.department || '—', status, late, inTime, leaveType: leaveType ?? null })
      }
      // Live list: working first, then late, then the rest; by name.
      const rank: Record<Status, number> = { working: 0, present: 2, absent: 3, leave: 4, holiday: 5, off: 6, unknown: 7 }
      out.sort((a, b) => (a.late === b.late ? 0 : a.late ? -1 : 1) + (rank[a.status] - rank[b.status]) * 10 || a.name.localeCompare(b.name))
      setRows(out)

      // Weekly trend: distinct employees with any punch each day.
      const days: { day: string; codes: string[] }[] = []
      for (let d = weekStart; d <= today; d = addDay(d)) {
        const present: string[] = []
        for (const [code, m] of byEmpDay) if ((m.get(d)?.length ?? 0) > 0) present.push(code)
        days.push({ day: DOW_SHORT[weekdayOf(d)], codes: present })
      }
      setTrendRaw(days)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [viewDate])
  useEffect(() => { load() }, [load])

  // Outstanding punch issues (a missing clock-out / odd punches) over the last ~30
  // days up to the viewed day — the SAME "needs review" days the Attendance & OT
  // page shows (loadReport already excludes ones that were reviewed/resolved).
  const loadIssues = useCallback(async () => {
    try {
      let from = viewDate
      for (let i = 0; i < 30; i++) from = subDay(from)
      const { blocks } = await loadReport(from, viewDate)
      const issues: { code: string; name: string; date: string; reason: string }[] = []
      for (const b of blocks) for (const d of b.days) {
        if (d.result.needsReview) issues.push({ code: b.code, name: b.name || b.code, date: d.dateKey, reason: d.result.reviewReason || 'Missing a clock-out' })
      }
      issues.sort((a, b2) => b2.date.localeCompare(a.date) || a.name.localeCompare(b2.name))
      setPunchIssues(issues)
    } catch { /* don't let the issues panel break the rest of the dashboard */ }
  }, [viewDate])
  useEffect(() => { loadIssues() }, [loadIssues])

  async function syncNow() {
    setSyncing(true); setError(null); setSyncMsg(null)
    try {
      const res = await apiFetch('/api/attendance/sync')
      const text = await res.text()
      let j: { error?: string; pulled?: number; inserted?: number; range?: { from?: string; to?: string } } = {}
      try { j = JSON.parse(text) } catch { /* non-JSON response (e.g. an HTML error page) */ }
      if (!res.ok) {
        setError(`Sync failed (HTTP ${res.status}): ${j.error || text.slice(0, 300) || 'no details returned'}`)
      } else {
        // Show what actually came back so a "nothing happened" sync is diagnosable:
        // pulled 0 = the clock isn't uploading punches; pulled >0 = it's working.
        setSyncMsg(`Sync OK — pulled ${j.pulled ?? '?'} punch(es) from the clock, added ${j.inserted ?? '?'} new, for ${j.range?.from ?? '?'} → ${j.range?.to ?? '?'}.`)
      }
      await load()
    } catch (e) { setError('Could not reach the sync service: ' + (e instanceof Error ? e.message : String(e))) }
    finally { setSyncing(false) }
  }

  const todayKey = klDateKey(new Date())
  const isToday = viewDate === todayKey
  // Location (department) filter — restricts every number & list to one location.
  const locations = [...new Set(rows.map(r => r.department))].sort()
  const visibleRows = locFilter ? rows.filter(r => r.department === locFilter) : rows

  const workingNow = visibleRows.filter(r => r.status === 'working').length
  const lateCount = visibleRows.filter(r => (r.status === 'working' || r.status === 'present') && r.late).length
  const absentCount = visibleRows.filter(r => r.status === 'absent').length
  const leaveCount = visibleRows.filter(r => r.status === 'leave').length
  const presentTotal = visibleRows.filter(r => r.status === 'working' || r.status === 'present').length
  const onTime = presentTotal - lateCount
  // Per-location (department) attendance today.
  const byDept = new Map<string, { present: number; expected: number }>()
  for (const r of visibleRows) {
    if (r.status === 'off' || r.status === 'holiday' || r.status === 'unknown') continue
    const d = byDept.get(r.department) ?? { present: 0, expected: 0 }
    d.expected++
    if (r.status === 'working' || r.status === 'present') d.present++
    byDept.set(r.department, d)
  }
  const depts = [...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  // Weekly present trend, restricted to the chosen location if any.
  const deptOf = new Map(rows.map(r => [r.code, r.department]))
  const visibleIssues = locFilter ? punchIssues.filter(i => (deptOf.get(i.code) || '') === locFilter) : punchIssues
  const fmtDay = (dk: string) => new Date(`${dk}T00:00:00+08:00`).toLocaleDateString([], { day: '2-digit', month: 'short' })
  const trend = trendRaw.map(t => ({ day: t.day, present: locFilter ? t.codes.filter(c => deptOf.get(c) === locFilter).length : t.codes.length }))
  const trendMax = Math.max(1, ...trend.map(t => t.present))
  // Tap a KPI card to filter the live list to that group (tap again to clear).
  const filterLabel = filter === 'working' ? (isToday ? 'working now' : 'present') : filter === 'late' ? 'late' : filter === 'absent' ? 'absent' : filter === 'leave' ? 'on leave' : ''
  const onLeaveRows = visibleRows.filter(r => r.status === 'leave').sort((a, b) => a.name.localeCompare(b.name))
  const absentRows = visibleRows.filter(r => r.status === 'absent').sort((a, b) => a.name.localeCompare(b.name))
  const shownRows = !filter ? visibleRows : visibleRows.filter(r =>
    filter === 'late' ? ((r.status === 'working' || r.status === 'present') && r.late)
    : filter === 'working' ? (r.status === 'working' || (!isToday && r.status === 'present'))
    : filter === 'absent' ? r.status === 'absent'
    : r.status === 'leave')
  // Live-list order: by latest clock-in (late arrivals on top), or by name.
  const liveRows = [...shownRows].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name)
    if (a.inTime && b.inTime) return b.inTime.localeCompare(a.inTime)   // 'HH:mm' → later first
    if (a.inTime) return -1
    if (b.inTime) return 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-bold">Attendance Dashboard</h1>
        <div className="flex items-center gap-2">
          <input type="date" value={viewDate} max={todayKey}
            onChange={e => { setViewDate(e.target.value || todayKey); setFilter(null) }}
            className="text-sm border rounded-lg px-2 py-2 bg-white" title="Pick a day to view its summary" />
          {!isToday && <button onClick={() => { setViewDate(todayKey); setFilter(null) }} className="text-sm border rounded-lg px-3 py-2 bg-white hover:bg-gray-50 whitespace-nowrap">Today</button>}
          <select value={locFilter} onChange={e => setLocFilter(e.target.value)} className="text-sm border rounded-lg px-2 py-2 bg-white max-w-[12rem]">
            <option value="">All locations</option>
            {locations.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <button onClick={syncNow} disabled={syncing} className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">{syncing ? 'Syncing…' : '↻ Sync from clock'}</button>
        </div>
      </div>
      <p className="text-gray-500 text-sm mb-5">
        {isToday ? 'Today' : 'Viewing'}, {viewDate} · {visibleRows.length} staff{locFilter ? ` in ${locFilter}` : ' active'}
        {lastSync && <> · as of last sync {new Date(lastSync).toLocaleString()}</>}
      </p>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 whitespace-pre-wrap break-words">{error}</div>}
      {syncMsg && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2 break-words">{syncMsg}</div>}
      {loading ? <div className="text-gray-400 py-16 text-center">Loading…</div> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <Kpi label={isToday ? 'Working now' : 'Present'} value={isToday ? workingNow : presentTotal} color="text-green-600" active={filter === 'working'} onClick={() => setFilter(f => f === 'working' ? null : 'working')} />
            <Kpi label="Late today" value={lateCount} color="text-amber-600" active={filter === 'late'} onClick={() => setFilter(f => f === 'late' ? null : 'late')} />
            <Kpi label="Absent" value={absentCount} color="text-red-600" active={filter === 'absent'} onClick={() => setFilter(f => f === 'absent' ? null : 'absent')} />
            <Kpi label="On leave" value={leaveCount} color="text-blue-600" active={filter === 'leave'} onClick={() => setFilter(f => f === 'leave' ? null : 'leave')} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4 mb-4">
            {/* Summary donut */}
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <div className="font-semibold text-sm mb-3">{isToday ? 'Today at a glance' : 'At a glance'}</div>
              <div className="flex items-center gap-4">
                <Donut segments={[
                  { value: onTime, color: '#16a34a' },
                  { value: lateCount, color: '#d97706' },
                  { value: absentCount, color: '#dc2626' },
                  { value: leaveCount, color: '#2563eb' },
                ]} />
                <ul className="text-sm space-y-1.5">
                  <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm bg-green-600 inline-block" /> On time <b className="ml-auto">{onTime}</b></li>
                  <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm bg-amber-600 inline-block" /> Late <b className="ml-auto">{lateCount}</b></li>
                  <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm bg-red-600 inline-block" /> Absent <b className="ml-auto">{absentCount}</b></li>
                  <li className="flex items-center gap-2"><span className="w-3 h-3 rounded-sm bg-blue-600 inline-block" /> On leave <b className="ml-auto">{leaveCount}</b></li>
                </ul>
              </div>
            </div>

            {/* Weekly trend */}
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <div className="font-semibold text-sm mb-3">Present this week</div>
              <div className="flex items-end justify-between gap-2 h-36">
                {trend.map((t, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1">
                    <span className="text-[11px] text-gray-500">{t.present}</span>
                    <div className="w-full rounded-t bg-blue-500" style={{ height: `${(t.present / trendMax) * 100}%`, minHeight: t.present ? 4 : 0 }} />
                    <span className="text-[11px] text-gray-400">{t.day}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Location overview */}
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <div className="font-semibold text-sm mb-3">By location</div>
              {depts.length === 0 ? <p className="text-gray-400 text-sm">No data.</p> : (
                <ul className="space-y-2 text-sm max-h-36 overflow-auto">
                  {depts.map(([d, v]) => { const pct = v.expected ? Math.round((v.present / v.expected) * 100) : 0; return (
                    <li key={d}>
                      <div className="flex justify-between text-xs mb-0.5"><span className="truncate">{d}</span><span className="text-gray-500">{v.present}/{v.expected} · {pct}%</span></div>
                      <div className="h-2 rounded bg-gray-100"><div className="h-2 rounded bg-green-500" style={{ width: `${pct}%` }} /></div>
                    </li>
                  ) })}
                </ul>
              )}
            </div>
          </div>

          {/* On leave + Absent lists */}
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div className="bg-white rounded-xl border shadow-sm">
              <div className="px-4 py-2 border-b font-semibold text-sm">🌴 On leave today <span className="text-gray-400 font-normal">· {onLeaveRows.length}</span></div>
              {onLeaveRows.length === 0 ? (
                <p className="px-4 py-4 text-gray-400 text-sm">No one on leave today.</p>
              ) : (
                <ul className="divide-y max-h-72 overflow-auto">
                  {onLeaveRows.map(r => (
                    <li key={r.code} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-gray-400 text-xs">{r.code}</span>
                      <select value={r.leaveType || ''} disabled={saving} onChange={e => setLeave(r.code, e.target.value)} className="ml-auto text-xs border rounded px-1.5 py-1 bg-blue-50 text-blue-700 font-medium">
                        {r.leaveType && !LEAVE_TYPES.includes(r.leaveType) && <option value={r.leaveType}>{r.leaveType}</option>}
                        {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        <option value="">✕ remove</option>
                      </select>
                      <span className="text-gray-500 text-xs w-20 truncate text-right">{r.department}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bg-white rounded-xl border shadow-sm">
              <div className="px-4 py-2 border-b font-semibold text-sm">🚫 Absent today <span className="text-gray-400 font-normal">· {absentRows.length}</span></div>
              {absentRows.length === 0 ? (
                <p className="px-4 py-4 text-gray-400 text-sm">No absentees 🎉</p>
              ) : (
                <ul className="divide-y max-h-72 overflow-auto">
                  {absentRows.map(r => (
                    <li key={r.code} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <span className="font-medium">{r.name}</span>
                      <span className="text-gray-400 text-xs">{r.code}</span>
                      <select value="" disabled={saving} onChange={e => e.target.value && setLeave(r.code, e.target.value)} className="ml-auto text-xs border rounded px-1.5 py-1 bg-white text-gray-600">
                        <option value="">Mark leave…</option>
                        {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <span className="text-gray-500 text-xs w-20 truncate text-right">{r.department}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Punch issues to review (missing clock-out / odd punches) */}
          <div className="bg-white rounded-xl border shadow-sm mb-4">
            <div className="px-4 py-2 border-b font-semibold text-sm flex flex-wrap items-center gap-x-2">
              <span>⚠ Punch issues to review <span className="text-gray-400 font-normal">· {visibleIssues.length}{locFilter ? ` in ${locFilter}` : ''} · last 30 days</span></span>
              <a href="/hr/attendance" className="ml-auto text-xs font-normal text-blue-600 hover:underline">Fix in Attendance &amp; OT →</a>
            </div>
            {visibleIssues.length === 0 ? (
              <p className="px-4 py-4 text-gray-400 text-sm">No punch issues 🎉 — every clock-in has a matching clock-out.</p>
            ) : (
              <ul className="divide-y max-h-72 overflow-auto">
                {visibleIssues.map(i => (
                  <li key={`${i.code}|${i.date}`} className="flex items-center gap-2 px-4 py-2 text-sm">
                    <span className="text-gray-500 text-xs w-14 shrink-0">{fmtDay(i.date)}</span>
                    <span className="font-medium">{i.name}</span>
                    <span className="text-gray-400 text-xs">{i.code}</span>
                    <span className="ml-auto text-amber-700 text-xs text-right">{i.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Live list */}
          <div className="bg-white rounded-xl border shadow-sm">
            <div className="px-4 py-2 border-b font-semibold text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Live attendance <span className="text-gray-400 font-normal">· {presentTotal} in / {visibleRows.length} staff</span></span>
              {filter && <span className="font-normal text-xs text-blue-600">· showing {filterLabel} ({shownRows.length}) <button onClick={() => setFilter(null)} className="underline ml-1">show all</button></span>}
              <select value={sortBy} onChange={e => setSortBy(e.target.value as 'latest' | 'name')} className="ml-auto text-xs font-normal border rounded px-1.5 py-1 bg-white">
                <option value="latest">Latest clock-in first</option>
                <option value="name">Name (A–Z)</option>
              </select>
            </div>
            <div className="overflow-auto max-h-[28rem]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b sticky top-0"><tr>{['Staff', 'Status', filter === 'leave' ? 'Leave' : 'In', 'Location'].map(h => <th key={h} className="text-left px-4 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>
                  {liveRows.length === 0 && <tr><td colSpan={4} className="text-center py-6 text-gray-400">{filter ? `No one ${filterLabel}.` : 'No staff.'}</td></tr>}
                  {liveRows.map(r => (
                    <tr key={r.code} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-4 py-2"><span className="font-medium">{r.name}</span> <span className="text-gray-400 text-xs">{r.code}</span></td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                        {r.late && (r.status === 'working' || r.status === 'present') && <span className="ml-1 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Late</span>}
                      </td>
                      <td className={`px-4 py-2 whitespace-nowrap ${r.late ? 'text-amber-600 font-medium' : 'text-gray-600'}`}>{r.status === 'leave' ? (r.leaveType || 'Leave') : (r.inTime || '—')}</td>
                      <td className="px-4 py-2 text-gray-500">{r.department}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// One day earlier than a 'yyyy-MM-dd' date string (UTC-stable).
function subDay(dk: string): string {
  const [y, m, d] = dk.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}
