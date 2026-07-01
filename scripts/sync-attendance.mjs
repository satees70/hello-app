#!/usr/bin/env node
// Standalone ZKLink → Supabase attendance sync (ZERO dependencies).
// ----------------------------------------------------------------------------
// Runs on a FIXED-IP host (the office PC whose public IP is whitelisted in
// ZKLink). Same pull as the app's /api/attendance/sync, but standalone so it can
// run from the whitelisted office IP (Vercel's IPs rotate and are blocked).
// Uses only built-in Node (global fetch) + Supabase's REST API — no npm install.
//
// One-time setup on the office Windows PC:
//   1. Install Node.js (LTS) from https://nodejs.org
//   2. Make a folder, e.g.  C:\easwari-sync\
//   3. Put THIS file and a `.env` file (below) in that folder
//   4. Test in Command Prompt:  node C:\easwari-sync\sync-attendance.mjs
//   5. Schedule it every 15 min with Task Scheduler (see the guide).
//
// The `.env` file (same folder) — 4 lines:
//   NEXT_PUBLIC_SUPABASE_URL=...
//   SUPABASE_SERVICE_ROLE_KEY=...
//   ZKLINK_APP_KEY=...
//   ZKLINK_APP_SECRET=...
//   # optional first-run backfill start:
//   ZKLINK_BACKFILL_START=2026-06-01

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Load the .env sitting next to this script (simple KEY=VALUE parser).
const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0 && !line.trim().startsWith('#')) {
      const k = line.slice(0, i).trim()
      if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim()
    }
  }
}

const ZK = 'https://zlink-open.minervaiot.com'
const TZ = 'Asia/Kuala_Lumpur'
const BACKFILL_START = process.env.ZKLINK_BACKFILL_START || '2026-06-01'
const SB = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '')
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SB || !KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const sbHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const klToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

// --- ZKLink ---
async function getToken() {
  const res = await fetch(`${ZK}/open-apis/authen/v1/tenantToken/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: process.env.ZKLINK_APP_KEY, appSecret: process.env.ZKLINK_APP_SECRET }),
  })
  const j = await res.json()
  if (j.code !== 'ZCOP0000' || !j.data?.tenantToken) throw new Error(`token: ${j.code} ${j.message || ''}`)
  return j.data.tenantToken
}

async function fetchPunches(token, startDate, endDate) {
  const all = []
  let page = 1
  for (;;) {
    const res = await fetch(`${ZK}/open-apis/att/v1/events/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pageNumber: page, pageSize: 100, startDateTime: `${startDate} 00:00:00`, endDateTime: `${endDate} 23:59:59`, deviceName: '', operator: '' }),
    })
    const text = await res.text()
    let j
    try { j = JSON.parse(text) } catch { throw new Error(`events not JSON (HTTP ${res.status}) — likely IP not whitelisted: ${text.slice(0, 120)}`) }
    if (j.code !== 'ZCOP0000') throw new Error(`events: ${j.code} ${j.message || ''}`)
    const events = j.data?.events ?? []
    for (const ev of events) {
      const vals = {}
      for (const v of (ev.eventValues ?? [])) vals[v.name] = v.value
      if (vals.operator && ev.eventTime) all.push({ employee_code: vals.operator, punch_time: ev.eventTime, device_name: ev.deviceName, raw: ev })
    }
    const totalPages = Number(j.data?.totalPages) || 1
    if (page >= totalPages || events.length === 0) break
    page++
  }
  return all
}

// --- Supabase REST ---
async function getLastSyncedDate() {
  const res = await fetch(`${SB}/rest/v1/sync_state?key=eq.zklink&select=last_synced_date`, { headers: sbHeaders })
  const arr = await res.json()
  return Array.isArray(arr) && arr[0] ? arr[0].last_synced_date : null
}

async function insertPunches(rows) {
  let inserted = 0
  for (let i = 0; i < rows.length; i += 500) {           // chunk to keep requests small
    const chunk = rows.slice(i, i + 500)
    const res = await fetch(`${SB}/rest/v1/attendance_punches?on_conflict=source_id`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(chunk),
    })
    if (!res.ok) throw new Error(`insert punches: ${res.status} ${(await res.text()).slice(0, 160)}`)
    const back = await res.json()
    inserted += Array.isArray(back) ? back.length : 0
  }
  return inserted
}

async function saveSyncState(today) {
  const nowIso = new Date().toISOString()
  const res = await fetch(`${SB}/rest/v1/sync_state?on_conflict=key`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: 'zklink', last_synced_at: nowIso, last_synced_date: today, updated_at: nowIso }),
  })
  if (!res.ok) throw new Error(`save sync_state: ${res.status} ${(await res.text()).slice(0, 160)}`)
}

async function main() {
  const today = klToday()
  const startDate = (await getLastSyncedDate()) || BACKFILL_START

  const token = await getToken()
  const punches = await fetchPunches(token, startDate, today)

  const seen = new Set()
  const rows = []
  for (const p of punches) {
    const source_id = `${p.employee_code}|${p.punch_time}`
    if (seen.has(source_id)) continue
    seen.add(source_id)
    rows.push({
      employee_code: p.employee_code,
      punch_time: `${p.punch_time.replace(' ', 'T')}+08:00`,
      source_id, first_name: null, department_name: p.device_name ?? null, raw: p.raw,
    })
  }

  const inserted = await insertPunches(rows)
  await saveSyncState(today)
  console.log(`[${new Date().toISOString()}] sync ${startDate} → ${today}: pulled ${punches.length}, inserted ${inserted}`)
}

main().then(() => process.exit(0)).catch(e => { console.error('sync failed:', e.message); process.exit(1) })
