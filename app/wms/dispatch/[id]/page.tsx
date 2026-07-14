'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

interface Order { id: string; order_no: string | null; customer_name: string | null; status: string; delivery_date: string | null }
interface OLine { id: string; item_code: string; description: string | null; uom: string | null; item_id: string | null }
interface Move { item_code: string; batch_no: string; exp_date: string | null; quantity: number }
interface Draft { order_line_id: string | null; item_id: string | null; item_code: string; description: string | null; batch_no: string; exp_date: string | null; uom: string | null; staged: number; qty: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''

export default function WmsDispatchPage() {
  const { id } = useParams<{ id: string }>()
  const { profile, loading } = useProfile()
  const router = useRouter()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [order, setOrder] = useState<Order | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [vehicle, setVehicle] = useState(''); const [driver, setDriver] = useState(''); const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const { data: o } = await supabase.from('wms_orders').select('id, order_no, customer_name, status, delivery_date').eq('id', id).single()
    const ord = o as Order | null
    const { data: ols } = await supabase.from('wms_order_lines').select('id, item_code, description, uom, item_id').eq('order_id', id)
    const byItem = new Map((ols as OLine[] || []).map(l => [l.item_code.toUpperCase(), l]))
    // What was picked (staged) for this order = its 'pick' moves into DISPATCH, by item+batch.
    const { data: mv } = await supabase.from('wms_stock_moves').select('item_code, batch_no, exp_date, quantity')
      .eq('move_type', 'pick').eq('to_location_code', 'DISPATCH').eq('reference', ord?.order_no || '___none___')
    const grouped = new Map<string, Move>()
    for (const m of (mv as Move[] || [])) {
      const k = `${m.item_code.toUpperCase()}|${m.batch_no}`
      const g = grouped.get(k)
      if (g) g.quantity = clean(g.quantity + Number(m.quantity))
      else grouped.set(k, { ...m, quantity: Number(m.quantity) })
    }
    const ds: Draft[] = [...grouped.values()].map(m => {
      const ol = byItem.get(m.item_code.toUpperCase())
      return { order_line_id: ol?.id ?? null, item_id: ol?.item_id ?? null, item_code: m.item_code, description: ol?.description ?? null, batch_no: m.batch_no, exp_date: m.exp_date, uom: ol?.uom ?? null, staged: m.quantity, qty: String(clean(m.quantity)) }
    }).sort((a, b) => a.item_code.localeCompare(b.item_code))
    setOrder(ord); setDrafts(ds)
  }, [id])
  useEffect(() => { if (profile) load() }, [profile, load])

  const setQty = (i: number, v: string) => setDrafts(ds => ds.map((d, x) => x === i ? { ...d, qty: v.replace(/[^0-9.]/g, '') } : d))

  async function generatePdf(doNo: string) {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS SDN BHD', 14, 16)
    doc.setFontSize(12); doc.text('DELIVERY ORDER', 14, 24)
    doc.setFontSize(10); doc.setFont('helvetica', 'normal')
    doc.text(`DO No: ${doNo}`, 14, 32); doc.text(`Order: ${order?.order_no || '-'}`, 14, 38)
    doc.text(`Customer: ${order?.customer_name || '-'}`, 14, 44)
    doc.text(`Date: ${new Date().toLocaleDateString('en-GB')}`, 150, 32)
    if (vehicle) doc.text(`Vehicle: ${vehicle}`, 150, 38); if (driver) doc.text(`Driver: ${driver}`, 150, 44)
    const body = drafts.filter(d => Number(d.qty) > 0).map((d, i) => [String(i + 1), d.item_code, d.description || '', d.batch_no || '', fmtDate(d.exp_date), fmtQty(Number(d.qty)), d.uom || ''])
    autoTable(doc, { startY: 50, head: [['#', 'Item Code', 'Description', 'Batch', 'Exp', 'Qty', 'Unit']], body, styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: [4, 120, 87] }, columnStyles: { 5: { halign: 'right' } } })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 16
    if (remark) doc.text(`Remark: ${remark}`, 14, endY - 6)
    doc.text('Issued by: _______________', 14, endY + 6); doc.text('Received by: _______________   Date: ________', 90, endY + 6)
    doc.save(`DO_${doNo}.pdf`)
  }

  async function dispatch() {
    if (!canEdit) return
    const lines = drafts.filter(d => Number(d.qty) > 0).map(d => ({ order_line_id: d.order_line_id, item_id: d.item_id, item_code: d.item_code, description: d.description, batch_no: d.batch_no, exp_date: d.exp_date, qty: Number(d.qty), uom: d.uom }))
    if (!lines.length) { setErr('Nothing to dispatch.'); return }
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('wms_dispatch_order', { p_order_id: id, p_vehicle: vehicle, p_driver: driver, p_remark: remark, p_lines: lines })
    if (error) { setErr(error.message); setBusy(false); return }
    await generatePdf((data as { do_number: string }).do_number)
    setBusy(false)
    router.push('/wms/dispatch')
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!order) return <div className="p-8 text-sm text-gray-500">Order not found. <Link href="/wms/orders" className="text-emerald-700 underline">Back</Link></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/wms/orders" className="text-sm text-emerald-700 hover:underline">← Orders to Pick</Link>
        <h1 className="text-2xl font-bold mt-2 mb-1">Dispatch {order.order_no || '(no number)'}</h1>
        <p className="text-gray-500 text-sm mb-5">{order.customer_name || 'Customer ?'}{order.delivery_date ? ` · deliver ${order.delivery_date}` : ''} · confirm what physically ships, then print the Delivery Order.</p>

        {order.status === 'Dispatched' && <p className="text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg p-3 mb-4">This order is already dispatched. Dispatching again creates another DO.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Item', 'Batch', 'Exp', 'Picked', 'Ship qty', 'Unit'].map(h => <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-600">{h}</th>)}</tr></thead>
            <tbody>
              {drafts.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">Nothing picked for this order yet.</td></tr>}
              {drafts.map((d, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-4 py-2.5"><span className="font-mono font-medium">{d.item_code}</span> <span className="text-gray-400 text-xs">{d.description}</span></td>
                  <td className="px-4 py-2.5 font-mono text-xs">{d.batch_no || '—'}</td>
                  <td className="px-4 py-2.5 text-xs">{fmtDate(d.exp_date) || '—'}</td>
                  <td className="px-4 py-2.5 tabular-nums text-gray-500">{fmtQty(d.staged)}</td>
                  <td className="px-4 py-2.5"><input value={d.qty} onChange={e => setQty(i, e.target.value)} className="w-24 border rounded-lg px-2 py-1 text-sm text-right tabular-nums" inputMode="decimal" /></td>
                  <td className="px-4 py-2.5 text-gray-500">{d.uom}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div><label className="block text-xs text-gray-500 mb-1">Vehicle <span className="text-gray-400">(optional)</span></label><input value={vehicle} onChange={e => setVehicle(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
          <div><label className="block text-xs text-gray-500 mb-1">Driver <span className="text-gray-400">(optional)</span></label><input value={driver} onChange={e => setDriver(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
          <div><label className="block text-xs text-gray-500 mb-1">Remark <span className="text-gray-400">(optional)</span></label><input value={remark} onChange={e => setRemark(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
        </div>

        {canEdit && <button onClick={dispatch} disabled={busy || drafts.length === 0} className="bg-emerald-700 text-white px-6 py-2.5 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">{busy ? 'Dispatching…' : 'Dispatch & print Delivery Order'}</button>}
      </div>
    </div>
  )
}
