// Attendance pairing — turns a day's raw ZKLink punches into IN/OUT sessions.
// ----------------------------------------------------------------------------
// Punches carry NO in/out tag, so we: sort the day ascending, collapse
// double-taps (two punches within 60s — someone tapping twice), then alternate
// 1st = IN, 2nd = OUT, 3rd = IN, ... An ODD count after collapsing means a
// clock-out is missing → the day needs human review (never invent a time).
//
// This module only PAIRS and sums worked minutes. Lunch auto-deduct and OT
// thresholds are deliberately NOT applied here — that's the step-5 OT engine,
// which must not silently deduct (it flags needs_review instead).

export const KL_TZ = 'Asia/Kuala_Lumpur'

const DOUBLE_TAP_MS = 60_000

export type Session = { in: Date; out: Date | null }

export type DayPairing = {
  sessions: Session[]
  collapsed: number          // how many double-taps were merged away
  punchCount: number         // punches remaining after collapsing
  workedMinutes: number      // sum of COMPLETED sessions only
  needsReview: boolean
  reviewReason: string | null
}

// Pair one employee's punches for one day.
export function pairDay(times: Date[]): DayPairing {
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime())

  // Collapse double-taps: drop any punch within 60s of the previous kept one.
  const kept: Date[] = []
  let collapsed = 0
  for (const t of sorted) {
    const last = kept[kept.length - 1]
    if (last && t.getTime() - last.getTime() < DOUBLE_TAP_MS) { collapsed++; continue }
    kept.push(t)
  }

  // Alternate IN/OUT.
  const sessions: Session[] = []
  for (let i = 0; i < kept.length; i += 2) {
    sessions.push({ in: kept[i], out: kept[i + 1] ?? null })
  }

  const odd = kept.length % 2 === 1
  let workedMinutes = 0
  for (const s of sessions) {
    if (s.out) workedMinutes += Math.round((s.out.getTime() - s.in.getTime()) / 60000)
  }

  return {
    sessions,
    collapsed,
    punchCount: kept.length,
    workedMinutes,
    needsReview: odd,
    reviewReason: odd ? 'Odd number of punches — a clock-out is missing' : null,
  }
}

// yyyy-MM-dd for a given instant, in Kuala Lumpur (the day a punch belongs to).
export function klDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// HH:mm (24h) for an instant, in Kuala Lumpur.
export function klTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: KL_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)
}

// "7h 30m" from minutes.
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ---------------------------------------------------------------------------
// OT engine — turns a paired day + the employee's shift profile + any human
// review into worked / regular / OT minutes. Core rule from the brief: NEVER
// silently auto-deduct lunch. An auto_deduct person with one long session and no
// lunch punch is flagged needs_review until a human decides.
// ---------------------------------------------------------------------------

export interface ShiftProfileLite {
  normal_hours: number
  lunch_rule: string
  lunch_minutes: number
  shift_start?: string | null   // 'HH:MM' time-in
  shift_end?: string | null     // 'HH:MM' time-out
  ot_before?: string | null     // 'HH:MM' (legacy, unused)
  ot_after?: string | null      // 'HH:MM' (legacy, unused)
  // Per-weekday window. Keys '0'(Sun)..'6'(Sat) → {start,end} for a working day,
  // or null/absent = day off (rest day). When set, this governs each day's hours;
  // when absent, shift_start/shift_end apply to every day.
  week_schedule?: Record<string, { start: string; end: string } | null> | null
  // 'pair' (default) = normal in/out pairing + OT. 'single' = salesman mode:
  // any punch on a day counts as PRESENT for that day (no pairing, OT, or review).
  attendance_mode?: string | null
}
export interface ReviewLite { lunch_decision: string | null; manual_minutes: number | null }
export interface DayContext { weekday?: number; isHoliday?: boolean }   // weekday: 0=Sun..6=Sat

export interface DayResult {
  pairing: DayPairing
  dayType: 'normal' | 'rest' | 'holiday'
  dayUnits: number              // rest/holiday work counted in days (0, 0.5, 1)
  presentDay: boolean           // salesman single-punch mode: present that day
  workedMinutes: number         // regular + OT (normal day); raw worked (rest/holiday)
  regularMinutes: number
  otMinutes: number
  lateMinutes: number           // clocked in after shift start
  earlyOutMinutes: number       // clocked out before shift end
  needsReview: boolean
  reviewReason: string | null
  reviewed: boolean             // a human review was applied
}

const DEFAULT_NORMAL_HOURS = 7.5
const GRACE_MIN = 30          // clocking in/out within 30 min of the shift = no OT
const round15 = (x: number) => Math.round(x / 15) * 15
// OT for an early-in / late-out stretch: nothing if within the 30-min grace;
// beyond it, the WHOLE stretch rounded to the nearest 15 min.
// e.g. 29m → 0 · 42m → 45m · 55m → 1h · 60m → 1h · 75m → 1h15m.
const otPortion = (min: number) => (min > GRACE_MIN ? round15(min) : 0)

function parseHHMM(s?: string | null): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
// Minutes-since-midnight of an instant, read in Kuala Lumpur wall-clock time.
function klMinutesOfDay(d: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: KL_TZ, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).formatToParts(d)
  const h = Number(p.find(x => x.type === 'hour')?.value || 0)
  const m = Number(p.find(x => x.type === 'minute')?.value || 0)
  return h * 60 + m
}
const overlap = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(b, d) - Math.max(a, c))

