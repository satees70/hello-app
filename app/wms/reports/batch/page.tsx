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

const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const MOVE_LABEL: Record<string, string> = { receipt: '📥 Received', putaway: '📦 Put away', transfer: '↔ Moved', pick: '🛒 Picked', dispatch: '🚚 Dispatched', adjust: '✏ Adjusted' }

export default function BatchRecallPage() {
  const { profile, loading } = useProfile()
  const [batch, setBatch] = useState('')
  const [item, setItem] = useState('')
  const [moves, setMoves] = useState<Move[] | null>(null)
  const [onhand, setOnhand] = useState<OnHand[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const search = useCallback(async () => {
    const b = batch.trim()
    if (!b) { setErr('Enter a batch number.'); return }
    setBusy(true); setErr(''); setMoves(null)
    let mq = supabase.from('wms_stock_moves').select('move_type, item_code, description, from_location_code, to_location_code, batch_no, quantity, reference, moved_by_name, created_at').ilike('batch_no', `%${b}%`).order('created_at', { ascending: true }).limit(1000)
    if (item.trim()) mq = mq.ilike('item_code', `%${item.trim()}%`)
    let sq = supabase.from('wms_stock').select('item_code, location_code, batch_no, quantity, exp_date').ilike('batch_no', `%${b}%`).gt('quantity', 0)
    if (item.trim()) sq = sq.ilike('item_code', `%${item.trim()}%`)
    const [{ data: m, error: me }, { data: s }] = await Promise.all([mq, sq])
    setBusy(false)
    if (me) { setErr(me.message); return }
    setMoves((m as Move[]) || [])
    setOnhand((s as OnHand[]) || [])
  }, [batch, item])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!profile) return null

  const refs = moves ? [...new Set(moves.map(m => m.reference).filter(Boolean))] as string[] : []

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
