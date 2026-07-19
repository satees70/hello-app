'use client'
import { useCallback, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { downloadCsv } from '@/lib/csv'

// Batch recall / trace: enter a batch number and see everywhere that batch went — received,
// put away, picked, dispatched — plus where it still is now. For a food recall.
interface Move { move_type: string; item_code: string; description: string | null; from_location_code: string | null; to_location_code: string | null; batch_no: string; quantity: number; reference: string | null; moved_by_name: string | null; created_at: string }
interface OnHand { item_code: string; location_code: string; batch_no: string; quantity: number; exp_date: string | null }
// One dispatched line that carried this batch out to a customer. Resolved via a real join
// wms_dispatch_lines → wms_dispatches (not by parsing the movement reference text).
interface RecvLine { item_code: string; batch_no: string; qty: number; do_number: string | null; customer_name: string | null; order_no: string | null; dispatched_at: string }

const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const MOVE_LABEL: Record<string, string> = { receipt: '📥 Received', putaway: '📦 Put away', transfer: '↔ Moved', pick: '🛒 Picked', dispatch: '🚚 Dispatched', adjust: '✏ Adjusted' }

export default function BatchRecallPage() {
  const { profile, loading } = useProfile()
  const [batch, setBatch] = useState('')
  const [item, setItem] = useState('')
  const [moves, setMoves] = useState<Move[] | null>(null)
  const [onhand, setOnhand] = useState<OnHand[]>([])
  const [recv, setRecv] = useState<RecvLine[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const search = useCallback(async () => {
    const b = batch.trim()
    if (!b) { setErr('Enter a batch number.'); return }
    setBusy(true); setErr(''); setMoves(null); setRecv([])
    let mq = supabase.from('wms_stock_moves').select('move_type, item_code, description, from_location_code, to_location_code, batch_no, quantity, reference, moved_by_name, created_at').ilike('batch_no', `%${b}%`).order('created_at', { ascending: true }).limit(1000)
    if (item.trim()) mq = mq.ilike('item_code', `%${item.trim()}%`)
    let sq = supabase.from('wms_stock').select('item_code, location_code, batch_no, quantity, exp_date').ilike('batch_no', `%${b}%`).gt('quantity', 0)
    if (item.trim()) sq = sq.ilike('item_code', `%${item.trim()}%`)
    // Who actually received this batch: join dispatched lines to their delivery order (which carries the customer).
    let dq = supabase.from('wms_dispatch_lines').select('item_code, batch_no, qty, wms_dispatches!inner(do_number, customer_name, order_no, dispatched_at, status)').ilike('batch_no', `%${b}%`).eq('wms_dispatches.status', 'Dispatched')
    if (item.trim()) dq = dq.ilike('item_code', `%${item.trim()}%`)
    const [{ data: m, error: me }, { data: s }, { data: d }] = await Promise.all([mq, sq, dq])
    setBusy(false)
    if (me) { setErr(me.message); return }
    setMoves((m as Move[]) || [])
    setOnhand((s as OnHand[]) || [])
    // Flatten the embedded delivery-order object onto each line.
    setRecv(((d as unknown as { item_code: string; batch_no: string; qty: number; wms_dispatches: { do_number: string | null; customer_name: string | null; order_no: string | null; dispatched_at: string } }[]) || []).map(r => ({
      item_code: r.item_code, batch_no: r.batch_no, qty: r.qty,
      do_number: r.wms_dispatches?.do_number ?? null, customer_name: r.wms_dispatches?.customer_name ?? null,
      order_no: r.wms_dispatches?.order_no ?? null, dispatched_at: r.wms_dispatches?.dispatched_at,
    })))
  }, [batch, item])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!profile) return null

  const refs = moves ? [...new Set(moves.map(m => m.reference).filter(Boolean))] as string[] : []

  // Roll dispatched lines up into one row per customer + delivery order.
  const custMap = new Map<string, { customer_name: string; do_number: string; order_no: string; qty: number; last_date: string }>()
  let unresolvedLineQty = 0
  for (const r of recv) {
    const cust = (r.customer_name || '').trim()
    const q = Number(r.qty) || 0
    if (!cust) { unresolvedLineQty += q; continue }
    const key = cust + '||' + (r.do_number || '')
    const ex = custMap.get(key)
    if (ex) { ex.qty += q; if (r.dispatched_at > ex.last_date) ex.last_date = r.dispatched_at }
    else custMap.set(key, { customer_name: cust, do_number: r.do_number || '', order_no: r.order_no || '', qty: q, last_date: r.dispatched_at })
  }
  const custRows = [...custMap.values()].sort((a, b) => (b.last_date || '').localeCompare(a.last_date || ''))
  // Anything that left the building (a 'dispatch' move) but isn't covered by a resolved dispatch line
  // must still be surfaced so nothing is silently dropped from a recall.
  const dispatchMoveQty = moves ? moves.filter(m => m.move_type === 'dispatch').reduce((a, m) => a + (Number(m.quantity) || 0), 0) : 0
  const sumLineQty = recv.reduce((a, r) => a + (Number(r.qty) || 0), 0)
  const unresolvedQty = unresolvedLineQty + Math.max(0, dispatchMoveQty - sumLineQty)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Batch recall / trace</h1>
          <Link href="/wms/reports" className="text-sm text-emerald-700 hover:underline">← Stock Reports</Link>
        </div>
        <p className="text-gray-500 text-sm mb-4">Enter a batch number to see everywhere it went — received, put away, picked, dispatched — and where it still is.</p>

        <div className="flex flex-wrap items-end gap-2 mb-5">
          <div><label className="block text-xs text-gray-500 mb-1">Batch no.</label>
            <input value={batch} onChange={e => setBatch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }} placeholder="e.g. 260717" className="border rounded-lg px-3 py-2 text-sm w-48" /></div>
          <div><label className="block text-xs text-gray-500 mb-1">Item <span className="text-gray-400">(optional)</span></label>
            <input value={item} onChange={e => setItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }} placeholder="item code" className="border rounded-lg px-3 py-2 text-sm w-40" /></div>
          <button onClick={search} disabled={busy} className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{busy ? 'Searching…' : 'Trace'}</button>
          {moves && moves.length > 0 && <button onClick={() => downloadCsv(`Batch_${batch.trim()}.csv`, ['When', 'Type', 'Item', 'From', 'To', 'Qty', 'Reference', 'By'], moves.map(m => [fmtWhen(m.created_at), MOVE_LABEL[m.move_type] || m.move_type, m.item_code, m.from_location_code || '', m.to_location_code || '', fmtQty(m.quantity), m.reference || '', m.moved_by_name || '']))} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button>}
        </div>

        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}

        {moves && (
          <>
            {/* Where it is now */}
            <div className="bg-white rounded-xl border shadow-sm mb-4">
              <div className="px-4 py-2.5 border-b font-semibold text-sm">Where it is now <span className="text-gray-400 font-normal">· {onhand.length} bin(s)</span></div>
              {onhand.length === 0 ? <p className="px-4 py-4 text-gray-400 text-sm">None in stock now (fully used / dispatched).</p> : (
                <div className="divide-y">
                  {onhand.map((s, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <span><span className="font-mono">{s.item_code}</span> · <span className="font-mono">{s.location_code}</span>{s.exp_date ? <span className="text-gray-400"> · exp {new Date(s.exp_date + 'T00:00:00').toLocaleDateString('en-GB')}</span> : ''}</span>
                      <span className="tabular-nums font-medium">{fmtQty(s.quantity)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Customers who received this batch */}
            <div className="bg-white rounded-xl border shadow-sm mb-4 overflow-x-auto">
              <div className="px-4 py-2.5 border-b font-semibold text-sm">Customers who received this batch <span className="text-gray-400 font-normal">· {custRows.length}</span></div>
              {custRows.length === 0 && unresolvedQty <= 0.0001 ? (
                <p className="px-4 py-4 text-gray-400 text-sm">Not dispatched to any customer yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Customer', 'Delivery order', 'Order no.', 'Qty received', 'Date'].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
                  <tbody>
                    {custRows.map((c, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{c.customer_name}</td>
                        <td className="px-3 py-2 font-mono text-xs">{c.do_number || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-600">{c.order_no || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtQty(c.qty)}</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{c.last_date ? fmtWhen(c.last_date) : '—'}</td>
                      </tr>
                    ))}
                    {unresolvedQty > 0.0001 && (
                      <tr className="border-b last:border-0 bg-amber-50">
                        <td className="px-3 py-2 text-amber-800 italic" colSpan={3}>Other outbound (unresolved — dispatched, customer not linked)</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-800">{fmtQty(unresolvedQty)}</td>
                        <td className="px-3 py-2">—</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>

            {/* Documents that touched it */}
            {refs.length > 0 && <div className="text-xs text-gray-500 mb-3">Documents involved: {refs.map((r, i) => <span key={i} className="inline-block bg-gray-100 rounded px-2 py-0.5 mr-1 mb-1 font-mono">{r}</span>)}</div>}

            {/* Full movement trail */}
            <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
              <div className="px-4 py-2.5 border-b font-semibold text-sm">Movement trail <span className="text-gray-400 font-normal">· {moves.length}</span></div>
              {moves.length === 0 ? <p className="px-4 py-6 text-gray-400 text-sm text-center">No movements for that batch.</p> : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['When', 'What', 'Item', 'From → To', 'Qty', 'Reference', 'By'].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
                  <tbody>
                    {moves.map((m, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtWhen(m.created_at)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{MOVE_LABEL[m.move_type] || m.move_type}</td>
                        <td className="px-3 py-2 font-mono">{m.item_code}</td>
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{m.from_location_code || '—'} → {m.to_location_code || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtQty(m.quantity)}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">{m.reference || '—'}</td>
                        <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{m.moved_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
