'use client'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'

type DayWin = { start: string; end: string } | null
interface ShiftProfile { id: string; name: string; normal_hours: number; lunch_rule: string; lunch_minutes: number; week_schedule: Record<string, DayWin> | null; attendance_mode: string | null }
interface Employee { employee_code: string; name: string | null; shift_profile_id: string | null; is_driver: boolean; is_production: boolean; active: boolean; department: string | null; delivery_name: string | null; crew_role: string | null; join_date: string | null; resign_date: string | null }
interface Row extends Employee { seenInPunches: boolean; lastSeen: string | null }
interface Holiday { holiday_date: string; name: string | null }

// Weekday columns, Monday first; value = JS getDay() index (0=Sun..6=Sat).
const DOW: { key: string; label: string }[] = [
  { key: '1', label: 'Mon' }, { key: '2', label: 'Tue' }, { key: '3', label: 'Wed' },
  { key: '4', label: 'Thu' }, { key: '5', label: 'Fri' }, { key: '6', label: 'Sat' }, { key: '0', label: 'Sun' },
]
type WeekEdit = Record<string, { on: boolean; start: string; end: string }>
function defaultWeek(): WeekEdit {
  const w: WeekEdit = {}
  for (const d of DOW) w[d.key] = { on: d.key !== '0' && d.key !== '6', start: '08:30', end: '17:00' }
  return w
}

