'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { downloadCsv } from '@/lib/csv'

interface Move { id: string; move_type: string; item_code: string; description: string | null; from_location_code: string | null; to_location_code: string | null; batch_no: string; quantity: number; reference: string | null; moved_by_name: string | null; created_at: string }
interface CLine { id: string; location_code: string; item_code: string; description: string | null; batch_no: string; expected_qty: number; counted_qty: number | null; is_unexpected: boolean; counted_by_name: string | null; wms_count_tasks: { count_no: string | null; created_at: string } | { count_no: string | null; created_at: string }[] | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number | null) => n == null ? '' : clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const dOnly = (iso: string) => iso.slice(0, 10)
const MOVE_CHIP: Record<string, string> = { receipt: 'bg-sky-100 text-sky-700', putaway: 'bg-emerald-100 text-emerald-700', pick: 'bg-emerald-100 text-emerald-700', transfer: 'bg-violet-100 text-violet-700', adjust: 'bg-amber-100 text-amber-700', dispatch: 'bg-teal-100 text-teal-700' }
const disc = (l: CLine) => {
  if (l.counted_qty == null) return null
  if (l.is_unexpected) return 'Unexpected'
  const d = clean(l.counted_qty - l.expected_qty)
  if (d === 0) return null
  return l.counted_qty === 0 ? 'Missing' : d < 0 ? 'Short' : 'Over'
}

