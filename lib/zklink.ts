// ZKLink (Minerva IoT) attendance API client.
// ----------------------------------------------------------------------------
// Tenant token is cached in-process (~1h, per the API's expiresIn). Punches have
// NO in/out tag and NO unique id — callers dedupe on `${employee_code}|${punch_time}`
// and pair them by time order. Success code from the API is 'ZCOP0000'.
// Credentials come from ZKLINK_APP_KEY / ZKLINK_APP_SECRET in .env.local.

const BASE = 'https://zlink-open.minervaiot.com'

let cachedToken: { token: string; expiresAt: number } | null = null

// Fetch (and cache) the tenant token. Re-used until ~1 min before it expires.
export async function getTenantToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token

  const appKey = process.env.ZKLINK_APP_KEY
  const appSecret = process.env.ZKLINK_APP_SECRET
  if (!appKey || !appSecret) {
    throw new Error('ZKLINK_APP_KEY / ZKLINK_APP_SECRET are not set in .env.local')
  }

  const res = await fetch(`${BASE}/open-apis/authen/v1/tenantToken/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  })
  const json = await res.json()
  if (json.code !== 'ZCOP0000' || !json.data?.tenantToken) {
    throw new Error(`ZKLink token error: ${json.code || res.status} ${json.msg || ''}`.trim())
  }

  const token = json.data.tenantToken as string
  const expiresIn = Number(json.data.expiresIn) || 3600
  cachedToken = { token, expiresAt: now + expiresIn * 1000 }
  return token
}

export type ZkPunch = {
  punch_time: string          // "yyyy-MM-dd HH:mm:ss" (device local time = KL)
  employee_code: string       // = the event's `operator`
  att_state?: string          // 0 in · 1 out · 2 in · 3 out · 4 OT-in · 5 OT-out · 255 default
  device_name?: string
  raw?: unknown
}

// One event's eventValues[] is a list of { name, value } pairs — flatten to a map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eventValueMap(ev: any): Map<string, string> {
  const m = new Map<string, string>()
  for (const v of (ev?.eventValues ?? [])) if (v?.name != null) m.set(v.name, v.value)
  return m
}

// Pull every punch between startDate and endDate (inclusive), both yyyy-MM-dd.
// Endpoint: att/v1/events/search. Filters by datetime; pages at most 100; we walk
// all totalPages. Each event carries operator (employee code), eventTime (punch
// time) and attState (in/out), so the OT engine can use real tags when present.
export async function fetchPunches(startDate: string, endDate: string): Promise<ZkPunch[]> {
  const token = await getTenantToken()
  const pageSize = 100
  const all: ZkPunch[] = []
  let pageNumber = 1
  const startDateTime = `${startDate} 00:00:00`
  const endDateTime = `${endDate} 23:59:59`

  for (;;) {
    const res = await fetch(`${BASE}/open-apis/att/v1/events/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pageNumber, pageSize, startDateTime, endDateTime, deviceName: '', operator: '' }),
    })
    const json = await res.json()
    if (json.code !== 'ZCOP0000') {
      throw new Error(`ZKLink events error: ${json.code || res.status} ${json.message || ''}`.trim())
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = (json.data?.events ?? []) as any[]
    for (const ev of events) {
      const vals = eventValueMap(ev)
      const employee_code = vals.get('operator') || ''
      if (!employee_code || !ev.eventTime) continue
      all.push({
        punch_time: ev.eventTime,
        employee_code,
        att_state: vals.get('attState'),
        device_name: ev.deviceName,
        raw: ev,
      })
    }

    const totalPages = Number(json.data?.totalPages) || 1
    if (pageNumber >= totalPages || events.length === 0) break
    pageNumber++
  }

  return all
}

export type ZkEmployee = { employee_code: string; name: string; department_name?: string }

// Pull the employee master from ZKLink (org/v1/employees/search). Requires the
// app to have the Employee/Organization read permission granted in the console.
// Field names are matched defensively since the response shape may vary.
// departmentId → department name (needs the Department-Read permission).
async function fetchDepartments(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const res = await fetch(`${BASE}/open-apis/org/v1/departments/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ pageNumber: 1, pageSize: 100 }),
  })
  const json = await res.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of (json.data?.depts ?? []) as any[]) if (d.id) map.set(d.id, d.name)
  return map
}

export async function fetchEmployees(): Promise<ZkEmployee[]> {
  const token = await getTenantToken()
  const deptById = await fetchDepartments(token).catch(() => new Map<string, string>())
  const pageSize = 100
  const all: ZkEmployee[] = []
  let pageNumber = 1

  for (;;) {
    const res = await fetch(`${BASE}/open-apis/org/v1/employees/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pageNumber, pageSize }),
    })
    const json = await res.json()
    if (json.code !== 'ZCOP0000') {
      throw new Error(`ZKLink employees error: ${json.code || res.status} ${json.message || ''}`.trim())
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (json.data?.employee ?? json.data?.employees ?? json.data?.list ?? json.data?.persons ?? []) as any[]
    for (const e of list) {
      const code = e.employeeCode || e.code || e.pin || e.empCode || ''
      const name = e.name || [e.firstName, e.lastName].filter(Boolean).join(' ') || e.fullName || ''
      const department_name = e.departmentName || e.deptName || (e.departmentId ? deptById.get(e.departmentId) : undefined)
      if (code) all.push({ employee_code: String(code), name: String(name || code), department_name })
    }

    const totalPages = Number(json.data?.totalPages) || 1
    if (pageNumber >= totalPages || list.length === 0) break
    pageNumber++
  }

  return all
}
