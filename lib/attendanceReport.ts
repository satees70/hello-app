import { supabase, fetchAll } from '@/lib/supabase'
import {
  computeDay, outstationResult, emptyDay, klDateKey,
  type DayResult, type ShiftProfileLite, type ReviewLite,
} from '@/lib/attendance'

// Shared per-employee attendance report builder. Both the Attendance & OT detail
// page and the Monthly Summary page load their numbers from here, so the summary
// always matches the detail exactly.

export interface ShiftProfile extends ShiftProfileLite { id: string; name: string }
export interface Employee { employee_code: string; name: string | null; shift_profile_id: string | null; delivery_name: string | null; crew_role: string | null; join_date: string | null; resign_date: string | null }
export interface Punch { employee_code: string; punch_time: string; department_name: string | null }
export interface Review extends ReviewLite { employee_code: string; work_date: string; manual_time: string | null }

export type DayKind = 'worked' | 'outstation' | 'holiday' | 'off' | 'absent' | 'notEmployed'
export interface DayRow { dateKey: string; result: DayResult; trip: string | null; manualTime: string | null; outstationId: string | null; kind: DayKind; leaveType: string | null; lateExcused: boolean; otInTrip: boolean }

// Trip categories whose overtime a DRIVER earns under the trip, not as OT here.
const OT_IN_TRIP_CATEGORIES = new Set(['OS1', 'OS2'])

export const LEAVE_TYPES = ['AL', 'MC', 'EL', 'Unpaid', 'Half']
// How much of a scheduled day a leave type consumes. A half-day is 0.5 leave +
// 0.5 work; every other type (and an untyped absence) is a full day off.
export const leaveWeight = (t: string | null) => (t === 'Half' ? 0.5 : 1)
// A day still needing a human: a missing clock-out, or an absence with no leave
// type picked yet. These are what the "Only needs review" filter shows.
export const dayNeedsAttn = (d: DayRow) => d.result.needsReview || (d.kind === 'absent' && !d.leaveType)

export interface EmpBlock {
  code: string; name: string; department: string | null; profile: ShiftProfile | null; deliveryName: string | null
  days: DayRow[]; punches: number; totalWorked: number; totalOt: number; totalLate: number; totalEarlyOut: number
  totalRestDays: number; totalHolidayDays: number; totalPresentDays: number; totalOutstation: number
  workDays: number; leaveDays: number; needsReview: number
  // Late/early deduction control (HR Monthly Summary). `excusedLate/Early` are the
  // minutes on per-day-excused days; `noDeductLate` = the whole month is exempted.
  excusedLate: number; excusedEarly: number; noDeductLate: boolean
}

// Late/early minutes actually deducted from Total OT, honouring per-day excuses
// and the per-person monthly override. Total OT = OT − deductedLate − deductedEarly.
export function deductedLate(b: EmpBlock): number { return b.noDeductLate ? 0 : Math.max(0, b.totalLate - b.excusedLate) }
export function deductedEarly(b: EmpBlock): number { return b.noDeductLate ? 0 : Math.max(0, b.totalEarlyOut - b.excusedEarly) }
export function totalOtMinutes(b: EmpBlock): number { return b.totalOt - deductedLate(b) - deductedEarly(b) }

