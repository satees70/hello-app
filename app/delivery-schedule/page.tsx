'use client'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'
import { tomorrowISO } from '@/lib/delivery'
import * as XLSX from 'xlsx'

interface Sched {
  id: string; so_number: string; customer_name: string | null; route: string | null
  delivery_date: string | null; created_by_name: string | null; data: Record<string, string> | null; invoiced: boolean
}
interface Trip { route: string; delivery_date: string; lorry_no: string | null; driver: string | null; kelindan: string | null; remark: string | null; category: string | null }

// Fixed delivery lines A … K.
const LINES = Array.from({ length: 11 }, (_, i) => 'LINE ' + String.fromCharCode(65 + i))
const TRIP_TYPES = ['LOCAL', 'GCH', 'OS1', 'OS2']

function normSO(v: unknown): string {
  const raw = String(v ?? '').trim()
  const m = raw.match(/SO[-\s]?(\d+)/i)
  return m ? 'SO-' + m[1] : raw
}
function normDate(v: unknown): string {
  if (!v) return ''
  const raw = v instanceof Date ? v : new Date(String(v))
  if (isNaN(raw.getTime())) return ''
  // SheetJS lands Excel dates a hair before/after midnight (timezone + float), so the day can read
  // one off. Snap to the nearest whole day before formatting.
  const d = new Date(raw.getTime() + 12 * 3600 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// How a data cell is shown: links become clickable, ISO dates become dd/mm/yyyy.
function cellView(v: string): React.ReactNode {
  const t = String(v ?? '').trim()   // values from the upload sometimes carry leading/trailing spaces
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return <a href={t} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Open ↗</a>
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  return t
}

// Where a production batch is in its lifecycle — same logic the Sales Orders / Order Board use.
type BatchLite = { item_code: string; factory_code: string; material_request_id: string | null; pack_date: string | null; produced_qty: number | null; total_quantity: number; dispatched_at: string | null }
function lineStatusOf(b: BatchLite, mrStatus: Record<string, string>): string {
  if (b.dispatched_at) return 'Delivered to warehouse'
  const prod = Number(b.produced_qty || 0), tot = Number(b.total_quantity || 0)
  if (prod > 0 && prod >= tot) return 'Production completed'
  if (prod > 0) return 'Production started'
  if (!b.material_request_id) return 'Pending Material Request'
  const ms = mrStatus[b.material_request_id]
  if (ms === 'Fulfilled') return b.pack_date ? 'Pending Schedule' : 'Material Received Fully'
  if (ms === 'Partially Received') return 'Material Received Partial'
  return 'Pending Material Request'
}
// A SO's production counts as done once every one of its batches is produced (or already delivered).
const PROD_DONE = new Set(['Production completed', 'Delivered to warehouse'])
// Colour each stage so the item dropdown is easy to scan.
const STATUS_CHIP: Record<string, string> = {
  'Not started': 'bg-gray-100 text-gray-600',
  'Pending Material Request': 'bg-gray-100 text-gray-600',
  'Material Received Partial': 'bg-amber-100 text-amber-700',
  'Material Received Fully': 'bg-lime-100 text-lime-700',
  'Pending Schedule': 'bg-yellow-100 text-yellow-700',
  'Production started': 'bg-blue-100 text-blue-700',
  'Production completed': 'bg-teal-100 text-teal-700',
  'Delivered to warehouse': 'bg-green-100 text-green-700',
}

export default function DeliverySchedulePage() {
  const { profile, loading, error: profileError } = useProfile()
  // Delivery Schedule is viewable by any logged-in user for now.

  const [sched, setSched] = useState<Sched[]>([])
  const [trips, setTrips] = useState<Record<string, Trip>>({})   // `${route}|${date}` -> trip
  const [soFactory, setSoFactory] = useState<Record<string, string>>({})   // so_number -> factory/location
  const [soProd, setSoProd] = useState<Record<string, { done: boolean; status: string }>>({})   // so_number -> production state
  const [soLoc, setSoLoc] = useState<Record<string, Record<string, { total: number; done: number }>>>({})   // so_number -> location -> counts (a SO can produce at several factories)
  const [soItems, setSoItems] = useState<Record<string, { item: string; factory: string; status: string; done: boolean; qty: number }[]>>({})   // so_number -> per-item production detail
  const [itemName, setItemName] = useState<Record<string, string>>({})   // item code -> description (name)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())   // schedule rows whose item list is open
  const toggleExpand = (id: string) => setExpanded(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [uploads, setUploads] = useState<{ id: string; file_name: string; path: string; created_at: string; created_by_name: string | null }[]>([])
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<unknown[][]>([])
  const [colSO, setColSO] = useState('')
  const [colCust, setColCust] = useState('')
  const [sel, setSel] = useState<Set<number>>(new Set())   // selected source-row indices
  const [assignLine, setAssignLine] = useState(LINES[0])
  const [date, setDate] = useState(tomorrowISO())
  const [routeFilter, setRouteFilter] = useState('all')
  const [dateFilter, setDateFilter] = useState('all')
  const [showScheduled, setShowScheduled] = useState(false)   // upload list: also show orders already scheduled
  const [resources, setResources] = useState<Record<'lorry' | 'driver' | 'kelindan', { id: string; name: string; phone: string | null }[]>>({ lorry: [], driver: [], kelindan: [] })
  const [showManage, setShowManage] = useState(false)
  const [newRes, setNewRes] = useState<Record<'lorry' | 'driver' | 'kelindan', string>>({ lorry: '', driver: '', kelindan: '' })
  const [newPhone, setNewPhone] = useState<Record<'lorry' | 'driver' | 'kelindan', string>>({ lorry: '', driver: '', kelindan: '' })
  const didInitDate = useRef(false)   // default the date filter to the latest day, once
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => { if (profile) { load(); loadUploads(); loadResources() } }, [profile])
  // Master lists of lorries / drivers / kelindan (the future driver app reads from here too).
  async function loadResources() {
    const { data } = await supabase.from('delivery_resources').select('id, kind, name, phone').eq('active', true).order('name')
    const g: Record<'lorry' | 'driver' | 'kelindan', { id: string; name: string; phone: string | null }[]> = { lorry: [], driver: [], kelindan: [] }
    ;(data || []).forEach((r: { id: string; kind: 'lorry' | 'driver' | 'kelindan'; name: string; phone: string | null }) => { if (g[r.kind]) g[r.kind].push({ id: r.id, name: r.name, phone: r.phone }) })
    setResources(g)
  }
  async function addResource(kind: 'lorry' | 'driver' | 'kelindan', name: string, phone?: string) {
    const n = (name || '').trim()
    if (!n || resources[kind].some(r => r.name.toLowerCase() === n.toLowerCase())) return
    const { error: e } = await supabase.from('delivery_resources').insert({ kind, name: n, phone: (phone || '').trim() || null })
    if (!e) { setNewRes(p => ({ ...p, [kind]: '' })); setNewPhone(p => ({ ...p, [kind]: '' })); loadResources() }
  }
  async function removeResource(id: string) {
    await supabase.from('delivery_resources').delete().eq('id', id)
    loadResources()
  }
  async function load() {
    const { data: s } = await supabase.from('delivery_schedule').select('id, so_number, customer_name, route, delivery_date, created_by_name, data, invoiced').order('route', { ascending: true, nullsFirst: false }).order('delivery_date', { ascending: true, nullsFirst: false })
    setSched((s as Sched[]) || [])
    // On first load, default the Date filter to the latest scheduled day.
    if (!didInitDate.current) {
      const dates = [...new Set(((s as Sched[]) || []).map(x => x.delivery_date).filter(Boolean) as string[])].sort()
      if (dates.length) { setDateFilter(dates[dates.length - 1]); didInitDate.current = true }
    }
    const { data: t } = await supabase.from('delivery_trips').select('route, delivery_date, lorry_no, driver, kelindan, remark, category')
    const tm: Record<string, Trip> = {}; (t as Trip[] || []).forEach(x => { tm[`${x.route}|${x.delivery_date}`] = x }); setTrips(tm)
    // Each SO's production location (factory) + its ordered items (the fallback detail for SOs with no batch yet).
    const sos = [...new Set(((s as Sched[]) || []).map(x => x.so_number).filter(Boolean))]
    const sf: Record<string, string> = {}
    const salesItems: Record<string, { item: string; factory: string; status: string; done: boolean; qty: number }[]> = {}
    const nmSales: Record<string, string> = {}
    for (let i = 0; i < sos.length; i += 60) {
      const chunk = sos.slice(i, i + 60)
      // Paginate — PostgREST caps each response at 1000 rows, and these chunks can exceed that.
      for (let from = 0; ; from += 1000) {
        const { data: sl } = await supabase.from('sales_order_lines').select('so_number, factory_code, item_code, description, quantity').in('so_number', chunk).range(from, from + 999)
        const rows = sl || []
        rows.forEach(l => {
          if (l.so_number && l.factory_code && !sf[l.so_number]) sf[l.so_number] = l.factory_code
          if (l.so_number && l.item_code) {
            ;(salesItems[l.so_number] = salesItems[l.so_number] || []).push({ item: l.item_code, factory: l.factory_code || 'No location', status: 'Not started', done: false, qty: Number(l.quantity || 0) })
            if (l.description) nmSales[l.item_code] = l.description
          }
        })
        if (rows.length < 1000) break
      }
    }
    setSoFactory(sf)
    // Production progress per SO — and per location, because one SO can be produced at several factories.
    const statuses: Record<string, string[]> = {}
    const locs: Record<string, Record<string, { total: number; done: number }>> = {}
    const items: Record<string, { item: string; factory: string; status: string; done: boolean; qty: number }[]> = {}
    for (let i = 0; i < sos.length; i += 60) {
      const chunk = sos.slice(i, i + 60)
      const brows: { so_number: string; quantity: number | null; production_batches: BatchLite | null }[] = []
      for (let from = 0; ; from += 1000) {   // paginate past the 1000-row cap
        const { data: bi } = await supabase.from('production_batch_items')
          .select('so_number, quantity, production_batches!batch_id(item_code, factory_code, material_request_id, pack_date, produced_qty, total_quantity, dispatched_at)')
          .in('so_number', chunk).range(from, from + 999)
        const page = (bi || []) as unknown as { so_number: string; quantity: number | null; production_batches: BatchLite | null }[]
        brows.push(...page)
        if (page.length < 1000) break
      }
      const mrIds = [...new Set(brows.map(r => r.production_batches?.material_request_id).filter(Boolean) as string[])]
      const mrStatus: Record<string, string> = {}
      if (mrIds.length) { const { data: mrs } = await supabase.from('material_requests').select('id, status').in('id', mrIds); (mrs || []).forEach(m => { mrStatus[m.id] = m.status }) }
      brows.forEach(r => {
        const b = r.production_batches; if (!r.so_number || !b) return
        const st = lineStatusOf(b, mrStatus)
        const done = PROD_DONE.has(st)
        ;(statuses[r.so_number] = statuses[r.so_number] || []).push(st)
        const f = b.factory_code || 'No location'
        const e = ((locs[r.so_number] = locs[r.so_number] || {})[f] = locs[r.so_number][f] || { total: 0, done: 0 })
        e.total++; if (done) e.done++
        ;(items[r.so_number] = items[r.so_number] || []).push({ item: b.item_code, factory: f, status: st, done, qty: Number(r.quantity || 0) })
      })
    }
    const prod: Record<string, { done: boolean; status: string }> = {}
    Object.entries(statuses).forEach(([so, st]) => {
      const done = st.length > 0 && st.every(x => PROD_DONE.has(x))
      // Show the least-finished line's status as the headline (what's holding the order up).
      const order = ['Pending Material Request', 'Material Received Partial', 'Material Received Fully', 'Pending Schedule', 'Production started', 'Production completed', 'Delivered to warehouse']
      const headline = st.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]
      prod[so] = { done, status: headline }
    })
    // SOs with no production batch yet → fall back to the items on the sales order, so they still count.
    sos.forEach(so => { if (!items[so] && salesItems[so]) items[so] = salesItems[so] })
    setSoProd(prod); setSoLoc(locs); setSoItems(items)
    // Item names for the dropdown (sales-line descriptions first, items table fills any gaps).
    const codes = [...new Set(Object.values(items).flat().map(i => i.item).filter(Boolean))]
    const nm: Record<string, string> = { ...nmSales }
    for (let i = 0; i < codes.length; i += 200) {
      const { data: its } = await supabase.from('items').select('code, description').in('code', codes.slice(i, i + 200))
      ;(its || []).forEach(it => { if (it.code && it.description) nm[it.code] = it.description })
    }
    setItemName(nm)
  }
  // Most recent label set for each line (used when the chosen date has none yet).
  const lineLatest = useMemo(() => {
    const best: Record<string, { date: string; remark: string }> = {}
    Object.values(trips).forEach(t => { if (t.remark) { const cur = best[t.route]; if (!cur || (t.delivery_date || '') > cur.date) best[t.route] = { date: t.delivery_date || '', remark: t.remark } } })
    const m: Record<string, string> = {}; Object.entries(best).forEach(([k, v]) => { m[k] = v.remark }); return m
  }, [trips])
  // The line's label is per-day (line + date), falling back to the line's latest label.
  const lineLabel = (l: string, d?: string | null) => { const r = (d ? trips[`${l}|${d}`]?.remark : '') || lineLatest[l] || ''; return `${l}${r ? ' — ' + r : ''}` }
  // Update one field of a trip (line+date) locally; persist on blur via saveTrip.
  const setTripField = (route: string, date: string, field: keyof Trip, value: string) => setTrips(p => {
    const key = `${route}|${date}`; const cur = p[key] || { route, delivery_date: date, lorry_no: '', driver: '', kelindan: '', remark: '', category: '' }
    return { ...p, [key]: { ...cur, [field]: value } }
  })
  async function saveTrip(route: string, deliveryDate: string, patch: Partial<Trip>) {
    const key = `${route}|${deliveryDate}`
    const cur = trips[key] || { route, delivery_date: deliveryDate, lorry_no: '', driver: '', kelindan: '', remark: '', category: '' }
    const next = { ...cur, ...patch }
    setTrips(p => ({ ...p, [key]: next }))
    const { error: e } = await supabase.from('delivery_trips').upsert({ route, delivery_date: deliveryDate, lorry_no: next.lorry_no || null, driver: next.driver || null, kelindan: next.kelindan || null, remark: next.remark || null, category: next.category || null, updated_at: new Date().toISOString() }, { onConflict: 'route,delivery_date' })
    if (e) setError(`Could not save line info: ${e.message}`)
  }
  // Who already holds a lorry/driver/kelindan on a given day: `${date}|${kind}|${name}` -> route.
  const resourceOwner = useMemo(() => {
    const m = new Map<string, string>()
    Object.values(trips).forEach(t => {
      if (!t.delivery_date || !t.route) return
      const add = (kind: string, val?: string | null) => { const v = (val || '').trim(); if (v) m.set(`${t.delivery_date}|${kind}|${v.toLowerCase()}`, t.route) }
      add('lorry', t.lorry_no); add('driver', t.driver); add('kelindan', t.kelindan)
    })
    return m
  }, [trips])
  const ownerOf = (date: string | null, kind: string, name: string) => date ? resourceOwner.get(`${date}|${kind}|${name.trim().toLowerCase()}`) : undefined
  // Save a lorry/driver/kelindan to a trip — but block it if another line already uses it that day.
  function commitResource(route: string, date: string, kind: 'lorry' | 'driver' | 'kelindan', field: keyof Trip, value: string) {
    const v = (value || '').trim()
    const owner = v ? ownerOf(date, kind, v) : undefined
    if (owner && owner !== route) {
      const d = (date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); const ds = d ? `${d[3]}/${d[2]}/${d[1]}` : date
      setError(`"${v}" is already assigned to ${owner} on ${ds}. Each ${kind} can only be on one line per day.`)
      return
    }
    setError('')
    setTripField(route, date, field, v)
    saveTrip(route, date, { [field]: v })
  }
  async function loadUploads() {
    const { data } = await supabase.from('delivery_uploads').select('id, file_name, path, created_at, created_by_name').order('created_at', { ascending: false }).limit(30)
    setUploads(data || [])
  }
  // Re-open a saved file back into the assign preview (to amend / continue scheduling).
  async function openUpload(u: { file_name: string; path: string }) {
    setError(''); setSuccess('')
    const { data, error: e } = await supabase.storage.from('delivery-files').download(u.path)
    if (e || !data) { setError('Could not open the saved file.'); return }
    try { const buf = await data.arrayBuffer(); if (loadWorkbook(buf, u.file_name)) setSuccess(`Re-opened "${u.file_name}" — tick the orders and assign them to a line.`) }
    catch { setError('Could not read the saved file.') }
  }
  async function deleteUpload(u: { id: string; path: string }) {
    if (!confirm('Delete this saved file?')) return
    await supabase.storage.from('delivery-files').remove([u.path])
    await supabase.from('delivery_uploads').delete().eq('id', u.id)
    loadUploads()
  }

  // Parse an Excel/CSV buffer into the assign preview (used by upload AND re-open).
  function loadWorkbook(buf: ArrayBuffer, name: string): boolean {
    const wb = XLSX.read(buf, { type: 'array', cellDates: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][]
    if (aoa.length === 0) { setError('That file looks empty.'); return false }
    const hdr = (aoa[0] as unknown[]).map(x => String(x ?? '').trim())
    setFileName(name); setHeaders(hdr); setRows(aoa.slice(1)); setSel(new Set())
    const find = (...keys: string[]) => String(hdr.findIndex(h => keys.some(k => h.toLowerCase().includes(k))))
    const so = find('so no', 'so number', 'sonumber', 'so'); setColSO(so === '-1' ? '0' : so)
    const cust = find('customer', 'company', 'name'); setColCust(cust === '-1' ? '' : cust)
    return true
  }

  async function onFile(f: File | undefined) {
    if (!f) return
    setError(''); setSuccess('')
    try {
      const buf = await f.arrayBuffer()
      if (!loadWorkbook(buf, f.name)) return
      // Keep the file so the schedule can be amended later.
      try {
        const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${Date.now()}-${safe}`
        const up = await supabase.storage.from('delivery-files').upload(path, f)
        if (!up.error) { await supabase.from('delivery_uploads').insert({ file_name: f.name, path, created_by: profile?.id, created_by_name: profile?.full_name }); loadUploads() }
      } catch { /* keeping the file is best-effort; parsing still works without it */ }
    } catch { setError('Could not read that file. Make sure it is an Excel or CSV export.') }
  }

  // SOs already scheduled, and which dates. We hide scheduled orders EXCEPT ones whose only
  // schedule was the day BEFORE the date you're planning (those show in green so you can carry
  // them over). e.g. planning 30/06 → orders sitting on 29/06 reappear so you can re-assign them.
  const carryDate = useMemo(() => { const d = new Date((date || tomorrowISO()) + 'T00:00:00'); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }, [date])
  const scheduledSOs = useMemo(() => new Set(sched.map(s => s.so_number)), [sched])
  const schedDatesBySO = useMemo(() => { const m = new Map<string, Set<string>>(); sched.forEach(s => { if (!s.so_number) return; const set = m.get(s.so_number) || new Set<string>(); if (s.delivery_date) set.add(s.delivery_date); m.set(s.so_number, set) }); return m }, [sched])
  const onlyScheduledYesterday = (so: string) => { if (!scheduledSOs.has(so)) return false; const dates = schedDatesBySO.get(so) || new Set(); return dates.size > 0 && [...dates].every(d => d === carryDate) }
  // Rows to show: pending (not scheduled) + ones scheduled only yesterday (green).
  const mapped = useMemo(() => rows.map((r, idx) => {
    const data: Record<string, string> = {}
    headers.forEach((h, i) => { const key = h || `Column ${i + 1}`; const v = r[i]; data[key] = v instanceof Date ? normDate(v) : String(v ?? '') })
    return {
      i: idx,
      so: colSO !== '' ? normSO(r[Number(colSO)]) : '',
      customer: colCust !== '' ? String(r[Number(colCust)] ?? '').trim() : '',
      data,
    }
  }).filter(m => m.so && (showScheduled || !scheduledSOs.has(m.so) || onlyScheduledYesterday(m.so))), [rows, headers, colSO, colCust, scheduledSOs, schedDatesBySO, showScheduled, carryDate])
  const pendingCount = mapped.filter(m => !scheduledSOs.has(m.so)).length
  const yesterdayCount = mapped.length - pendingCount

  // Column holding the PO delivery date (UDF_PODELDATE) — rows due tomorrow get highlighted.
  const podelKey = useMemo(() => headers.find(h => /podel/i.test(h)) || '', [headers])
  // Column holding the ON HOLD flag — rows with "T" get highlighted red.
  const holdKey = useMemo(() => headers.find(h => /hold/i.test(h)) || '', [headers])
  const isHold = (v: unknown) => String(v ?? '').trim().toUpperCase() === 'T'
  const allSel = mapped.length > 0 && mapped.every(m => sel.has(m.i))
  const toggleAll = () => setSel(allSel ? new Set() : new Set(mapped.map(m => m.i)))
  const toggleRow = (i: number) => setSel(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n })

  async function assignSelected() {
    const chosen = mapped.filter(m => sel.has(m.i))
    if (chosen.length === 0) { setError('Tick the orders you want to assign first.'); return }
    if (!date) { setError('Pick the delivery date.'); return }
    setBusy('assign'); setError(''); setSuccess('')
    const ins = chosen.map(m => ({ so_number: m.so, customer_name: m.customer || null, route: assignLine, delivery_date: date, data: m.data, created_by: profile?.id, created_by_name: profile?.full_name }))
    const { error: e } = await supabase.from('delivery_schedule').insert(ins)
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`${ins.length} order(s) assigned to ${assignLine}.`)
    const removed = new Set(chosen.map(m => m.i))
    setRows(rows.filter((_, idx) => !removed.has(idx)))
    setSel(new Set())
    load()
  }

  async function removeSched(id: string) { await supabase.from('delivery_schedule').delete().eq('id', id); load() }
  async function updateSched(id: string, patch: Partial<Sched>) { await supabase.from('delivery_schedule').update(patch).eq('id', id); load() }

  const schedDates = useMemo(() => [...new Set(sched.map(s => s.delivery_date).filter(Boolean) as string[])].sort(), [sched])
  const shownSched = useMemo(() => sched.filter(s =>
    (routeFilter === 'all' || (s.route || '') === routeFilter) &&
    (dateFilter === 'all' || s.delivery_date === dateFilter)
  ), [sched, routeFilter, dateFilter])

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <>
      <style>{`@media print {
        @page { size: A4 portrait; margin: 8mm; }
        body * { visibility: hidden; }
        #delivery-print, #delivery-print * { visibility: visible; }
        #delivery-print { position: absolute; left: 0; top: 0; width: 100%; color: #000; }
        /* one consistent size so nothing renders tiny or huge */
        #delivery-print, #delivery-print * { font-size: 8.5px !important; line-height: 1.25 !important; }
        #delivery-print h1 { font-size: 15px !important; font-weight: 700; }
        #delivery-print table { width: 100%; table-layout: fixed; border-collapse: collapse; }
        #delivery-print th, #delivery-print td { border: 1px solid #bbb; padding: 2px 4px !important; vertical-align: top; text-align: left; white-space: normal; word-break: break-word; overflow: hidden; }
        #delivery-print thead th { background: #f3f4f6 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        /* the 8 visible columns fill the page; date columns never wrap */
        #delivery-print th:nth-child(1), #delivery-print td:nth-child(1) { width: 8%; white-space: nowrap; }
        #delivery-print th:nth-child(2), #delivery-print td:nth-child(2) { width: 9%; }
        #delivery-print th:nth-child(3), #delivery-print td:nth-child(3) { width: 13%; }
        #delivery-print th:nth-child(4), #delivery-print td:nth-child(4),
        #delivery-print th:nth-child(5), #delivery-print td:nth-child(5),
        #delivery-print th:nth-child(6), #delivery-print td:nth-child(6) { width: 11%; white-space: nowrap; }
        #delivery-print th:nth-child(7), #delivery-print td:nth-child(7) { width: 30%; }
        #delivery-print th:nth-child(8), #delivery-print td:nth-child(8) { width: 7%; text-align: center; }
        /* the full-width pending detail strip must NOT inherit the column widths */
        #delivery-print tr.pend-row td { width: auto !important; white-space: normal !important; }
        .no-print { display: none !important; }
        #delivery-print input, #delivery-print select { border: none !important; padding: 0 !important; background: transparent !important; -webkit-appearance: none; appearance: none; color: #000 !important; }
        #delivery-print .shadow-sm { box-shadow: none !important; }
        #delivery-print .border { break-inside: avoid; }
      }`}</style>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="w-full max-w-[2000px] mx-auto p-4 sm:p-6">
        <h1 className="text-2xl font-bold mb-1">Delivery Schedule</h1>
        <p className="text-gray-500 mb-5 text-sm">Upload orders from SQL Accounting, then tick the orders and assign them to a delivery line (A–K). Orders due <strong>tomorrow</strong> show a yellow <span className="bg-yellow-200 text-yellow-900 px-1 rounded text-xs font-semibold">TOMORROW DELIVERY</span> tag across Sales Orders and production.</p>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {success && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{success}</div>}

        {/* Upload & assign */}
        <div className="border rounded-2xl p-4 sm:p-5 bg-white shadow-sm mb-8">
          <h2 className="font-semibold mb-3">Upload orders &amp; assign to lines</h2>
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border bg-gray-50 hover:bg-gray-100 text-sm font-medium cursor-pointer">
            📄 Choose Excel / CSV file
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          </label>
          {fileName && <span className="ml-2 text-sm text-gray-500">{fileName} · <strong>{pendingCount}</strong> pending{yesterdayCount ? ` · ${yesterdayCount} carried over from the day before (green)` : ''}</span>}
          {headers.length > 0 && <label className="ml-3 inline-flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"><input type="checkbox" checked={showScheduled} onChange={e => setShowScheduled(e.target.checked)} className="h-4 w-4" /> Show already-scheduled too</label>}

          {headers.length > 0 && (
            <>
              <div className="grid sm:grid-cols-2 gap-3 mt-4">
                <label className="block"><span className="text-xs text-gray-500">SO number column *</span>
                  <select value={colSO} onChange={e => setColSO(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mt-1">
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select></label>
                <label className="block"><span className="text-xs text-gray-500">Customer column (optional)</span>
                  <select value={colCust} onChange={e => setColCust(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mt-1">
                    <option value="">— none —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select></label>
              </div>

              <div className="flex flex-wrap items-end gap-3 mt-4 p-3 bg-blue-50 rounded-lg">
                <span className="text-sm font-medium text-blue-900 self-center">{sel.size} selected →</span>
                <label className="block"><span className="text-xs text-gray-500">Assign to line</span>
                  <select value={assignLine} onChange={e => setAssignLine(e.target.value)} className="block w-48 border rounded-lg px-3 py-2 text-sm mt-1">
                    {LINES.map(l => <option key={l} value={l}>{lineLabel(l, date)}</option>)}
                  </select></label>
                <label className="block"><span className="text-xs text-gray-500">Delivery date (you set this)</span>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} className="block border rounded-lg px-3 py-2 text-sm mt-1" /></label>
                <button onClick={assignSelected} disabled={busy === 'assign' || sel.size === 0} className="px-5 py-2 rounded-lg bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 disabled:opacity-50">
                  {busy === 'assign' ? 'Assigning…' : `Assign ${sel.size || ''} to ${assignLine}`}
                </button>
              </div>

              <div className="mt-3 border rounded-lg overflow-auto max-h-96">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-gray-50 text-gray-500 text-left sticky top-0">
                    <tr>
                      <th className="px-3 py-2"><input type="checkbox" checked={allSel} onChange={toggleAll} className="h-4 w-4" /></th>
                      {headers.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h || `Column ${i + 1}`}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {mapped.length === 0 && <tr><td colSpan={headers.length + 1} className="px-3 py-4 text-gray-400 text-center">Nothing left to assign — pick the SO column above, or all rows are assigned.</td></tr>}
                    {mapped.map(m => {
                      const dueT = !!podelKey && m.data[podelKey] === tomorrowISO()
                      const hold = !!holdKey && isHold(m.data[holdKey])
                      const schedYest = scheduledSOs.has(m.so)
                      return (
                      <tr key={m.i} className={`border-t ${sel.has(m.i) ? 'bg-blue-100' : hold ? 'bg-red-100' : schedYest ? 'bg-green-100' : dueT ? 'bg-yellow-100' : 'hover:bg-gray-50'}`}>
                        <td className="px-3 py-1.5 whitespace-nowrap"><input type="checkbox" checked={sel.has(m.i)} onChange={() => toggleRow(m.i)} className="h-4 w-4" />{schedYest && <span className="ml-1 text-[10px] text-green-700 font-semibold">scheduled</span>}</td>
                        {headers.map((h, i) => { const key = h || `Column ${i + 1}`; return <td key={i} className="px-3 py-1.5 text-gray-700">{cellView(m.data[key])}</td> })}
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {uploads.length > 0 && (
            <div className="mt-4 border-t pt-3">
              <div className="text-xs text-gray-500 mb-1">Saved files (re-open to amend a schedule)</div>
              <div className="flex flex-wrap gap-2">
                {uploads.map(u => (
                  <span key={u.id} className="inline-flex items-center gap-1.5 bg-gray-100 rounded-full pl-3 pr-2 py-1 text-xs">
                    <button onClick={() => openUpload(u)} className="text-blue-600 hover:underline" title="Re-open to amend / continue scheduling">📄 {u.file_name}</button>
                    <span className="text-gray-400">{new Date(u.created_at).toLocaleDateString()}</span>
                    <button onClick={() => deleteUpload(u)} className="text-gray-400 hover:text-red-600">✕</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Scheduled list */}
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3 no-print">
          <h2 className="font-semibold">Scheduled deliveries</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => window.print()} className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 text-white hover:bg-gray-900">🖨 Print / PDF</button>
            <button onClick={() => setShowManage(true)} className="text-sm px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50">🚚 Manage lorries / drivers / kelindan</button>
            <label className="flex items-center gap-2 text-sm text-gray-500">Date
              <select value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
                <option value="all">All dates</option>
                {schedDates.map(d => { const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/); return <option key={d} value={d}>{m ? `${m[3]}/${m[2]}/${m[1]}` : d}</option> })}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-500">Line
              <select value={routeFilter} onChange={e => setRouteFilter(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
                <option value="all">All</option>
                {LINES.map(l => <option key={l} value={l}>{lineLabel(l, dateFilter !== 'all' ? dateFilter : undefined)}</option>)}
              </select>
            </label>
          </div>
        </div>

        {showManage && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-auto no-print" onClick={() => setShowManage(false)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl mt-10 p-5" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-lg">Lorries · Drivers · Kelindan</h3>
                <button onClick={() => setShowManage(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
              <p className="text-sm text-gray-500 mb-4">These saved names appear as a dropdown when you fill in a trip. Add or remove them here. (This master list is what your future driver app will use.)</p>
              <div className="grid sm:grid-cols-3 gap-4">
                {(['lorry', 'driver', 'kelindan'] as const).map(kind => (
                  <div key={kind} className="border rounded-xl p-3">
                    <div className="font-medium capitalize mb-2">{kind === 'lorry' ? 'Lorries' : kind === 'driver' ? 'Drivers' : 'Kelindan'} <span className="text-gray-400 font-normal">({resources[kind].length})</span></div>
                    <div className="flex flex-col gap-1 mb-2">
                      <input value={newRes[kind]} onChange={e => setNewRes(p => ({ ...p, [kind]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addResource(kind, newRes[kind], newPhone[kind]) }} placeholder={kind === 'lorry' ? 'Lorry no…' : 'Name…'} className="border rounded px-2 py-1 text-sm w-full" />
                      <div className="flex gap-1">
                        {kind !== 'lorry' && <input value={newPhone[kind]} onChange={e => setNewPhone(p => ({ ...p, [kind]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') addResource(kind, newRes[kind], newPhone[kind]) }} placeholder="Phone (optional)" className="border rounded px-2 py-1 text-sm w-full" />}
                        <button onClick={() => addResource(kind, newRes[kind], newPhone[kind])} className="px-3 py-1 rounded bg-gray-800 text-white text-sm shrink-0">Add</button>
                      </div>
                    </div>
                    <ul className="space-y-1 max-h-60 overflow-auto">
                      {resources[kind].length === 0 && <li className="text-xs text-gray-400">None yet.</li>}
                      {resources[kind].map(r => (
                        <li key={r.id} className="flex items-center justify-between gap-2 text-sm border-b border-gray-100 py-1">
                          <span>{r.name}{r.phone && <span className="text-gray-400 text-xs ml-1">· {r.phone}</span>}</span>
                          <button onClick={() => removeResource(r.id)} className="text-red-500 hover:text-red-700 text-xs shrink-0">Remove</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {shownSched.length === 0 ? <p className="text-gray-400 text-sm">No scheduled deliveries.</p> : (() => {
          const allKeys: string[] = []
          shownSched.forEach(s => { if (s.data) Object.keys(s.data).forEach(k => { if (!allKeys.includes(k)) allKeys.push(k) }) })
          const podelKeyS = allKeys.find(c => /podel/i.test(c)) || ''                         // PO delivery date
          const orderDateKey = allKeys.find(c => c.trim().toLowerCase() === 'date') || allKeys.find(c => /order\s*date/i.test(c)) || ''   // order/PO date
          const cancelKey = allKeys.find(c => /cancel/i.test(c)) || ''                          // PO expired / cancel date
          const custKey = allKeys.find(c => /company|customer/i.test(c)) || ''
          const linkKey = allKeys.find(c => /drive|link/i.test(c)) || ''
          const holdKeyS = allKeys.find(c => /hold/i.test(c)) || ''
          const fmtD = (d: string | null) => { const m = (d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || '—') }
          // "Pending" = production not yet completed. Totals overall + per line.
          const totalPending = shownSched.filter(s => !soProd[s.so_number]?.done).length
          const pendByLine: Record<string, number> = {}
          shownSched.forEach(s => { if (!soProd[s.so_number]?.done) { const l = s.route || 'Unassigned'; pendByLine[l] = (pendByLine[l] || 0) + 1 } })
          // Group by line + delivery date (one box per trip).
          const groups: Record<string, { route: string | null; date: string | null; rows: Sched[] }> = {}
          shownSched.forEach(s => { const k = `${s.route || ''}||${s.delivery_date || ''}`; (groups[k] = groups[k] || { route: s.route, date: s.delivery_date, rows: [] }).rows.push(s) })
          const li = (r: string | null) => { const i = LINES.indexOf(r || ''); return i < 0 ? 999 : i }
          const keys = Object.keys(groups).sort((a, b) => (li(groups[a].route) - li(groups[b].route)) || (groups[a].date || '').localeCompare(groups[b].date || ''))
          // Driver trips summary (each line+date with a driver = one trip), respecting the date filter.
          const driverSum: Record<string, { total: number; cat: Record<string, number> }> = {}
          Object.values(trips).filter(t => (dateFilter === 'all' || t.delivery_date === dateFilter) && (t.driver || '').trim())
            .forEach(t => { const d = t.driver!.trim(); const e = (driverSum[d] = driverSum[d] || { total: 0, cat: {} }); e.total++; const c = t.category || '—'; e.cat[c] = (e.cat[c] || 0) + 1 })
          const driverNames = Object.keys(driverSum).sort()
          return (
          <div id="delivery-print" className="space-y-5">
            <div className="hidden print:block mb-2"><h1 className="text-xl font-bold">Delivery Schedule{dateFilter !== 'all' ? ` — ${fmtD(dateFilter)}` : ''}</h1></div>
            <div className="mb-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm">
              <strong>Production pending: {totalPending} of {shownSched.length}</strong>
              {Object.keys(pendByLine).length > 0 && <span className="text-gray-600"> · {Object.entries(pendByLine).sort((a, b) => li(a[0]) - li(b[0])).map(([l, n]) => `${l}: ${n}`).join('  ·  ')}</span>}
            </div>
            {driverNames.length > 0 && (
              <div className="mb-3 p-3 rounded-lg bg-gray-50 border text-sm">
                <div className="font-semibold mb-1">Driver trips{dateFilter !== 'all' ? ` — ${fmtD(dateFilter)}` : ' (all dates)'}</div>
                <div className="grid sm:grid-cols-2 gap-x-6 gap-y-0.5">
                  {driverNames.map(d => <div key={d}><strong>{d}</strong>: {driverSum[d].total} trip(s) <span className="text-gray-500">({Object.entries(driverSum[d].cat).map(([c, n]) => `${c} ${n}`).join(', ')})</span></div>)}
                </div>
              </div>
            )}
            {keys.map(k => {
              const g = groups[k]
              const tripKey = g.route && g.date ? `${g.route}|${g.date}` : ''
              const availRes = (kind: 'lorry' | 'driver' | 'kelindan') => resources[kind].filter(r => { const o = ownerOf(g.date, kind, r.name); return !o || o === g.route })
              const trip = tripKey ? trips[tripKey] : undefined
              return (
              <div key={k} className="border rounded-xl bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-2 bg-gray-100 flex items-start justify-between flex-wrap gap-2">
                  <div>
                    <span className="font-semibold">{g.route ? lineLabel(g.route, g.date) : 'Unassigned'}{g.date ? ` · ${fmtD(g.date)}` : ''} <span className="text-gray-500 font-normal text-sm">· {g.rows.length} order(s){(() => { const p = g.rows.filter(s => !soProd[s.so_number]?.done).length; return p ? ` · ${p} in production` : '' })()}</span></span>
                    {(() => {
                      // Production progress by location (per-batch), so invoicing knows exactly which factory to chase.
                      const loc: Record<string, { total: number; done: number }> = {}
                      g.rows.forEach(s => {
                        const m = soLoc[s.so_number]
                        if (m && Object.keys(m).length) {
                          Object.entries(m).forEach(([f, c]) => { const e = (loc[f] = loc[f] || { total: 0, done: 0 }); e.total += c.total; e.done += c.done })
                        } else {
                          const f = soFactory[s.so_number] || 'No location'   // no batch yet → still pending at its sales-line factory
                          const e = (loc[f] = loc[f] || { total: 0, done: 0 }); e.total++
                        }
                      })
                      const parts = Object.entries(loc).sort((a, b) => a[0].localeCompare(b[0]))
                      return <div className="text-xs text-gray-500 mt-0.5">{parts.map(([f, c]) => `${c.done >= c.total ? '✓ ' : ''}${f} (${c.done}/${c.total})`).join('  ·  ')}</div>
                    })()}
                  </div>
                  {tripKey && (<>
                    <div className="flex items-center gap-2 text-xs flex-wrap no-print">
                      <select value={trip?.category || ''} onChange={e => { setTripField(g.route!, g.date!, 'category', e.target.value); saveTrip(g.route!, g.date!, { category: e.target.value }) }} className="border rounded px-2 py-1 bg-white">
                        <option value="">Type…</option>
                        {TRIP_TYPES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input value={trip?.remark || ''} placeholder="For (e.g. Klang)" onChange={e => setTripField(g.route!, g.date!, 'remark', e.target.value)} onBlur={() => saveTrip(g.route!, g.date!, {})} className="border rounded px-2 py-1 w-32" />
                      {(['lorry', 'driver', 'kelindan'] as const).map(kind => {
                        const field = (kind === 'lorry' ? 'lorry_no' : kind) as keyof Trip
                        const cur = (trip?.[field] as string) || ''
                        const opts = availRes(kind)
                        return (
                          <select key={kind} value={cur} onChange={e => commitResource(g.route!, g.date!, kind, field, e.target.value)} className="border rounded px-2 py-1 w-28 bg-white">
                            <option value="">{kind === 'lorry' ? 'Lorry no' : kind === 'driver' ? 'Driver' : 'Kelindan'}…</option>
                            {opts.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                            {cur && !opts.some(r => r.name === cur) && <option value={cur}>{cur}</option>}
                          </select>
                        )
                      })}
                    </div>
                    {/* Print-only: show only the filled-in trip details, no empty boxes */}
                    <div className="hidden print:block text-xs text-gray-700">{[trip?.category && `Type: ${trip.category}`, trip?.remark && `For: ${trip.remark}`, trip?.lorry_no && `Lorry: ${trip.lorry_no}`, trip?.driver && `Driver: ${trip.driver}`, trip?.kelindan && `Kelindan: ${trip.kelindan}`].filter(Boolean).join('   ·   ')}</div>
                  </>)}
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead className="bg-gray-50 text-gray-500 text-left">
                      <tr>
                        <th className="px-3 py-2">SO No</th>
                        <th className="px-3 py-2">Location</th>
                        <th className="px-3 py-2 status-col">Pending</th>
                        <th className="px-3 py-2">PO date</th>
                        <th className="px-3 py-2">Delivery date</th>
                        <th className="px-3 py-2">PO expired</th>
                        <th className="px-3 py-2">Customer</th>
                        <th className="px-3 py-2 text-center inv-col">Invoice ✓</th>
                        <th className="px-3 py-2 no-print">Doc</th>
                        <th className="px-3 py-2 no-print">Scheduled</th>
                        <th className="px-3 py-2 no-print">Move to</th><th className="no-print"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.rows.map(s => {
                        const isTomorrow = s.delivery_date === tomorrowISO()
                        const hold = !!holdKeyS && isHold(s.data?.[holdKeyS])
                        const its = soItems[s.so_number] || []
                        const pend = its.filter(i => !i.done)
                        const open = expanded.has(s.id)
                        return (
                          <Fragment key={s.id}>
                          <tr className={`border-t ${hold ? 'bg-red-100' : isTomorrow ? 'bg-yellow-50' : ''}`}>
                            <td className="px-3 py-1.5 font-mono">{s.so_number}</td>
                            <td className="px-3 py-1.5 text-gray-700">{(() => { const m = soLoc[s.so_number]; if (m && Object.keys(m).length) return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([f, c]) => `${f}${c.done >= c.total ? ' ✓' : c.done > 0 ? ` (${c.total - c.done} left)` : ''}`).join(', '); return soFactory[s.so_number] || '—' })()}</td>
                            <td className="px-3 py-1.5">{(() => {
                              if (!its.length) return <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500" title="No item lines found in Sales Orders for this SO — it may not have been imported yet">No order lines</span>
                              if (!pend.length) return <span className="px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">Completed</span>
                              // Pending count grouped by location; click to expand the item list.
                              const byLoc: Record<string, number> = {}
                              pend.forEach(i => { byLoc[i.factory] = (byLoc[i.factory] || 0) + 1 })
                              return <button type="button" onClick={() => toggleExpand(s.id)} className="flex flex-wrap items-center gap-1 text-left">{Object.entries(byLoc).sort((a, b) => a[0].localeCompare(b[0])).map(([f, n]) => <span key={f} className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700">{f} ({n} pending)</span>)}<span className="text-gray-400 text-[10px] no-print">{open ? '▲' : '▼'}</span></button>
                            })()}</td>
                            <td className="px-3 py-1.5 text-gray-700">{orderDateKey ? cellView(s.data?.[orderDateKey] ?? '') : '—'}</td>
                            <td className="px-3 py-1.5 text-gray-700">{podelKeyS ? cellView(s.data?.[podelKeyS] ?? '') : '—'}</td>
                            <td className="px-3 py-1.5 text-gray-700">{cancelKey ? cellView(s.data?.[cancelKey] ?? '') : '—'}</td>
                            <td className="px-3 py-1.5 text-gray-700">{(custKey && s.data?.[custKey]) || s.customer_name || '—'}</td>
                            <td className="px-3 py-1.5 text-center inv-col"><input type="checkbox" checked={s.invoiced} onChange={e => updateSched(s.id, { invoiced: e.target.checked })} className="h-4 w-4" /></td>
                            <td className="px-3 py-1.5 no-print">{linkKey && s.data?.[linkKey] ? cellView(s.data[linkKey]) : '—'}</td>
                            <td className="px-3 py-1.5 no-print"><input type="date" value={s.delivery_date || ''} onChange={e => updateSched(s.id, { delivery_date: e.target.value || null })} className="border rounded px-2 py-1 text-xs" />{isTomorrow && <span className="ml-1 bg-yellow-200 text-yellow-900 px-1 rounded text-[10px] font-semibold">TOMORROW</span>}</td>
                            <td className="px-3 py-1.5 no-print">
                              <select value={s.route || ''} onChange={e => updateSched(s.id, { route: e.target.value || null })} className="border rounded px-2 py-1 text-xs">
                                <option value="">—</option>
                                {LINES.map(l => <option key={l} value={l}>{lineLabel(l, s.delivery_date)}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-1.5 text-right no-print">
                              {s.route
                                ? <button onClick={() => updateSched(s.id, { route: null })} className="text-amber-600 hover:underline text-xs" title="Take off this line — it moves to the Unassigned box so you can re-assign it">Unassign</button>
                                : <button onClick={() => { if (confirm('Delete this order from the schedule for good?')) removeSched(s.id) }} className="text-red-600 hover:underline text-xs">Delete</button>}
                            </td>
                          </tr>
                          {pend.length > 0 && (
                            <tr className={`pend-row ${open ? 'bg-amber-50/40' : 'hidden print:table-row'}`}>
                              <td colSpan={12} className="px-4 pb-3 pt-1 whitespace-normal">
                                <div className="text-xs font-semibold text-gray-600 mb-1">{s.so_number} — {pend.length} item(s) pending</div>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-1">
                                  {pend.map((i, k) => (
                                    <div key={k} className="flex items-center justify-between gap-2 border-b border-gray-100 py-0.5">
                                      <span className="text-xs text-gray-700"><span className="text-gray-400 mr-1">{k + 1}.</span>{itemName[i.item] || i.item}{i.qty ? <span className="text-gray-500"> × {i.qty}</span> : ''}{i.factory !== 'No location' && <span className="text-gray-400"> · {i.factory}</span>}</span>
                                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CHIP[i.status] || 'bg-gray-100 text-gray-600'}`}>{i.status}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              )
            })}
          </div>
          )
        })()}
      </div>
    </>
  )
}