export default function ActivityReportPage() {
  const { profile, loading } = useProfile()
  const [tab, setTab] = useState<'moves' | 'disc'>('moves')
  const [moves, setMoves] = useState<Move[]>([]); const [lines, setLines] = useState<CLine[]>([])
  const [q, setQ] = useState(''); const [type, setType] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [{ data: mv }, { data: cl }] = await Promise.all([
      supabase.from('wms_stock_moves').select('id, move_type, item_code, description, from_location_code, to_location_code, batch_no, quantity, reference, moved_by_name, created_at').order('created_at', { ascending: false }).limit(2000),
      supabase.from('wms_count_lines').select('id, location_code, item_code, description, batch_no, expected_qty, counted_qty, is_unexpected, counted_by_name, wms_count_tasks(count_no, created_at)').not('counted_qty', 'is', null).limit(2000),
    ])
    setMoves((mv as Move[]) || []); setLines((cl as CLine[]) || [])
  }

  const fMoves = useMemo(() => {
    const n = q.trim().toLowerCase()
    return moves
      .filter(m => (type ? m.move_type === type : true))
      .filter(m => (from ? dOnly(m.created_at) >= from : true))
      .filter(m => (to ? dOnly(m.created_at) <= to : true))
      .filter(m => !n || [m.item_code, m.description, m.from_location_code, m.to_location_code, m.batch_no, m.reference, m.moved_by_name].some(v => (v || '').toLowerCase().includes(n)))
  }, [moves, q, type, from, to])

  const discRows = useMemo(() => {
    const n = q.trim().toLowerCase()
    return lines.map(l => ({ l, t: disc(l), task: Array.isArray(l.wms_count_tasks) ? l.wms_count_tasks[0] : l.wms_count_tasks })).filter(x => x.t)
      .filter(x => (from ? (x.task?.created_at || '').slice(0, 10) >= from : true))
      .filter(x => (to ? (x.task?.created_at || '').slice(0, 10) <= to : true))
      .filter(x => !n || [x.l.item_code, x.l.location_code, x.l.batch_no, x.task?.count_no].some(v => (v || '').toLowerCase().includes(n)))
  }, [lines, q, from, to])

  function exportMoves() { downloadCsv('Movements.csv', ['When', 'Type', 'Item', 'From', 'To', 'Batch', 'Qty', 'Reference', 'By'], fMoves.map(m => [fmtTime(m.created_at), m.move_type, m.item_code, m.from_location_code, m.to_location_code, m.batch_no, fmtQty(m.quantity), m.reference, m.moved_by_name])) }
  function exportDisc() { downloadCsv('Count_discrepancies.csv', ['Count', 'Item', 'Bin', 'Batch', 'System', 'Counted', 'Diff', 'Type', 'By'], discRows.map(({ l, t, task }) => [task?.count_no, l.item_code, l.location_code, l.batch_no, fmtQty(l.expected_qty), fmtQty(l.counted_qty), fmtQty(clean((l.counted_qty ?? 0) - l.expected_qty)), t, l.counted_by_name])) }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div><h1 className="text-2xl font-bold">Activity</h1><p className="text-gray-500 text-sm mt-1">Movement history & count discrepancies. <Link href="/wms/reports" className="text-emerald-700 underline">Stock reports</Link></p></div>
          <button onClick={tab === 'moves' ? exportMoves : exportDisc} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button>
        </div>

        <div className="inline-flex rounded-lg border bg-white p-1 mb-4 text-sm">
          {(['moves', 'disc'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-md font-medium ${tab === t ? 'bg-emerald-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>{t === 'moves' ? 'Movements' : 'Count discrepancies'}</button>)}
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item / bin / user / ref…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          {tab === 'moves' && <select value={type} onChange={e => setType(e.target.value)} className="border rounded-lg px-3 py-2 text-sm"><option value="">All types</option>{['receipt', 'putaway', 'pick', 'transfer', 'adjust', 'dispatch'].map(t => <option key={t} value={t}>{t}</option>)}</select>}
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" title="From" />
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" title="To" />
        </div>

        {tab === 'moves' ? (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>{['When', 'Type', 'Item', 'From', 'To', 'Batch', 'Qty', 'Reference', 'By'].map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {fMoves.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No movements match.</td></tr>}
                {fMoves.map(m => (
                  <tr key={m.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtTime(m.created_at)}</td>
                    <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${MOVE_CHIP[m.move_type] || 'bg-gray-100'}`}>{m.move_type}</span></td>
                    <td className="px-3 py-2"><span className="font-mono font-medium">{m.item_code}</span> <span className="text-gray-400 text-xs">{m.description}</span></td>
                    <td className="px-3 py-2 font-mono text-xs">{m.from_location_code || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{m.to_location_code || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{m.batch_no || '—'}</td>
                    <td className="px-3 py-2 tabular-nums font-medium">{fmtQty(m.quantity)}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{m.reference || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{m.moved_by_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-gray-400 p-3">Showing {fMoves.length} of the latest 2000 movements.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b"><tr>{['Count', 'Item', 'Bin', 'Batch', 'System', 'Counted', 'Diff', 'Type', 'By'].map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {discRows.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No discrepancies.</td></tr>}
                {discRows.map(({ l, t }) => { const d = clean((l.counted_qty ?? 0) - l.expected_qty); const task = Array.isArray(l.wms_count_tasks) ? l.wms_count_tasks[0] : l.wms_count_tasks; return (
                  <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-xs">{task?.count_no}</td>
                    <td className="px-3 py-2"><span className="font-mono font-medium">{l.item_code}</span> <span className="text-gray-400 text-xs">{l.description}</span></td>
                    <td className="px-3 py-2 font-mono text-xs">{l.location_code}</td>
                    <td className="px-3 py-2 font-mono text-xs">{l.batch_no || '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtQty(l.expected_qty)}</td>
                    <td className="px-3 py-2 tabular-nums font-medium">{fmtQty(l.counted_qty)}</td>
                    <td className={`px-3 py-2 tabular-nums font-medium ${d < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{d > 0 ? '+' : ''}{fmtQty(d)}</td>
                    <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{t}</span></td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{l.counted_by_name}</td>
                  </tr>
                ) })}
              </tbody>
            </table>
            <p className="text-xs text-gray-400 p-3">{discRows.length} discrepancy line(s).</p>
          </div>
        )}
      </div>
    </div>
  )
}