function result(regular: number, ot: number, late: number, earlyOut: number, pairing: DayPairing, reviewed: boolean): DayResult {
  const r = Math.max(0, Math.round(regular)), o = Math.max(0, Math.round(ot))
  return { pairing, dayType: 'normal', dayUnits: 0, presentDay: false, workedMinutes: r + o, regularMinutes: r, otMinutes: o, lateMinutes: Math.max(0, Math.round(late)), earlyOutMinutes: Math.max(0, Math.round(earlyOut)), needsReview: false, reviewReason: null, reviewed }
}
function flag(pairing: DayPairing, reason: string): DayResult {
  return { pairing, dayType: 'normal', dayUnits: 0, presentDay: false, workedMinutes: 0, regularMinutes: 0, otMinutes: 0, lateMinutes: 0, earlyOutMinutes: 0, needsReview: true, reviewReason: reason, reviewed: false }
}
// Rest-day / public-holiday work, counted in days: full shift → 1, >half → 1,
// half or less → ½. (SQL Payroll applies the day-rate from the bucket.)
function dayCount(dayType: 'rest' | 'holiday', worked: number, fullNormalMin: number, pairing: DayPairing): DayResult {
  const units = worked <= 0 ? 0 : (worked > fullNormalMin / 2 ? 1 : 0.5)
  return { pairing, dayType, dayUnits: units, presentDay: false, workedMinutes: Math.round(worked), regularMinutes: 0, otMinutes: 0, lateMinutes: 0, earlyOutMinutes: 0, needsReview: false, reviewReason: null, reviewed: false }
}
// Salesman single-punch mode: any punch that day = present (no hours/OT/review).
function presentResult(pairing: DayPairing): DayResult {
  return { pairing, dayType: 'normal', dayUnits: 0, presentDay: true, workedMinutes: 0, regularMinutes: 0, otMinutes: 0, lateMinutes: 0, earlyOutMinutes: 0, needsReview: false, reviewReason: null, reviewed: false }
}

export function computeDay(times: Date[], profile: ShiftProfileLite | null, review: ReviewLite | null, ctx?: DayContext): DayResult {
  const pairing = pairDay(times)
  const normalMin = Math.round((profile?.normal_hours ?? DEFAULT_NORMAL_HOURS) * 60)
  const lunchRule = profile?.lunch_rule ?? 'punch'
  const lunchMin = profile?.lunch_minutes ?? 60

  // Resolve this day's type + working window from the weekly schedule.
  let dayType: 'normal' | 'rest' | 'holiday' = 'normal'
  let shiftStart = parseHHMM(profile?.shift_start)
  let shiftEnd = parseHHMM(profile?.shift_end)
  const sched = profile?.week_schedule
  if (ctx?.isHoliday) {
    dayType = 'holiday'
  } else if (sched && ctx?.weekday != null) {
    const e = sched[String(ctx.weekday)]
    if (e && e.start && e.end) { shiftStart = parseHHMM(e.start); shiftEnd = parseHHMM(e.end) }
    else dayType = 'rest'    // scheduled off
  }
  const windowMode = shiftStart != null && shiftEnd != null

  // Full manual override resolves any day (even a broken-punch one).
  if (review && review.lunch_decision === 'manual') return result(review.manual_minutes ?? 0, 0, 0, 0, pairing, true)

  if (pairing.sessions.length === 0) return result(0, 0, 0, 0, pairing, false)

  // Salesman: any punch that day = present. No pairing / OT / review.
  if (profile?.attendance_mode === 'single') return presentResult(pairing)

  // Missing clock-out — never invent a time (applies to every day type).
  if (pairing.needsReview) return flag(pairing, pairing.reviewReason || 'Missing a clock-out')

  // Rest day / public holiday with work → counted in days, not hours.
  if (dayType !== 'normal') return dayCount(dayType, pairing.workedMinutes, normalMin, pairing)

  // auto_deduct, single long session, no lunch punch → don't guess until reviewed.
  const singleNoLunch = lunchRule === 'auto_deduct' && pairing.sessions.length <= 1 && pairing.punchCount >= 2
  const decided = review && (review.lunch_decision === 'deduct' || review.lunch_decision === 'worked_through')
  if (singleNoLunch && !decided) return flag(pairing, 'Auto-deduct: no lunch punch — confirm lunch')
  const deductLunch = singleNoLunch && review?.lunch_decision === 'deduct'

  // Flat fallback when no shift window is set: OT over the daily threshold.
  if (!windowMode) {
    let worked = pairing.workedMinutes
    if (deductLunch) worked = Math.max(0, worked - lunchMin)
    return result(Math.min(worked, normalMin), round15(Math.max(0, worked - normalMin)), 0, 0, pairing, !!review)
  }

  // Window mode:
  //  Normal = work inside [shift_start, shift_end] minus lunch.
  //  OT     = full completed hours before shift_start (from first punch) +
  //           full completed hours after shift_end (to last punch).
  let normalRaw = 0
  for (const s of pairing.sessions) {
    if (!s.out) continue
    const a = klMinutesOfDay(s.in), b = klMinutesOfDay(s.out)
    if (b > a) normalRaw += overlap(a, b, shiftStart!, shiftEnd!)
  }
  const normal = deductLunch ? Math.max(0, normalRaw - lunchMin) : normalRaw

  const firstIn = klMinutesOfDay(pairing.sessions[0].in)
  const lastOutDate = [...pairing.sessions].reverse().find(s => s.out)?.out
  const lastOut = lastOutDate ? klMinutesOfDay(lastOutDate) : null
  const earlyOT = otPortion(Math.max(0, shiftStart! - firstIn))
  const afterOT = lastOut != null ? otPortion(Math.max(0, lastOut - shiftEnd!)) : 0
  const ot = earlyOT + afterOT

  const lateMinutes = Math.max(0, firstIn - shiftStart!)
  const earlyOutMinutes = lastOut != null ? Math.max(0, shiftEnd! - lastOut) : 0

  return result(normal, ot, lateMinutes, earlyOutMinutes, pairing, !!review)
}