// Add one day to a 'yyyy-MM-dd' date string (UTC-stable).
export function addDay(dk: string): string {
  const [y, m, d] = dk.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

// JS weekday (0=Sun..6=Sat) for a yyyy-MM-dd calendar date (tz-stable via UTC).
export function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The previous complete month (payroll is usually run for the month just ended).
export function prevMonthRange(): { from: string; to: string } {
  const [y, m] = klDateKey(new Date()).split('-').map(Number)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  const mm = String(pm).padStart(2, '0')
  const last = new Date(py, pm, 0).getDate()   // last day of month `pm` (1-based)
  return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${String(last).padStart(2, '0')}` }
}

export interface ReportData { blocks: EmpBlock[]; tripOptions: string[]; punchCount: number }

// Load one month's attendance and fold it into one EmpBlock per employee.
export async function loadReport(from: string, to: string): Promise<ReportData> {
  const fromUtc = `${from}T00:00:00+08:00`
  const toUtc = `${to}T23:59:59+08:00`

  // Punches can be thousands — page past Supabase's 1000-row limit with fetchAll.
  const [punches, { data: emps }, { data: profs }, { data: reviews }] = await Promise.all([
    fetchAll<Punch>('attendance_punches', 'employee_code, punch_time, department_name',
      q => q.gte('punch_time', fromUtc).lte('punch_time', toUtc).order('punch_time')),
    supabase.from('employees').select('employee_code, name, shift_profile_id, delivery_name, crew_role, join_date, resign_date'),
    supabase.from('shift_profiles').select('id, name, normal_hours, lunch_rule, lunch_minutes, shift_start, shift_end, week_schedule, attendance_mode'),
    supabase.from('attendance_reviews').select('employee_code, work_date, lunch_decision, manual_minutes, manual_time')
      .gte('work_date', from).lte('work_date', to),
  ])
  const { data: hols } = await supabase.from('public_holidays').select('holiday_date').gte('holiday_date', from).lte('holiday_date', to)
  const holidaySet = new Set((hols || []).map(h => h.holiday_date))
  // Driver trips from the delivery schedule: (driver name | date) → category.
  const { data: trips } = await supabase.from('delivery_trips').select('driver, kelindan, delivery_date, category').gte('delivery_date', from).lte('delivery_date', to)
  // Trip category per person per date — from BOTH the Driver slot and every name
  // in the Kelindan slot (comma-separated). Keyed by lowercased name so a person
  // is caught whether they drove or rode as a kelindan. Whether that trip costs
  // them their OT is decided later by their crew_role, not by which slot.
  const tripByKey = new Map<string, string>()   // `${nameLower}|${date}` -> category
  for (const t of trips || []) {
    if (!t.category || !t.delivery_date) continue
    if (t.driver) tripByKey.set(`${t.driver.trim().toLowerCase()}|${t.delivery_date}`, t.category)
    for (const k of (t.kelindan || '').split(',')) {
      const kn = k.trim().toLowerCase()
      if (kn) tripByKey.set(`${kn}|${t.delivery_date}`, t.category)
    }
  }
  // Manual per-day trip overrides (employee_code | date) → trip_type.
  const { data: tripOv } = await supabase.from('driver_trip_overrides').select('employee_code, work_date, trip_type').gte('work_date', from).lte('work_date', to)
  const overrideByKey = new Map<string, string>()
  for (const o of tripOv || []) if (o.trip_type) overrideByKey.set(`${o.employee_code}|${o.work_date}`, o.trip_type)
  // Trip-type options for the dropdown = the schedule's categories + overrides.
  const opts = new Set<string>(['LOCAL', 'GCH', 'OS1', 'OS2'])
  for (const t of trips || []) if (t.category) opts.add(t.category)
  for (const o of tripOv || []) if (o.trip_type) opts.add(o.trip_type)
  const tripOptions = [...opts].sort()
  // Leave types set on absent days: (employee_code | date) → leave_type.
  const { data: leaves } = await supabase.from('leave_days').select('employee_code, work_date, leave_type').gte('work_date', from).lte('work_date', to)
  const leaveByKey = new Map<string, string>()
  for (const l of leaves || []) if (l.leave_type) leaveByKey.set(`${l.employee_code}|${l.work_date}`, l.leave_type)
  // Per-day late/early excuses (a row = that day's late/early is not deducted).
  const { data: excuses } = await supabase.from('late_excuses').select('employee_code, work_date').gte('work_date', from).lte('work_date', to)
  const excusedSet = new Set<string>((excuses || []).map(e => `${e.employee_code}|${e.work_date}`))
  // Per-person monthly override (no_deduct = never deduct that person's late/early).
  const month = from.slice(0, 7)
  const { data: overrides } = await supabase.from('late_deduction_overrides').select('employee_code, no_deduct').eq('month', month)
  const noDeductSet = new Set<string>((overrides || []).filter(o => o.no_deduct).map(o => o.employee_code))
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
    const deliveryKey = deliveryName ? deliveryName.trim().toLowerCase() : null
    const crewRole = emp?.crew_role ?? null
    const joinDate = emp?.join_date ?? null       // 'yyyy-MM-dd' or null (employed from the start)
    const resignDate = emp?.resign_date ?? null   // 'yyyy-MM-dd' or null (still employed)
    const osDates = outstationByEmp.get(code) ?? new Map<string, string>()
    const dayRows: DayRow[] = []
    let punchCount = 0, totalWorked = 0, totalOt = 0, totalLate = 0, totalEarlyOut = 0, totalRestDays = 0, totalHolidayDays = 0, totalPresentDays = 0, totalOutstation = 0, needsReview = 0
    let workDays = 0, leaveDays = 0, excusedLate = 0, excusedEarly = 0
    const ws = prof?.week_schedule ?? null
    // Walk every calendar day in the range, so absent (leave) days show as rows too.
    for (const dateKey of rangeDates) {
      const times = days.get(dateKey) ?? []
      // Outside the employment period → "Not employed": shown but never counted as
      // absent/leave/work (before a new joiner started, or after a leaver resigned).
      if ((joinDate && dateKey < joinDate) || (resignDate && dateKey > resignDate)) {
        dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'notEmployed', leaveType: null, lateExcused: false, otInTrip: false })
        continue
      }
      const isHol = holidaySet.has(dateKey)
      const win = ws ? ws[String(weekdayOf(dateKey))] : null
      // true = scheduled work day, false = rest/off, null = unknown (no profile).
      const scheduledWorking = ws ? !!(win && win.start && win.end) : null
      const autoTrip = deliveryKey ? (tripByKey.get(`${deliveryKey}|${dateKey}`) ?? null) : null
      const trip = overrideByKey.get(`${code}|${dateKey}`) ?? autoTrip
      const leaveType = leaveByKey.get(`${code}|${dateKey}`) ?? null

      // Outstation day → present, no OT, no review (punches still shown).
      if (osDates.has(dateKey)) {
        punchCount += times.length
        totalOutstation++
        if (scheduledWorking && !isHol) workDays++
        dayRows.push({ dateKey, result: outstationResult(times), trip, manualTime: null, outstationId: osDates.get(dateKey)!, kind: 'outstation', leaveType: null, lateExcused: false, otInTrip: false })
        continue
      }
      // Resolve any human review + hand-entered times. Each HH:mm in manual_time
      // is ADDED to the day's real punches, then re-paired — so one time fills a
      // missing punch, and a pair (e.g. 08:30 19:00) turns an absent day into a
      // worked day with OT. Existing punches are kept, not replaced.
      const review = reviewByKey.get(`${code}|${dateKey}`) ?? null
      const manualTime = review?.lunch_decision === 'manual_time' ? (review.manual_time ?? null) : null
      const extra = manualTime
        ? (manualTime.match(/\d{1,2}:\d{2}/g) || []).map(t => new Date(`${dateKey}T${t.padStart(5, '0')}:00+08:00`))
        : []
      const dayTimes = extra.length ? [...times, ...extra] : times

      // A day with punches (real or hand-entered) → the normal computed row.
      if (dayTimes.length > 0) {
        punchCount += times.length
        const result = computeDay(dayTimes, prof, review, { weekday: weekdayOf(dateKey), isHoliday: isHol })
        if (result.needsReview) needsReview++
        // A person whose delivery role is DRIVER earns an OS1/OS2 trip day under
        // the trip, not as OT here — even on a day he rode as a kelindan. A
        // kelindan (or anyone without the driver role) still earns OT normally.
        const otInTrip = crewRole === 'driver' && result.otMinutes > 0 && !!trip && OT_IN_TRIP_CATEGORIES.has(trip)
        totalWorked += result.workedMinutes
        totalOt += otInTrip ? 0 : result.otMinutes
        totalLate += result.lateMinutes
        totalEarlyOut += result.earlyOutMinutes
        const lateExcused = excusedSet.has(`${code}|${dateKey}`)
        if (lateExcused) { excusedLate += result.lateMinutes; excusedEarly += result.earlyOutMinutes }
        if (result.dayType === 'rest') totalRestDays += result.dayUnits
        if (result.dayType === 'holiday') totalHolidayDays += result.dayUnits
        if (result.presentDay) totalPresentDays++
        if (scheduledWorking && !isHol) {
          if (result.halfDay) { workDays += 0.5; leaveDays += 0.5 }
          else workDays++
        }
        // A half-worked day can carry a leave type for the missing half (e.g. MC
        // in the afternoon); the day counts 0.5 work + 0.5 leave either way.
        dayRows.push({ dateKey, result, trip, manualTime, outstationId: null, kind: 'worked', leaveType: result.halfDay ? leaveType : null, lateExcused, otInTrip })
        continue
      }
      // No punches. Public holiday → shown, counted, not leave.
      if (isHol) {
        totalHolidayDays += 1
        dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'holiday', leaveType: null, lateExcused: false, otInTrip: false })
        continue
      }
      // No profile → we can't tell work day from rest day, so skip empty days.
      if (scheduledWorking === null) continue
      // Rest / off day.
      if (!scheduledWorking) {
        totalRestDays += 1
        dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'off', leaveType: null, lateExcused: false, otInTrip: false })
        continue
      }
      // Scheduled work day with no attendance → absent / leave (half-day = 0.5).
      const w = leaveWeight(leaveType)
      leaveDays += w
      workDays += 1 - w
      dayRows.push({ dateKey, result: emptyDay(), trip: null, manualTime: null, outstationId: null, kind: 'absent', leaveType, lateExcused: false, otInTrip: false })
    }
    out.push({
      code, name: emp?.name || code, department: deptByCode.get(code) ?? null,
      profile: prof, deliveryName, days: dayRows, punches: punchCount, totalWorked, totalOt, totalLate, totalEarlyOut, totalRestDays, totalHolidayDays, totalPresentDays, totalOutstation, workDays, leaveDays, needsReview,
      excusedLate, excusedEarly, noDeductLate: noDeductSet.has(code),
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))

  return { blocks: out, tripOptions, punchCount: (punches || []).length }
}

// Per-leave-type day counts for one employee's month, in day-fractions so they
// sum to leaveDays (e.g. { AL: 2, MC: 0.5, Half: 0.5 }). A worked half-day adds
// 0.5 under its chosen leave type, or 'Half' if none was picked.
export function leaveBreakdown(b: EmpBlock): Record<string, number> {
  const lc: Record<string, number> = {}
  const add = (k: string, n: number) => { lc[k] = (lc[k] || 0) + n }
  for (const d of b.days) {
    if (d.kind === 'absent' && d.leaveType) add(d.leaveType, leaveWeight(d.leaveType))
    else if (d.kind === 'worked' && d.result.halfDay) add(d.leaveType || 'Half', 0.5)
  }
  return lc
}

// Per-trip-type counts for one driver's month (e.g. { OS1: 1, LOCAL: 1 }).
export function tripBreakdown(b: EmpBlock): Record<string, number> {
  const tc: Record<string, number> = {}
  for (const d of b.days) if (d.trip) tc[d.trip] = (tc[d.trip] || 0) + 1
  return tc
}
