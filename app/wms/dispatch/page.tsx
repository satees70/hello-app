'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'
import { openWmsDiscussion } from '@/components/WmsDiscussionWidget'

interface DO { id: string; order_id: string | null; do_number: string | null; customer_name: string | null; order_no: string | null; vehicle: string | null; driver: string | null; remark: string | null; dispatched_by_name: string | null; dispatched_at: string; load_checked_at: string | null; load_checked_by_name: string | null }
interface DLine { item_code: string; description: string | null; batch_no: string; exp_date: string | null; qty: number; uom: string | null }
interface Ord { id: string; order_no: string | null; customer_name: string | null; status: string; delivery_date: string | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()

export default function WmsDispatchListPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [rows, setRows] = useState<DO[]>([]); const [q, setQ] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [descsByDo, setDescsByDo] = useState<Record<string, (string | null)[]>>({})
  const [ready, setReady] = useState<Ord[]>([]); const [holding, setHolding] = useState(0)
  const [prodOrders, setProdOrders] = useState<Set<string>>(new Set())   // order_ids that are production
  const [loadCheckFor, setLoadCheckFor] = useState<DO | null>(null); const [loadNote, setLoadNote] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [{ data }, { data: ord }, { data: hold }] = await Promise.all([
      supabase.from('wms_dispatches').select('*').order('dispatched_at', { ascending: false }).limit(200),
      supabase.from('wms_orders').select('id, order_no, customer_name, status, delivery_date').in('status', ['Checked', 'Partially Dispatched']).order('created_at', { ascending: false }).limit(50),
      supabase.from('wms_stock').select('quantity').eq('location_code', 'DISPATCH'),
    ])
    const dos = (data as DO[]) || []
    setRows(dos)
    // Item descriptions per DO, so the GCH / Other warehouse filter can match on lines.
    const dids = dos.map(d => d.id)
    if (dids.length) {
      const { data: dl } = await supabase.from('wms_dispatch_lines').select('dispatch_id, description').in('dispatch_id', dids)
      const m: Record<string, (string | null)[]> = {}
      ;(dl as { dispatch_id: string; description: string | null }[] || []).forEach(l => { (m[l.dispatch_id] ||= []).push(l.description) })
      setDescsByDo(m)
    } else setDescsByDo({})
    setReady((ord as Ord[]) || [])
    setHolding(clean(((hold as { quantity: number }[]) || []).reduce((s, r) => s + Number(r.quantity || 0), 0)))
    // Which of these DOs belong to production orders (they skip the customer loading check).
    const oids = [...new Set(dos.map(d => d.order_id).filter(Boolean) as string[])]
    if (oids.length) {
      const { data: os } = await supabase.from('wms_orders').select('id, source').in('id', oids).eq('source', 'production')
      setProdOrders(new Set((os as { id: string }[] || []).map(o => o.id)))
    } else setProdOrders(new Set())
  }

  async function doLoadCheck() {
    if (!loadCheckFor) return
    setBusy(true); setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_load_check', { p_dispatch_id: loadCheckFor.id, p_note: loadNote || null })
    setBusy(false)
    if (error) { setErr(/wms_load_check|load_checked|function|column/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-check-stage-b.sql in Supabase.' : error.message); return }
    setMsg(`Loading check recorded for ${loadCheckFor.do_number}.`); setLoadCheckFor(null); setLoadNote(''); load()
  }
  const dispatchedToday = useMemo(() => rows.filter(r => isToday(r.dispatched_at)).length, [rows])

  async function reprint(d: DO) {
    const { data: ls } = await supabase.from('wms_dispatch_lines').select('item_code, description, batch_no, exp_date, qty, uom').eq('dispatch_id', d.id)
    const lines = (ls as DLine[]) || []
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS SDN BHD', 14, 16)
    doc.setFontSize(12); doc.text('DELIVERY ORDER', 14, 24)
    doc.setFontSize(10); doc.setFont('helvetica', 'normal')
    doc.text(`DO No: ${d.do_number}`, 14, 32); doc.text(`Order: ${d.order_no || '-'}`, 14, 38); doc.text(`Customer: ${d.customer_name || '-'}`, 14, 44)
    doc.text(`Date: ${new Date(d.dispatched_at).toLocaleDateString('en-GB')}`, 150, 32)
    if (d.vehicle) doc.text(`Vehicle: ${d.vehicle}`, 150, 38); if (d.driver) doc.text(`Driver: ${d.driver}`, 150, 44)
    autoTable(doc, { startY: 50, head: [['#', 'Item Code', 'Description', 'Batch', 'Exp', 'Qty', 'Unit']], body: lines.map((l, i) => [String(i + 1), l.item_code, l.description || '', l.batch_no || '', fmtDate(l.exp_date), fmtQty(Number(l.qty)), l.uom || '']), styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: [4, 120, 87] }, columnStyles: { 5: { halign: 'right' } } })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 16
    if (d.remark) doc.text(`Remark: ${d.remark}`, 14, endY - 6)
    doc.text('Issued by: _______________', 14, endY + 6); doc.text('Received by: _______________   Date: ________', 90, endY + 6)
    doc.save(`DO_${d.do_number}.pdf`)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  const filtered = rows.filter(d => passWh(wh, descsByDo[d.id])).filter(d => { const n = q.trim().toLowerCase(); return !n || [d.do_number, d.customer_name, d.order_no].some(v => (v || '').toLowerCase().includes(n)) })

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Dispatch</h1>
        <p className="text-gray-500 text-sm mt-1 mb-5">What’s ready to ship, what’s in the holding bin, and every Delivery Order.</p>

        {err && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}
        {msg && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {msg}</div>}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-emerald-600 tabular-nums">{ready.length}</div><div className="text-xs text-gray-500 mt-0.5">Ready to dispatch</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-amber-600 tabular-nums">{fmtQty(holding)}</div><div className="text-xs text-gray-500 mt-0.5">Qty in holding</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-emerald-700 tabular-nums">{dispatchedToday}</div><div className="text-xs text-gray-500 mt-0.5">Dispatched today</div></div>
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-gray-500 tabular-nums">{rows.length}</div><div className="text-xs text-gray-500 mt-0.5">Delivery Orders</div></div>
        </div>

        {ready.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden mb-6">
            <div className="px-4 py-2.5 border-b bg-gray-50 text-sm font-semibold text-gray-700">Ready to dispatch</div>
            {ready.map(o => (
              <Link key={o.id} href={`/wms/dispatch/${o.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-gray-50 border-b last:border-0">
                <div className="min-w-0"><span className="font-mono text-sm font-medium">{o.order_no || '(no number)'}</span> <span className="text-xs text-gray-500 truncate">{o.customer_name || '—'}{o.delivery_date ? ` · deliver ${o.delivery_date}` : ''}</span></div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${o.status === 'Partially Dispatched' ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-100 text-emerald-700'}`}>{o.status}</span>
              </Link>
            ))}
          </div>
        )}

        <h2 className="text-sm font-semibold text-gray-700 mb-2">Delivery Orders</h2>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search DO / customer / order…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          <WarehouseTabs value={wh} onChange={setWh} />
        </div>
        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['DO No', 'Customer', 'Order', 'Vehicle', 'Dispatched', 'By', ''].map(h => <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-gray-400">No dispatches yet.</td></tr>}
              {filtered.map(d => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono font-medium">{d.do_number}</td>
                  <td className="px-4 py-2.5">{d.customer_name}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{d.order_no || '—'}</td>
                  <td className="px-4 py-2.5 text-xs">{d.vehicle || '—'}{d.driver ? ` · ${d.driver}` : ''}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(d.dispatched_at)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{d.dispatched_by_name}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <button onClick={() => reprint(d)} className="text-emerald-700 hover:underline text-xs font-medium">⬇ DO PDF</button>
                      <button onClick={() => openWmsDiscussion(`DO ${d.do_number || d.id.slice(0, 8)}`)} title="Ask a question about this delivery order" className="text-indigo-600 hover:underline text-xs font-medium">💬 Discuss</button>
                      {!(d.order_id && prodOrders.has(d.order_id)) && (
                        d.load_checked_at
                          ? <span className="text-teal-700 text-xs" title={`Loading checked by ${d.load_checked_by_name || 'staff'}`}>✓ Loaded</span>
                          : canEdit && <button onClick={() => { setLoadCheckFor(d); setLoadNote(''); setErr('') }} className="text-teal-700 hover:underline text-xs font-medium">Loading check</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per Delivery Order */}
        <div className="sm:hidden space-y-2">
          {filtered.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No dispatches yet.</div>}
          {filtered.map(d => (
            <div key={d.id} className="bg-white rounded-xl border shadow-sm p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-semibold text-sm">{d.do_number}</div>
                  <div className="text-xs text-gray-500 leading-snug">{d.customer_name}</div>
                </div>
                <div className="text-right shrink-0 text-xs text-gray-500 whitespace-nowrap">{fmtTime(d.dispatched_at)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
                <span>Order: <span className="font-mono">{d.order_no || '—'}</span></span>
                <span>Vehicle: {d.vehicle || '—'}{d.driver ? ` · ${d.driver}` : ''}</span>
                {d.dispatched_by_name && <span>By: {d.dispatched_by_name}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2.5 pt-2 border-t text-xs">
                <button onClick={() => reprint(d)} className="text-emerald-700 hover:underline font-medium">⬇ DO PDF</button>
                <button onClick={() => openWmsDiscussion(`DO ${d.do_number || d.id.slice(0, 8)}`)} title="Ask a question about this delivery order" className="text-indigo-600 hover:underline font-medium">💬 Discuss</button>
                {!(d.order_id && prodOrders.has(d.order_id)) && (
                  d.load_checked_at
                    ? <span className="text-teal-700" title={`Loading checked by ${d.load_checked_by_name || 'staff'}`}>✓ Loaded</span>
                    : canEdit && <button onClick={() => { setLoadCheckFor(d); setLoadNote(''); setErr('') }} className="text-teal-700 hover:underline font-medium">Loading check</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {loadCheckFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setLoadCheckFor(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h2 className="font-bold text-lg mb-1">Loading check — {loadCheckFor.do_number}</h2>
            <p className="text-sm text-gray-500 mb-3">A second person confirms the loaded items match this Delivery Order / invoice. The person who checked the pick can’t also do the loading check.</p>
            <label className="block text-xs text-gray-500 mb-1">Note <span className="text-gray-400">(optional)</span></label>
            <input value={loadNote} onChange={e => setLoadNote(e.target.value)} placeholder="e.g. all items tallied to invoice" className="w-full border rounded-lg px-3 py-2 text-sm mb-4" />
            <div className="flex gap-3">
              <button onClick={doLoadCheck} disabled={busy} className="bg-teal-700 text-white px-5 py-2 rounded-lg hover:bg-teal-800 disabled:opacity-50 text-sm font-medium">{busy ? 'Saving…' : 'Confirm loading check'}</button>
              <button onClick={() => !busy && setLoadCheckFor(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
