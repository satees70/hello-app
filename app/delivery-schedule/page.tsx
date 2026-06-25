'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { tomorrowISO } from '@/lib/delivery'
import * as XLSX from 'xlsx'

interface Route { id: string; name: string }
interface Sched {
  id: string; so_number: string; customer_name: string | null; route_id: string | null
  delivery_date: string | null; created_by_name: string | null; data: Record<string, string> | null
}

// Normalise an SO value to "SO-#####" so it matches sales_order_lines.so_number.
function normSO(v: unknown): string {
  const raw = String(v ?? '').trim()
  const m = raw.match(/SO[-\s]?(\d+)/i)
  return m ? 'SO-' + m[1] : raw
}
// Excel dates come as JS Date (cellDates); strings get parsed. Returns YYYY-MM-DD or ''.
function normDate(v: unknown): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function DeliverySchedulePage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'dispatch')

  const [routes, setRoutes] = useState<Route[]>([])
  const [sched, setSched] = useState<Sched[]>([])
  const [newRoute, setNewRoute] = useState('')
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<unknown[][]>([])
  const [colSO, setColSO] = useState('')      // column index (as string) for the SO number
  const [colCust, setColCust] = useState('')  // optional customer column
  const [colDate, setColDate] = useState('')  // optional delivery-date column
  const [routeId, setRouteId] = useState('')
  const [date, setDate] = useState(tomorrowISO())
  const [routeFilter, setRouteFilter] = useState('all')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const routeName = (id: string | null) => routes.find(r => r.id === id)?.name || '—'

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [{ data: r }, { data: s }] = await Promise.all([
      supabase.from('delivery_routes').select('id, name').order('name'),
      supabase.from('delivery_schedule').select('id, so_number, customer_name, route_id, delivery_date, created_by_name, data').order('delivery_date', { ascending: true, nullsFirst: false }),
    ])
    setRoutes(r || [])
    setSched((s as Sched[]) || [])
  }

  async function addRoute() {
    const name = newRoute.trim()
    if (!name) return
    setError(''); setSuccess('')
    const { error: e } = await supabase.from('delivery_routes').insert({ name, created_by: profile?.id, created_by_name: profile?.full_name })
    if (e) { setError(e.message); return }
    setNewRoute(''); load()
  }
  async function delRoute(id: string) {
    if (!confirm('Delete this route? Orders assigned to it will keep their date but lose the route.')) return
    await supabase.from('delivery_routes').delete().eq('id', id); load()
  }

  async function onFile(f: File | undefined) {
    if (!f) return
    setError(''); setSuccess('')
    try {
      const buf = await f.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false }) as unknown[][]
      if (aoa.length === 0) { setError('That file looks empty.'); return }
      const hdr = (aoa[0] as unknown[]).map(x => String(x ?? '').trim())
      setFileName(f.name); setHeaders(hdr); setRows(aoa.slice(1))
      const find = (...keys: string[]) => String(hdr.findIndex(h => keys.some(k => h.toLowerCase().includes(k))))
      const so = find('so no', 'so number', 'sonumber', 'so'); setColSO(so === '-1' ? '0' : so)
      const cust = find('customer', 'company', 'name'); setColCust(cust === '-1' ? '' : cust)
      const dt = find('deliver', 'date'); setColDate(dt === '-1' ? '' : dt)
    } catch { setError('Could not read that file. Make sure it is an Excel or CSV export.') }
  }

  // Map the uploaded rows using the chosen columns, keeping the WHOLE row as data.
  const mapped = rows.map(r => {
    const data: Record<string, string> = {}
    headers.forEach((h, i) => { const key = h || `Column ${i + 1}`; const v = r[i]; data[key] = v instanceof Date ? normDate(v) : String(v ?? '') })
    return {
      so: colSO !== '' ? normSO(r[Number(colSO)]) : '',
      customer: colCust !== '' ? String(r[Number(colCust)] ?? '').trim() : '',
      rowDate: colDate !== '' ? normDate(r[Number(colDate)]) : '',
      data,
    }
  }).filter(m => m.so)

  async function addToSchedule() {
    if (!routeId) { setError('Pick a route.'); return }
    if (mapped.length === 0) { setError('No SO numbers found — check the column mapping.'); return }
    if (colDate === '' && !date) { setError('Pick a delivery date (or map a date column).'); return }
    setBusy('add'); setError(''); setSuccess('')
    const ins = mapped.map(m => ({ so_number: m.so, customer_name: m.customer || null, route_id: routeId, delivery_date: m.rowDate || date, data: m.data, created_by: profile?.id, created_by_name: profile?.full_name }))
    const { error: e } = await supabase.from('delivery_schedule').insert(ins)
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`${ins.length} order(s) scheduled on ${routeName(routeId)}.`)
    setFileName(''); setHeaders([]); setRows([]); setColSO(''); setColCust(''); setColDate(''); load()
  }
  async function removeSched(id: string) { await supabase.from('delivery_schedule').delete().eq('id', id); load() }
  async function updateSched(id: string, patch: Partial<Sched>) { await supabase.from('delivery_schedule').update(patch).eq('id', id); load() }

  const shownSched = useMemo(() => routeFilter === 'all' ? sched : sched.filter(s => (s.route_id || '') === routeFilter), [sched, routeFilter])

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <h1 className="text-2xl font-bold mb-1">Delivery Schedule</h1>
        <p className="text-gray-500 mb-5 text-sm">Create routes, paste orders from SQL Accounting (by SO number), and assign them to a route + delivery date. Orders due <strong>tomorrow</strong> show a yellow <span className="bg-yellow-200 text-yellow-900 px-1 rounded text-xs font-semibold">TOMORROW DELIVERY</span> tag across Sales Orders and production.</p>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {success && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{success}</div>}

        {/* Routes */}
        <div className="border rounded-2xl p-4 sm:p-5 bg-white shadow-sm mb-6">
          <h2 className="font-semibold mb-3">Routes</h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {routes.map(r => (
              <span key={r.id} className="inline-flex items-center gap-1.5 bg-gray-100 rounded-full px-3 py-1 text-sm">
                {r.name}
                <button onClick={() => delRoute(r.id)} className="text-gray-400 hover:text-red-600">✕</button>
              </span>
            ))}
            {routes.length === 0 && <span className="text-gray-400 text-sm">No routes yet — add one below.</span>}
          </div>
          <div className="flex gap-2">
            <input value={newRoute} onChange={e => setNewRoute(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRoute()} placeholder="New route name (e.g. KL Truck, Route A)" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
            <button onClick={addRoute} className="px-4 py-2 rounded-lg border bg-gray-50 hover:bg-gray-100 text-sm font-medium">+ Add route</button>
          </div>
        </div>

        {/* Upload & schedule */}
        <div className="border rounded-2xl p-4 sm:p-5 bg-white shadow-sm mb-8">
          <h2 className="font-semibold mb-3">Upload orders &amp; schedule</h2>
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border bg-gray-50 hover:bg-gray-100 text-sm font-medium cursor-pointer">
            📄 Choose Excel / CSV file
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          </label>
          {fileName && <span className="ml-2 text-sm text-gray-500">{fileName} · {rows.length} row(s)</span>}

          {headers.length > 0 && (
            <>
              <div className="grid sm:grid-cols-3 gap-3 mt-4">
                <label className="block"><span className="text-xs text-gray-500">SO number column *</span>
                  <select value={colSO} onChange={e => setColSO(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mt-1">
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select></label>
                <label className="block"><span className="text-xs text-gray-500">Customer column (optional)</span>
                  <select value={colCust} onChange={e => setColCust(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mt-1">
                    <option value="">— none —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select></label>
                <label className="block"><span className="text-xs text-gray-500">Delivery-date column (optional)</span>
                  <select value={colDate} onChange={e => setColDate(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mt-1">
                    <option value="">— use the date picker below —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select></label>
              </div>

              <div className="flex flex-wrap items-end gap-3 mt-4">
                <label className="block"><span className="text-xs text-gray-500">Route *</span>
                  <select value={routeId} onChange={e => setRouteId(e.target.value)} className="block w-44 border rounded-lg px-3 py-2 text-sm mt-1">
                    <option value="">Pick a route…</option>
                    {routes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select></label>
                {colDate === '' && <label className="block"><span className="text-xs text-gray-500">Delivery date</span>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} className="block border rounded-lg px-3 py-2 text-sm mt-1" /></label>}
                <button onClick={addToSchedule} disabled={busy === 'add' || mapped.length === 0} className="px-5 py-2 rounded-lg bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 disabled:opacity-50">
                  {busy === 'add' ? 'Adding…' : `Add ${mapped.length || ''} to schedule`}
                </button>
              </div>

              <div className="mt-3 border rounded-lg overflow-auto max-h-72">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-left sticky top-0"><tr><th className="px-3 py-2">SO number</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Delivery date</th></tr></thead>
                  <tbody>
                    {mapped.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-gray-400 text-center">No SO numbers detected — pick the correct SO column above.</td></tr>}
                    {mapped.slice(0, 200).map((m, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-1.5 font-mono">{m.so}</td>
                        <td className="px-3 py-1.5 text-gray-600">{m.customer || '—'}</td>
                        <td className="px-3 py-1.5 text-gray-600">{m.rowDate || (colDate === '' ? date : '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mapped.length > 200 && <p className="text-[11px] text-gray-400 mt-1">Showing first 200 of {mapped.length}.</p>}
            </>
          )}
        </div>

        {/* Scheduled list */}
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">Scheduled deliveries</h2>
          <label className="flex items-center gap-2 text-sm text-gray-500">Route
            <select value={routeFilter} onChange={e => setRouteFilter(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
              <option value="all">All</option>
              {routes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        </div>
        {shownSched.length === 0 ? <p className="text-gray-400 text-sm">No scheduled deliveries.</p> : (() => {
          // Every column that came from the uploaded files (union, in first-seen order).
          const dataCols: string[] = []
          shownSched.forEach(s => { if (s.data) Object.keys(s.data).forEach(k => { if (!dataCols.includes(k)) dataCols.push(k) }) })
          return (
          <div className="border rounded-xl overflow-auto bg-white shadow-sm">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-gray-50 text-gray-500 text-left sticky top-0">
                <tr>
                  {dataCols.length === 0 && <><th className="px-3 py-2">SO</th><th className="px-3 py-2">Customer</th></>}
                  {dataCols.map(c => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}
                  <th className="px-3 py-2">Route</th><th className="px-3 py-2">Delivery date</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shownSched.map(s => {
                  const isTomorrow = s.delivery_date === tomorrowISO()
                  return (
                    <tr key={s.id} className={`border-t ${isTomorrow ? 'bg-yellow-50' : ''}`}>
                      {dataCols.length === 0 && <><td className="px-3 py-1.5 font-mono">{s.so_number}</td><td className="px-3 py-1.5 text-gray-600">{s.customer_name || '—'}</td></>}
                      {dataCols.map(c => <td key={c} className="px-3 py-1.5 text-gray-700">{s.data?.[c] ?? ''}</td>)}
                      <td className="px-3 py-1.5">
                        <select value={s.route_id || ''} onChange={e => updateSched(s.id, { route_id: e.target.value || null })} className="border rounded px-2 py-1 text-xs">
                          <option value="">—</option>
                          {routes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-1.5"><input type="date" value={s.delivery_date || ''} onChange={e => updateSched(s.id, { delivery_date: e.target.value || null })} className="border rounded px-2 py-1 text-xs" />{isTomorrow && <span className="ml-1 bg-yellow-200 text-yellow-900 px-1 rounded text-[10px] font-semibold">TOMORROW</span>}</td>
                      <td className="px-3 py-1.5 text-right"><button onClick={() => removeSched(s.id)} className="text-red-600 hover:underline text-xs">Remove</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )
        })()}
      </div>
    </>
  )
}
