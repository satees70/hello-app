'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { tomorrowISO } from '@/lib/delivery'
import * as XLSX from 'xlsx'

interface Sched {
  id: string; so_number: string; customer_name: string | null; route: string | null
  delivery_date: string | null; created_by_name: string | null; data: Record<string, string> | null
}

// Fixed delivery lines A … K.
const LINES = Array.from({ length: 11 }, (_, i) => 'LINE ' + String.fromCharCode(65 + i))

function normSO(v: unknown): string {
  const raw = String(v ?? '').trim()
  const m = raw.match(/SO[-\s]?(\d+)/i)
  return m ? 'SO-' + m[1] : raw
}
function normDate(v: unknown): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// How a data cell is shown: links become clickable, ISO dates become dd/mm/yyyy.
function cellView(v: string): React.ReactNode {
  if (!v) return ''
  if (/^https?:\/\//i.test(v)) return <a href={v} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Open ↗</a>
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  return v
}

export default function DeliverySchedulePage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'dispatch')

  const [sched, setSched] = useState<Sched[]>([])
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
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => { if (profile) { load(); loadUploads() } }, [profile])
  async function load() {
    const { data: s } = await supabase.from('delivery_schedule').select('id, so_number, customer_name, route, delivery_date, created_by_name, data').order('route', { ascending: true, nullsFirst: false }).order('delivery_date', { ascending: true, nullsFirst: false })
    setSched((s as Sched[]) || [])
  }
  async function loadUploads() {
    const { data } = await supabase.from('delivery_uploads').select('id, file_name, path, created_at, created_by_name').order('created_at', { ascending: false }).limit(30)
    setUploads(data || [])
  }
  async function openUpload(path: string) {
    const { data } = await supabase.storage.from('delivery-files').createSignedUrl(path, 120)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  async function deleteUpload(u: { id: string; path: string }) {
    if (!confirm('Delete this saved file?')) return
    await supabase.storage.from('delivery-files').remove([u.path])
    await supabase.from('delivery_uploads').delete().eq('id', u.id)
    loadUploads()
  }

  async function onFile(f: File | undefined) {
    if (!f) return
    setError(''); setSuccess(''); setSel(new Set())
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
      // Keep the file so the schedule can be amended later.
      try {
        const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${Date.now()}-${safe}`
        const up = await supabase.storage.from('delivery-files').upload(path, f)
        if (!up.error) { await supabase.from('delivery_uploads').insert({ file_name: f.name, path, created_by: profile?.id, created_by_name: profile?.full_name }); loadUploads() }
      } catch { /* keeping the file is best-effort; parsing still works without it */ }
    } catch { setError('Could not read that file. Make sure it is an Excel or CSV export.') }
  }

  // Rows that still need assigning (have an SO), keeping the source index.
  const mapped = useMemo(() => rows.map((r, idx) => {
    const data: Record<string, string> = {}
    headers.forEach((h, i) => { const key = h || `Column ${i + 1}`; const v = r[i]; data[key] = v instanceof Date ? normDate(v) : String(v ?? '') })
    return {
      i: idx,
      so: colSO !== '' ? normSO(r[Number(colSO)]) : '',
      customer: colCust !== '' ? String(r[Number(colCust)] ?? '').trim() : '',
      data,
    }
  }).filter(m => m.so), [rows, headers, colSO, colCust])

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
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto p-4 sm:p-6">
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
          {fileName && <span className="ml-2 text-sm text-gray-500">{fileName} · {mapped.length} order(s) left to assign</span>}

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
                  <select value={assignLine} onChange={e => setAssignLine(e.target.value)} className="block w-36 border rounded-lg px-3 py-2 text-sm mt-1">
                    {LINES.map(l => <option key={l} value={l}>{l}</option>)}
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
                      return (
                      <tr key={m.i} className={`border-t ${sel.has(m.i) ? 'bg-blue-100' : hold ? 'bg-red-100' : dueT ? 'bg-yellow-100' : 'hover:bg-gray-50'}`}>
                        <td className="px-3 py-1.5"><input type="checkbox" checked={sel.has(m.i)} onChange={() => toggleRow(m.i)} className="h-4 w-4" /></td>
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
                    <button onClick={() => openUpload(u.path)} className="text-blue-600 hover:underline">📄 {u.file_name}</button>
                    <span className="text-gray-400">{new Date(u.created_at).toLocaleDateString()}</span>
                    <button onClick={() => deleteUpload(u)} className="text-gray-400 hover:text-red-600">✕</button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Scheduled list */}
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">Scheduled deliveries</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-gray-500">Date
              <select value={dateFilter} onChange={e => setDateFilter(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
                <option value="all">All dates</option>
                {schedDates.map(d => { const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/); return <option key={d} value={d}>{m ? `${m[3]}/${m[2]}/${m[1]}` : d}</option> })}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-500">Line
              <select value={routeFilter} onChange={e => setRouteFilter(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm">
                <option value="all">All</option>
                {LINES.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>
        </div>
        {shownSched.length === 0 ? <p className="text-gray-400 text-sm">No scheduled deliveries.</p> : (() => {
          const dataCols: string[] = []
          shownSched.forEach(s => { if (s.data) Object.keys(s.data).forEach(k => { if (!dataCols.includes(k)) dataCols.push(k) }) })
          const schedHoldKey = dataCols.find(c => /hold/i.test(c)) || ''
          // Group by line, ordering LINE A..K first then anything else / unassigned.
          const groups: Record<string, Sched[]> = {}
          shownSched.forEach(s => { const k = s.route || 'Unassigned'; (groups[k] = groups[k] || []).push(s) })
          const order = [...LINES.filter(l => groups[l]), ...Object.keys(groups).filter(k => !LINES.includes(k))]
          return (
          <div className="space-y-5">
            {order.map(line => (
              <div key={line} className="border rounded-xl bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-2 bg-gray-100 flex items-center justify-between">
                  <span className="font-semibold">{line}</span>
                  <span className="text-gray-500 text-sm">{groups[line].length} order(s)</span>
                </div>
                <div className="overflow-auto">
                  <table className="w-full text-sm whitespace-nowrap">
                    <thead className="bg-gray-50 text-gray-500 text-left">
                      <tr>
                        {dataCols.length === 0 && <><th className="px-3 py-2">SO</th><th className="px-3 py-2">Customer</th></>}
                        {dataCols.map(c => <th key={c} className="px-3 py-2 font-medium">{c}</th>)}
                        <th className="px-3 py-2">Delivery date</th><th className="px-3 py-2">Move to</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups[line].map(s => {
                        const isTomorrow = s.delivery_date === tomorrowISO()
                        const hold = !!schedHoldKey && isHold(s.data?.[schedHoldKey])
                        return (
                          <tr key={s.id} className={`border-t ${hold ? 'bg-red-100' : isTomorrow ? 'bg-yellow-50' : ''}`}>
                            {dataCols.length === 0 && <><td className="px-3 py-1.5 font-mono">{s.so_number}</td><td className="px-3 py-1.5 text-gray-600">{s.customer_name || '—'}</td></>}
                            {dataCols.map(c => <td key={c} className="px-3 py-1.5 text-gray-700">{cellView(s.data?.[c] ?? '')}</td>)}
                            <td className="px-3 py-1.5"><input type="date" value={s.delivery_date || ''} onChange={e => updateSched(s.id, { delivery_date: e.target.value || null })} className="border rounded px-2 py-1 text-xs" />{isTomorrow && <span className="ml-1 bg-yellow-200 text-yellow-900 px-1 rounded text-[10px] font-semibold">TOMORROW</span>}</td>
                            <td className="px-3 py-1.5">
                              <select value={s.route || ''} onChange={e => updateSched(s.id, { route: e.target.value || null })} className="border rounded px-2 py-1 text-xs">
                                <option value="">—</option>
                                {LINES.map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-1.5 text-right"><button onClick={() => removeSched(s.id)} className="text-red-600 hover:underline text-xs">Remove</button></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
          )
        })()}
      </div>
    </>
  )
}
