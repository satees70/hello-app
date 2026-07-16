'use client'
import { Fragment, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'

interface Order {
  id: string; order_no: string | null; customer_name: string | null; order_date: string | null; delivery_date: string | null
  file_name: string | null; file_path: string | null; status: string; source: string
  error_message: string | null; uploaded_by_name: string | null; created_at: string
  assigned_to: string | null; assigned_to_name: string | null; pick_started_at: string | null; pick_completed_at: string | null
  wms_order_lines?: { count: number }[]
}
interface Picker { id: string; full_name: string | null }
interface PickerUser { id: string; full_name: string | null; is_picker: boolean }

// Pick duration for KPI: mins between start and finish, else "picking…" while in progress.
const pickDur = (o: Order) => {
  if (!o.pick_started_at) return ''
  const end = o.pick_completed_at ? new Date(o.pick_completed_at).getTime() : Date.now()
  const mins = Math.max(0, Math.round((end - new Date(o.pick_started_at).getTime()) / 60000))
  const s = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
  return o.pick_completed_at ? `⏱ ${s}` : `⏱ ${s}…`
}
interface Line { id: string; line_no: number | null; item_id: string | null; item_code: string; description: string | null; quantity: number; uom: string | null; source_hint: string | null; remarks: string | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const STATUS_CHIP: Record<string, string> = {
  Processing: 'bg-gray-100 text-gray-600', Review: 'bg-amber-100 text-amber-700', Released: 'bg-emerald-100 text-emerald-700',
  Reserved: 'bg-teal-100 text-teal-700', Picking: 'bg-emerald-100 text-emerald-700', Picked: 'bg-emerald-100 text-emerald-700',
  Checked: 'bg-teal-100 text-teal-700',
  'Partially Dispatched': 'bg-emerald-100 text-emerald-700', Dispatched: 'bg-emerald-100 text-emerald-700', Error: 'bg-red-100 text-red-700', Cancelled: 'bg-gray-100 text-gray-400',
}

export default function WmsOrdersPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [orders, setOrders] = useState<Order[]>([])
  const [pickers, setPickers] = useState<Picker[]>([])
  const [showPickers, setShowPickers] = useState(false)
  const [manageUsers, setManageUsers] = useState<PickerUser[]>([])
  const [manageQ, setManageQ] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [linesFor, setLinesFor] = useState<Order | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [descsByOrder, setDescsByOrder] = useState<Record<string, (string | null)[]>>({})
  const [expandedId, setExpandedId] = useState('')   // order whose lines are shown inline
  const [expLines, setExpLines] = useState<Line[]>([])
  const [doByOrder, setDoByOrder] = useState<Record<string, string[]>>({})   // order_id -> DO number(s) once dispatched

  useEffect(() => { const s = new URLSearchParams(window.location.search).get('status'); if (s) setStatusFilter(s) }, [])
  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const { data } = await supabase.from('wms_orders')
      .select('*, wms_order_lines(count)').order('created_at', { ascending: false }).limit(100)
    const list = (data as Order[]) || []
    setOrders(list)
    // Item descriptions per order, so the GCH / Other warehouse filter can match on lines.
    const ids = list.map(o => o.id)
    if (ids.length) {
      const { data: ol } = await supabase.from('wms_order_lines').select('order_id, description').in('order_id', ids)
      const m: Record<string, (string | null)[]> = {}
      ;(ol as { order_id: string; description: string | null }[] || []).forEach(l => { (m[l.order_id] ||= []).push(l.description) })
      setDescsByOrder(m)
    } else setDescsByOrder({})
    const { data: pk } = await supabase.rpc('wms_pickers')
    setPickers((pk as Picker[]) || [])
    // DO number(s) for orders that have been dispatched.
    const { data: dsp } = await supabase.from('wms_dispatches').select('order_id, do_number')
    const dm: Record<string, string[]> = {}
    ;(dsp as { order_id: string | null; do_number: string | null }[] || []).forEach(x => { if (x.order_id && x.do_number) (dm[x.order_id] = dm[x.order_id] || []).push(x.do_number) })
    setDoByOrder(dm)
  }
  // Toggle showing an order's item lines right in the table (no download).
  async function toggleLines(o: Order) {
    if (expandedId === o.id) { setExpandedId(''); return }
    setExpandedId(o.id)
    const { data } = await supabase.from('wms_order_lines').select('*').eq('order_id', o.id).order('line_no')
    setExpLines((data as Line[]) || [])
  }

  const needsPickerDb = (m: string) => /wms_assign_order|wms_pickers|wms_set_picker|wms_users_for_picker|warehouse_picker|assigned_to|function|column/i.test(m) && /does not exist|schema cache|could not find/i.test(m)
    ? 'This needs a database update — run db/2026-07-wms-pickers.sql in the Supabase SQL editor.' : m
  async function assign(o: Order, userId: string) {
    if (!canEdit) return
    setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_assign_order', { p_order_id: o.id, p_user_id: userId || null })
    if (error) { setErr(needsPickerDb(error.message)); return }
    load()
  }
  async function openManage() {
    setShowPickers(true); setManageQ(''); setErr('')
    const { data, error } = await supabase.rpc('wms_users_for_picker')
    if (error) { setErr(needsPickerDb(error.message)); return }
    setManageUsers((data as PickerUser[]) || [])
  }
  async function togglePicker(u: PickerUser) {
    const { error } = await supabase.rpc('wms_set_picker', { p_user_id: u.id, p_on: !u.is_picker })
    if (error) { setErr(needsPickerDb(error.message)); return }
    setManageUsers(us => us.map(x => x.id === u.id ? { ...x, is_picker: !x.is_picker } : x))
    load()
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !profile) return
    if (file.type !== 'application/pdf') { setErr('Please choose a PDF file.'); return }
    setUploading(true); setErr(''); setMsg('')
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `8BT/${Date.now()}-${safe}`
    const up = await supabase.storage.from('wms-orders').upload(path, file)
    if (up.error) { setErr(`Upload failed: ${up.error.message}`); setUploading(false); return }
    const { data: inserted, error: insErr } = await supabase.from('wms_orders')
      .insert({ file_name: file.name, file_path: path, status: 'Processing', source: 'pdf', uploaded_by: profile.id, uploaded_by_name: profile.full_name })
      .select().single()
    if (insErr || !inserted) { setErr(`Saving record failed: ${insErr?.message}`); setUploading(false); return }
    setMsg(`Uploaded "${file.name}". Reading it with Claude…`)
    setFile(null); if (fileRef.current) fileRef.current.value = ''
    setUploading(false); load()
    try {
      const res = await apiFetch('/api/wms/extract-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: inserted.id, filePath: path }),
      })
      const r = await res.json()
      if (!res.ok) { setErr(`Reading failed: ${r.error || 'Unknown error'}`); setMsg('') }
      else { setMsg(`Read ${r.count} line(s) from "${inserted.file_name}". Please review.`); load(); viewLines({ ...inserted, status: 'Review' } as Order) }
    } catch { setErr('Could not reach the reading service.'); setMsg('') }
  }

  async function reRead(o: Order) {
    if (!o.file_path) return
    await supabase.from('wms_orders').update({ status: 'Processing' }).eq('id', o.id); load()
    try {
      const res = await apiFetch('/api/wms/extract-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: o.id, filePath: o.file_path }),
      })
      const r = await res.json()
      if (!res.ok) setErr(`Reading failed: ${r.error || 'Unknown error'}`); else setMsg(`Re-read ${r.count} line(s).`)
      load()
    } catch { setErr('Could not reach the reading service.') }
  }

  async function viewLines(o: Order) {
    setLinesFor(o)
    const { data } = await supabase.from('wms_order_lines').select('*').eq('order_id', o.id).order('line_no')
    setLines((data as Line[]) || [])
  }

  async function viewPdf(o: Order) {
    if (!o.file_path) return
    const { data } = await supabase.storage.from('wms-orders').createSignedUrl(o.file_path, 60)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  async function release(o: Order) {
    if (!canEdit) return
    setErr(''); setMsg('')
    const { data, error } = await supabase.rpc('wms_reserve_order', { p_order_id: o.id })
    if (error) { setErr(error.message); return }
    const r = data as { reserved: number; shortfall: number }
    setMsg(r.shortfall > 0 ? `Released & reserved ${r.reserved} — short ${r.shortfall} (not enough free stock).` : `Released & reserved stock for ${o.order_no || 'order'}.`)
    load()
  }
  async function cancelOrder(o: Order) {
    if (!canEdit || !confirm(`Cancel ${o.order_no || 'this order'} and release its reserved stock?`)) return
    const { error } = await supabase.rpc('wms_cancel_order', { p_order_id: o.id })
    if (error) { setErr(error.message); return }
    load()
  }

  async function del(o: Order) {
    if (!confirm(`Delete order "${o.file_name || o.order_no}" and its lines?`)) return
    if (o.file_path) await supabase.storage.from('wms-orders').remove([o.file_path])
    await supabase.from('wms_orders').delete().eq('id', o.id)
    if (linesFor?.id === o.id) setLinesFor(null)
    load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  const unmatched = lines.filter(l => !l.item_id).length
  const shownOrders = (statusFilter ? orders.filter(o => o.status === statusFilter) : orders).filter(o => passWh(wh, descsByOrder[o.id]))

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">Orders to Pick</h1>
          {canEdit && <button onClick={openManage} className="text-sm border rounded-lg px-3 py-1.5 hover:bg-gray-50 font-medium">👤 Manage pickers</button>}
        </div>
        <p className="text-gray-500 text-sm mt-1 mb-6">Upload a customer order PDF — the app reads the lines, you review, then it becomes a pick job. (Later these same orders can arrive straight from SQL Account.)</p>

        {canEdit && (
          <form onSubmit={handleUpload} className="bg-white rounded-xl shadow-sm border p-5 mb-6 flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] || null)}
              className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-700 file:text-white file:px-4 file:py-2 file:font-medium" />
            <button type="submit" disabled={!file || uploading}
              className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">
              {uploading ? 'Uploading…' : 'Upload order PDF'}
            </button>
          </form>
        )}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">{msg}</p>}

        <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
          <span className="text-gray-500">Status:</span>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-1.5">
            <option value="">All</option>
            {Array.from(new Set(orders.map(o => o.status))).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {statusFilter && <button onClick={() => setStatusFilter('')} className="text-emerald-700 hover:underline text-xs">clear</button>}
          <div className="w-full sm:w-auto sm:ml-auto"><WarehouseTabs value={wh} onChange={setWh} /></div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['File', 'Order No', 'Customer', 'Delivery', 'Lines', 'Status', 'Picker', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {shownOrders.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No orders{statusFilter ? ` with status “${statusFilter}”` : ''}{wh !== 'all' ? ' in this warehouse' : (statusFilter ? '' : ' yet — upload a PDF to start')}.</td></tr>}
              {shownOrders.map(o => (
                <Fragment key={o.id}>
                <tr className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 max-w-[200px] truncate" title={o.file_name || ''}>{o.file_name}</td>
                  <td className="px-4 py-2.5 font-mono">{o.order_no || <span className="text-gray-300">—</span>}{doByOrder[o.id]?.length ? <span className="block text-[10px] text-emerald-700 font-medium" title="Dispatched on this DO">DO {doByOrder[o.id].join(', ')}</span> : null}</td>
                  <td className="px-4 py-2.5">{o.customer_name || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{o.delivery_date || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 tabular-nums">{o.wms_order_lines?.[0]?.count ?? 0}</td>
                  <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[o.status] || 'bg-gray-100'}`}>{o.status}</span></td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {canEdit
                      ? <select value={o.assigned_to || ''} onChange={e => assign(o, e.target.value)} className="border rounded px-1.5 py-1 text-xs max-w-[140px]">
                          <option value="">— unassigned —</option>
                          {o.assigned_to && !pickers.some(p => p.id === o.assigned_to) && <option value={o.assigned_to}>{o.assigned_to_name || 'assigned'}</option>}
                          {pickers.map(p => <option key={p.id} value={p.id}>{p.full_name || p.id.slice(0, 6)}</option>)}
                        </select>
                      : <span className="text-xs text-gray-600">{o.assigned_to_name || '—'}</span>}
                    {pickDur(o) && <div className="text-[10px] text-gray-400 mt-0.5">{pickDur(o)}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(o.created_at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex gap-3 text-xs">
                      {canEdit && o.status === 'Review' && <button onClick={() => release(o)} className="text-teal-700 font-medium hover:underline">Release</button>}
                      {['Reserved', 'Released', 'Picking'].includes(o.status) &&
                        <Link href={`/wms/pick/${o.id}`} className="text-emerald-700 font-medium hover:underline">Pick →</Link>}
                      {o.status === 'Picked' && <Link href={`/wms/pick/${o.id}`} className="text-teal-700 font-medium hover:underline">Check →</Link>}
                      {['Checked', 'Partially Dispatched'].includes(o.status) && <Link href={`/wms/dispatch/${o.id}`} className="text-emerald-700 font-medium hover:underline">Dispatch →</Link>}
                      <button onClick={() => toggleLines(o)} className="text-emerald-700 hover:underline">{expandedId === o.id ? 'Hide lines' : 'View lines'}</button>
                      {o.file_path && <button onClick={() => viewPdf(o)} className="text-gray-500 hover:underline">PDF</button>}
                      {canEdit && ['Reserved', 'Released', 'Picking'].includes(o.status) && <button onClick={() => cancelOrder(o)} className="text-amber-600 hover:underline">Cancel</button>}
                      {canEdit && o.file_path && <button onClick={() => reRead(o)} className="text-gray-500 hover:underline">Re-read</button>}
                      {canEdit && <button onClick={() => del(o)} className="text-red-500 hover:underline">Delete</button>}
                    </div>
                  </td>
                </tr>
                {expandedId === o.id && (
                  <tr className="bg-gray-50 border-b">
                    <td colSpan={9} className="px-6 py-3">
                      <div className="text-xs font-medium text-gray-500 mb-1">Items in {o.order_no || o.file_name}</div>
                      {expLines.length === 0 ? <div className="text-xs text-gray-400">No lines.</div> : (
                        <table className="w-full text-sm max-w-3xl">
                          <thead className="text-xs text-gray-500"><tr><th className="text-left py-1 font-medium">Item</th><th className="text-left py-1 font-medium">Description</th><th className="text-right py-1 font-medium">Qty</th></tr></thead>
                          <tbody>
                            {expLines.map(l => (
                              <tr key={l.id} className="border-t"><td className="py-1 font-mono whitespace-nowrap">{l.item_code}</td><td className="py-1 text-gray-500">{l.description}</td><td className="py-1 text-right tabular-nums whitespace-nowrap">{l.quantity}{l.uom ? ' ' + l.uom : ''}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showPickers && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowPickers(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h2 className="font-bold text-lg mb-1">Pickers</h2>
            <p className="text-sm text-gray-500 mb-3">Tick the staff who pick — only ticked people appear in the “assign picker” dropdown.</p>
            <input value={manageQ} onChange={e => setManageQ(e.target.value)} placeholder="Search staff…" className="border rounded-lg px-3 py-2 text-sm w-full mb-2" />
            <div className="max-h-72 overflow-auto divide-y border rounded-lg">
              {manageUsers.length === 0 && <p className="text-sm text-gray-400 px-3 py-4 text-center">No staff found.</p>}
              {manageUsers.filter(u => { const n = manageQ.trim().toLowerCase(); return !n || (u.full_name || '').toLowerCase().includes(n) }).map(u => (
                <label key={u.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50">
                  <input type="checkbox" checked={u.is_picker} onChange={() => togglePicker(u)} className="w-4 h-4" />
                  <span className="text-sm">{u.full_name || u.id.slice(0, 8)}</span>
                  {u.is_picker && <span className="ml-auto text-[10px] text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">picker</span>}
                </label>
              ))}
            </div>
            <div className="mt-4 text-right"><button onClick={() => setShowPickers(false)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Done</button></div>
          </div>
        </div>
      )}

      {linesFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLinesFor(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h2 className="font-semibold text-lg">{linesFor.order_no || linesFor.file_name} <span className="text-gray-400 font-normal text-sm">· {linesFor.customer_name || 'customer ?'}</span></h2>
              <button onClick={() => setLinesFor(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            {(linesFor.order_date || linesFor.delivery_date) && <p className="text-xs text-gray-500 mb-3">SO date {linesFor.order_date || '—'} · Delivery {linesFor.delivery_date || '—'}</p>}
            {linesFor.error_message && <p className="text-red-600 text-sm bg-red-50 p-2 rounded mb-3">{linesFor.error_message}</p>}
            {unmatched > 0 && <p className="text-amber-600 text-xs bg-amber-50 border border-amber-200 rounded p-2 mb-3">⚠ {unmatched} line(s) have an item code not found in the Items master — check the codes before picking.</p>}
            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b"><tr>{['#', 'Item', 'Description', 'Qty', 'Unit', 'SQL loc', 'Remarks'].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600">{h}</th>)}</tr></thead>
                <tbody>
                  {lines.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-gray-400">No lines read.</td></tr>}
                  {lines.map(l => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-gray-400">{l.line_no}</td>
                      <td className="px-3 py-2 font-mono font-medium">{l.item_code}{!l.item_id && <span className="ml-1 text-amber-600" title="Not in Items master">⚠</span>}</td>
                      <td className="px-3 py-2 text-gray-600 max-w-[220px] truncate">{l.description}</td>
                      <td className="px-3 py-2 font-medium tabular-nums">{fmtQty(l.quantity)}</td>
                      <td className="px-3 py-2 text-gray-500">{l.uom}</td>
                      <td className="px-3 py-2 text-gray-500 text-xs font-mono">{l.source_hint || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-gray-500 text-xs">{l.remarks || <span className="text-gray-300">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-400 mt-3">Directed picking (choosing bins, booking stock out) is the next step — this screen confirms what the order needs.</p>
          </div>
        </div>
      )}
    </div>
  )
}
