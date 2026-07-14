'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

interface DO { id: string; do_number: string | null; customer_name: string | null; order_no: string | null; vehicle: string | null; driver: string | null; remark: string | null; dispatched_by_name: string | null; dispatched_at: string }
interface DLine { item_code: string; description: string | null; batch_no: string; exp_date: string | null; qty: number; uom: string | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function WmsDispatchListPage() {
  const { profile, loading } = useProfile()
  const [rows, setRows] = useState<DO[]>([]); const [q, setQ] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const { data } = await supabase.from('wms_dispatches').select('*').order('dispatched_at', { ascending: false }).limit(200)
    setRows((data as DO[]) || [])
  }

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
  const filtered = rows.filter(d => { const n = q.trim().toLowerCase(); return !n || [d.do_number, d.customer_name, d.order_no].some(v => (v || '').toLowerCase().includes(n)) })

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Delivery Orders</h1>
        <p className="text-gray-500 text-sm mt-1 mb-5">Dispatched orders. Reprint any Delivery Order here.</p>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search DO / customer / order…" className="border rounded-lg px-3 py-2 text-sm w-full mb-4" />
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
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
                  <td className="px-4 py-2.5"><button onClick={() => reprint(d)} className="text-emerald-700 hover:underline text-xs font-medium">⬇ DO PDF</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