export default function EmployeesSetupPage() {
  const [profiles, setProfiles] = useState<ShiftProfile[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [reportMonth, setReportMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [newProf, setNewProf] = useState({ name: '', normal_hours: '7.5', lunch_rule: 'punch', lunch_minutes: '60', attendance_mode: 'pair' })
  const [week, setWeek] = useState<WeekEdit>(defaultWeek())
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [newHol, setNewHol] = useState({ holiday_date: '', name: '' })
  const [filterActive, setFilterActive] = useState<'active' | 'inactive' | 'all'>('active')
  const [filterDept, setFilterDept] = useState('')
  const [filterProfile, setFilterProfile] = useState('')   // '' all · 'none' unassigned · <id>
  const [search, setSearch] = useState('')
  const [deliveryDrivers, setDeliveryDrivers] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const [{ data: profs }, { data: emps }, codes, { data: hols }, { data: drv }] = await Promise.all([
      supabase.from('shift_profiles').select('id, name, normal_hours, lunch_rule, lunch_minutes, week_schedule, attendance_mode').order('name'),
      supabase.from('employees').select('employee_code, name, shift_profile_id, is_driver, is_production, active, department, delivery_name, crew_role'),
      fetchAll<{ employee_code: string; punch_time: string }>('attendance_punches', 'employee_code, punch_time'),
      supabase.from('public_holidays').select('holiday_date, name').order('holiday_date'),
      // Delivery link comes from the unified crew pool (kind 'crew' + legacy 'driver'/'kelindan'), not just 'driver'.
      supabase.from('delivery_resources').select('name').neq('kind', 'lorry').eq('active', true).order('name'),
    ])
    setHolidays((hols as Holiday[]) || [])
    setDeliveryDrivers([...new Set((drv || []).map(d => d.name))])
    const empByCode = new Map<string, Employee>((emps || []).map(e => [e.employee_code, e as Employee]))
    // Last punch per person (for the "Last seen" column).
    const lastByCode = new Map<string, string>()
    for (const c of codes) { const cur = lastByCode.get(c.employee_code); if (!cur || c.punch_time > cur) lastByCode.set(c.employee_code, c.punch_time) }
    const punchCodes = new Set(lastByCode.keys())
    const allCodes = new Set<string>([...empByCode.keys(), ...punchCodes])

    const list: Row[] = [...allCodes].sort().map(code => {
      const e = empByCode.get(code)
      return {
        employee_code: code,
        name: e?.name ?? '',
        shift_profile_id: e?.shift_profile_id ?? null,
        is_driver: e?.is_driver ?? false,
        is_production: e?.is_production ?? false,
        active: e?.active ?? true,
        department: e?.department ?? null,
        delivery_name: e?.delivery_name ?? null,
        crew_role: e?.crew_role ?? null,
        join_date: e?.join_date ?? null,
        resign_date: e?.resign_date ?? null,
        seenInPunches: punchCodes.has(code),
        lastSeen: lastByCode.get(code) ?? null,
      }
    })
    // Group people by their ZKLink department so profiles are easy to assign in runs.
    list.sort((a, b) => (a.department || '~').localeCompare(b.department || '~') || a.employee_code.localeCompare(b.employee_code))
    setProfiles((profs as ShiftProfile[]) || [])
    setRows(list)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function saveEmployee(r: Row, patch: Partial<Row>) {
    const next = { ...r, ...patch }
    setRows(rs => rs.map(x => x.employee_code === r.employee_code ? next : x))
    const res = await apiFetch('/api/attendance/employees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_code: r.employee_code, name: next.name,
        shift_profile_id: next.shift_profile_id, is_driver: next.is_driver, is_production: next.is_production, active: next.active,
        delivery_name: next.delivery_name, crew_role: next.crew_role,
        join_date: next.join_date, resign_date: next.resign_date,
      }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
  }

  async function addProfile(e: FormEvent) {
    e.preventDefault()
    if (!newProf.name.trim()) return
    // Build week_schedule from the grid; a fallback start/end = first working day.
    const week_schedule: Record<string, DayWin> = {}
    let fb: { start: string; end: string } | null = null
    for (const d of DOW) {
      const w = week[d.key]
      if (w.on && w.start && w.end) { week_schedule[d.key] = { start: w.start, end: w.end }; fb = fb || { start: w.start, end: w.end } }
      else week_schedule[d.key] = null
    }
    const res = await apiFetch('/api/attendance/shift-profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...newProf, week_schedule, shift_start: fb?.start || '', shift_end: fb?.end || '' }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
    else { setNewProf({ name: '', normal_hours: '7.5', lunch_rule: 'punch', lunch_minutes: '60', attendance_mode: 'pair' }); setWeek(defaultWeek()); await load() }
  }

  async function addHoliday(e: FormEvent) {
    e.preventDefault()
    if (!newHol.holiday_date) return
    const res = await apiFetch('/api/attendance/holidays', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newHol),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Save failed') }
    else { setNewHol({ holiday_date: '', name: '' }); await load() }
  }
  async function deleteHoliday(date: string) {
    const res = await apiFetch('/api/attendance/holidays', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', holiday_date: date }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Delete failed') } else await load()
  }
  const setDay = (key: string, patch: Partial<{ on: boolean; start: string; end: string }>) =>
    setWeek(w => ({ ...w, [key]: { ...w[key], ...patch } }))

  async function deleteProfile(id: string) {
    if (!confirm('Delete this shift profile? Employees using it will be left without one.')) return
    const res = await apiFetch('/api/attendance/shift-profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Delete failed') } else await load()
  }

  async function pullNames() {
    setPulling(true); setError(null); setMsg(null)
    try {
      const res = await apiFetch('/api/attendance/employees/sync')
      const j = await res.json()
      if (!res.ok) setError(j.error || 'Pull failed')
      else { setMsg(`Pulled ${j.pulled} employees from ZKLink, updated ${j.upserted}.`); await load() }
    } finally { setPulling(false) }
  }

  async function setActiveFromAttendance() {
    if (!confirm('Set Active/Inactive from attendance? Anyone with no punch in the last 14 days is marked inactive. You can still edit each one after.')) return
    setError(null); setMsg(null)
    const res = await apiFetch('/api/attendance/employees/refresh-active', { method: 'POST' })
    const j = await res.json()
    if (!res.ok) setError(j.error || 'Failed')
    else { setMsg(`Active updated: ${j.active} active, ${j.inactive} inactive (based on last ${j.windowDays} days).`); await load() }
  }

  // Print a joiners & leavers report for the chosen month from the Joined / Left
  // dates (join_date / resign_date).
  function printJoinersLeavers() {
    const esc = (s: string) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const dmy = (d: string) => { const [y, m, day] = d.split('-'); return `${day}/${m}/${y}` }
    const inMonth = (d: string | null) => !!d && d.slice(0, 7) === reportMonth
    const joined = rows.filter(r => inMonth(r.join_date)).sort((a, b) => (a.join_date || '').localeCompare(b.join_date || ''))
    const left = rows.filter(r => inMonth(r.resign_date)).sort((a, b) => (a.resign_date || '').localeCompare(b.resign_date || ''))
    const tbl = (title: string, list: Row[], dateOf: (r: Row) => string, col: string) => `<h2>${title} (${list.length})</h2>` + (list.length
      ? `<table><thead><tr><th class="n">#</th><th>Code</th><th>Name</th><th>Department</th><th>${col}</th></tr></thead><tbody>${list.map((r, i) =>
          `<tr><td class="n">${i + 1}</td><td>${esc(r.employee_code)}</td><td>${esc(r.name || '')}</td><td>${esc(r.department || '')}</td><td>${dmy(dateOf(r))}</td></tr>`).join('')}</tbody></table>`
      : `<p class="none">None</p>`)
    const [yy, mm] = reportMonth.split('-')
    const monthName = new Date(Number(yy), Number(mm) - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    const css = `* { font-family: -apple-system, Segoe UI, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @page { size: A4; margin: 12mm; } body { margin: 0; color: #111; }
      h1 { font-size: 16px; margin: 0 0 8px; } h2 { font-size: 13px; margin: 14px 0 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th, td { border: 1px solid #bbb; padding: 3px 6px; text-align: left; } th { background: #eee; }
      td.n, th.n { text-align: center; width: 28px; } .none { color: #777; font-size: 11px; }`
    const win = window.open('', '_blank')
    if (!win) { setError('Please allow pop-ups to print.'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Joiners & leavers</title><style>${css}</style></head><body>
      <h1>Joiners &amp; leavers — ${monthName}</h1>
      ${tbl('Joined', joined, r => r.join_date!, 'Joined')}
      ${tbl('Left / resigned', left, r => r.resign_date!, 'Left')}
    </body></html>`)
    win.document.close(); win.focus()
    setTimeout(() => win.print(), 350)
  }

  const named = rows.filter(r => r.name).length
  const withProfile = rows.filter(r => r.shift_profile_id).length
  const depts = [...new Set(rows.map(r => r.department).filter(Boolean))].sort() as string[]
  const visibleRows = rows.filter(r => {
    if (filterActive === 'active' && !r.active) return false
    if (filterActive === 'inactive' && r.active) return false
    if (filterDept && r.department !== filterDept) return false
    if (filterProfile === 'none' && r.shift_profile_id) return false
    if (filterProfile && filterProfile !== 'none' && r.shift_profile_id !== filterProfile) return false
    if (search.trim()) { const s = search.toLowerCase(); if (!`${r.name} ${r.employee_code} ${r.department}`.toLowerCase().includes(s)) return false }
    return true
  })

  return (
    <main className="max-w-5xl mx-auto p-4 sm:p-6">
      <h1 className="text-2xl font-semibold mb-1">Employees &amp; shifts</h1>
      <p className="text-sm text-gray-500 mb-4">Set each person&apos;s name and shift profile. The shift profile decides their OT threshold and how lunch is handled.</p>

      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
      {msg && <div className="mb-4 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800">{msg}</div>}

      {/* Shift profiles */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="font-medium mb-3">Shift profiles</h2>
        {profiles.length === 0 && <p className="text-sm text-gray-400 mb-2">No profiles yet. Add at least one (e.g. a “punch lunch” and an “auto-deduct” profile).</p>}
        <div className="space-y-1 mb-3">
          {profiles.map(p => {
            const ws = p.week_schedule
            const work = DOW.filter(d => ws?.[d.key]).map(d => `${d.label} ${ws![d.key]!.start}–${ws![d.key]!.end}`)
            const off = DOW.filter(d => ws && !ws[d.key]).map(d => d.label)
            return (
            <div key={p.id} className="flex items-start gap-3 text-sm">
              <span className="font-medium whitespace-nowrap">{p.name}</span>
              <span className="text-gray-500">
                {ws ? work.join(', ') : `OT > ${p.normal_hours}h (every day)`}
                {off.length > 0 && <span className="text-gray-400"> · off: {off.join('/')}</span>}
                {p.attendance_mode === 'single'
                  ? ' · 1 punch = present (no OT)'
                  : <>{' · OT 30m grace, nearest 15m · lunch '}{p.lunch_rule}{p.lunch_rule === 'auto_deduct' ? ` ${p.lunch_minutes}m` : ''}</>}
              </span>
              <button onClick={() => deleteProfile(p.id)} className="text-xs text-red-600 hover:underline whitespace-nowrap">delete</button>
            </div>
            )
          })}
        </div>
        <form onSubmit={addProfile} className="border-t border-gray-100 pt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">Name
              <input value={newProf.name} onChange={e => setNewProf({ ...newProf, name: e.target.value })}
                placeholder="e.g. Office 8:30" className="block mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
            </label>
            <label className="text-xs">Lunch
              <select value={newProf.lunch_rule} onChange={e => setNewProf({ ...newProf, lunch_rule: e.target.value })}
                className="block mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm">
                <option value="punch">punch (they clock lunch)</option>
                <option value="auto_deduct">auto-deduct</option>
              </select>
            </label>
            <label className="text-xs">Lunch mins
              <input type="number" value={newProf.lunch_minutes} onChange={e => setNewProf({ ...newProf, lunch_minutes: e.target.value })}
                className="block mt-0.5 w-20 rounded border border-gray-300 px-2 py-1 text-sm" />
            </label>
            <label className="text-xs">Full day (h)
              <input type="number" step="0.5" value={newProf.normal_hours} onChange={e => setNewProf({ ...newProf, normal_hours: e.target.value })}
                title="A normal day's hours — used to count rest-day work as full vs half day" className="block mt-0.5 w-20 rounded border border-gray-300 px-2 py-1 text-sm" />
            </label>
            <label className="text-xs flex items-center gap-1.5 pb-1.5 self-end">
              <input type="checkbox" checked={newProf.attendance_mode === 'single'}
                onChange={e => setNewProf({ ...newProf, attendance_mode: e.target.checked ? 'single' : 'pair' })} />
              Salesman (1 punch = present)
            </label>
          </div>

          {/* Weekly schedule grid */}
          <div className="rounded-md border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-7 text-center text-xs">
              {DOW.map(d => {
                const w = week[d.key]
                return (
                  <div key={d.key} className={`border-r border-gray-100 last:border-r-0 p-2 ${w.on ? '' : 'bg-gray-50'}`}>
                    <label className="flex items-center justify-center gap-1 font-medium cursor-pointer">
                      <input type="checkbox" checked={w.on} onChange={e => setDay(d.key, { on: e.target.checked })} />
                      {d.label}
                    </label>
                    {w.on ? (
                      <div className="mt-1 space-y-1">
                        <input type="time" value={w.start} onChange={e => setDay(d.key, { start: e.target.value })}
                          className="w-full rounded border border-gray-300 px-1 py-0.5 text-xs" />
                        <input type="time" value={w.end} onChange={e => setDay(d.key, { end: e.target.value })}
                          className="w-full rounded border border-gray-300 px-1 py-0.5 text-xs" />
                      </div>
                    ) : <div className="mt-1 text-gray-400 text-xs py-1">off</div>}
                  </div>
                )
              })}
            </div>
          </div>

          <button type="submit" className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-white">Add profile</button>
        </form>
      </section>

      {/* Public holidays */}
      <section className="mb-6 rounded-lg border border-gray-200 p-4">
        <h2 className="font-medium mb-1">Public holidays</h2>
        <p className="text-sm text-gray-500 mb-3">Work on these dates is counted in days (its own bucket), like a rest day.</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {holidays.length === 0 && <span className="text-sm text-gray-400">None yet.</span>}
          {holidays.map(h => (
            <span key={h.holiday_date} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs">
              {h.holiday_date.split('-').reverse().join('/')}{h.name ? ` · ${h.name}` : ''}
              <button onClick={() => deleteHoliday(h.holiday_date)} className="text-red-600 ml-1">×</button>
            </span>
          ))}
        </div>
        <form onSubmit={addHoliday} className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Date
            <input type="date" value={newHol.holiday_date} onChange={e => setNewHol({ ...newHol, holiday_date: e.target.value })}
              className="block mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
          </label>
          <label className="text-xs">Name (optional)
            <input value={newHol.name} onChange={e => setNewHol({ ...newHol, name: e.target.value })}
              placeholder="e.g. Hari Raya" className="block mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" />
          </label>
          <button type="submit" className="rounded-md bg-gray-800 px-3 py-1.5 text-sm text-white">Add holiday</button>
        </form>
      </section>

      {/* Employees */}
      <section className="rounded-lg border border-gray-200 overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-2 bg-gray-50 px-4 py-2 border-b border-gray-200">
          <span className="text-sm text-gray-600">{rows.length} people · {named} named · {withProfile} with a shift · {rows.filter(r => r.active).length} active · {rows.filter(r => r.is_production).length} production</span>
          <div className="flex flex-wrap items-center gap-2">
            <input type="month" lang="en-GB" value={reportMonth} onChange={e => setReportMonth(e.target.value)}
              title="Month for the joiners & leavers report" className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            <button onClick={printJoinersLeavers}
              className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
              Joiners / leavers
            </button>
            <button onClick={setActiveFromAttendance}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50">
              Set active from attendance
            </button>
            <button onClick={pullNames} disabled={pulling}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {pulling ? 'Pulling…' : 'Pull names from ZKLink'}
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-end gap-2 px-4 py-2 border-b border-gray-100 bg-gray-50 text-xs">
          <label>Show
            <select value={filterActive} onChange={e => setFilterActive(e.target.value as 'active' | 'inactive' | 'all')}
              className="block mt-0.5 rounded border border-gray-300 px-2 py-1">
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
              <option value="all">All</option>
            </select>
          </label>
          <label>Department
            <select value={filterDept} onChange={e => setFilterDept(e.target.value)}
              className="block mt-0.5 rounded border border-gray-300 px-2 py-1">
              <option value="">All departments</option>
              {depts.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label>Shift profile
            <select value={filterProfile} onChange={e => setFilterProfile(e.target.value)}
              className="block mt-0.5 rounded border border-gray-300 px-2 py-1">
              <option value="">All profiles</option>
              <option value="none">No profile yet</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="flex-1 min-w-[8rem]">Search
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="name or code…"
              className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1" />
          </label>
          <span className="text-gray-500 pb-1">{visibleRows.length} shown</span>
        </div>

        {loading ? <p className="p-4 text-sm text-gray-500">Loading…</p> : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[64rem]">
            <thead className="text-left text-gray-500">
              <tr className="border-b border-gray-100">
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Department</th>
                <th className="px-3 py-2 font-medium">Shift profile</th>
                <th className="px-3 py-2 font-medium" title="Ticked people appear in the Production module (e.g. Grinding “Grind by”)">Production</th>
                <th className="px-3 py-2 font-medium">Driver</th>
                <th className="px-3 py-2 font-medium">Delivery link</th>
                <th className="px-3 py-2 font-medium" title="Joined date (days before are 'Not employed') / Left date (days after are 'Not employed')">Joined / Left</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
                <th className="px-3 py-2 font-medium">Active</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(r => (
                <tr key={r.employee_code} className="border-b border-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                    {r.employee_code}
                    {!r.seenInPunches && <span className="ml-1 text-gray-300" title="no punches yet">·</span>}
                  </td>
                  <td className="px-3 py-2">
                    <input defaultValue={r.name ?? ''} placeholder="name…"
                      onBlur={e => { if (e.target.value !== (r.name ?? '')) saveEmployee(r, { name: e.target.value }) }}
                      className="w-full min-w-[16rem] rounded border border-gray-200 px-2 py-1" />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{r.department || '—'}</td>
                  <td className="px-3 py-2">
                    <select value={r.shift_profile_id ?? ''} onChange={e => saveEmployee(r, { shift_profile_id: e.target.value || null })}
                      className="rounded border border-gray-200 px-2 py-1">
                      <option value="">—</option>
                      {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={r.is_production} onChange={e => saveEmployee(r, { is_production: e.target.checked })} title="Show this person in the Production module" />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={r.is_driver} onChange={e => saveEmployee(r, { is_driver: e.target.checked })} />
                  </td>
                  <td className="px-3 py-2">
                    {r.is_driver ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <select value={r.delivery_name ?? ''} onChange={e => saveEmployee(r, { delivery_name: e.target.value || null })}
                          className="rounded border border-gray-200 px-2 py-1 text-xs" title="Which name this person uses in the delivery schedule">
                          <option value="">— link —</option>
                          {deliveryDrivers.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select value={r.crew_role ?? ''} onChange={e => saveEmployee(r, { crew_role: e.target.value || null })}
                          className={`rounded border px-2 py-1 text-xs ${r.crew_role === 'driver' ? 'border-indigo-300 bg-indigo-50 text-indigo-800' : 'border-gray-200 text-gray-500'}`}
                          title="Driver = OS1/OS2 trip days paid under the trip, no OT (even riding as kelindan). Kelindan = OT as normal.">
                          <option value="">role…</option>
                          <option value="driver">Driver</option>
                          <option value="kelindan">Kelindan</option>
                        </select>
                      </div>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <input type="date" lang="en-GB" value={r.join_date ?? ''} onChange={e => saveEmployee(r, { join_date: e.target.value || null })}
                        className="rounded border border-gray-200 px-1 py-0.5 text-xs" title="Joined — days before this are 'Not employed'" />
                      <input type="date" lang="en-GB" value={r.resign_date ?? ''} onChange={e => saveEmployee(r, { resign_date: e.target.value || null })}
                        className="rounded border border-gray-200 px-1 py-0.5 text-xs" title="Left / resigned — days after this are 'Not employed'" />
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {r.lastSeen ? new Date(r.lastSeen).toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: '2-digit' }) : <span className="text-gray-300">never</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={r.active} onChange={e => saveEmployee(r, { active: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </main>
  )
}
