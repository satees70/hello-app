'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'
import { can } from '@/lib/permissions'

interface Move {
  id: string; move_type: string; item_code: string; description: string | null
  from_location_code: string | null; to_location_code: string | null
  batch_no: string; exp_date: string | null; quantity: number
  reference: string | null; moved_by_name: string | null; created_at: string
}

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const TYPE_CHIP: Record<string, string> = {
  putaway: 'bg-emerald-100 text-emerald-700',
  pick: 'bg-emerald-100 text-emerald-700',
  adjust: 'bg-amber-100 text-amber-700',
  transfer: 'bg-violet-100 text-violet-700',
}

export default function WmsMovementsPage() {
  const { profile, loading } = useProfile()
  const [rows, setRows] = useState<Move[]>([])
  const [q, setQ] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [typeFilter, setTypeFilter] = useState('')

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const { data } = await supabase.from('wms_stock_moves')
      .select('id, move_type, item_code, description, from_location_code, to_location_code, batch_no, exp_date, quantity, reference, moved_by_name, created_at')
      .order('created_at', { ascending: false }).limit(500)
    setRows((data as Move[]) || [])
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows
      .filter(r => passWh(wh, r.description))
      .filter(r => (typeFilter ? r.move_type === typeFilter : true))
      .filter(r => !needle || [r.item_code, r.description, r.from_location_code, r.to_location_code, r.batch_no, r.reference].some(v => (v || '').toLowerCase().includes(needle)))
  }, [rows, q, wh, typeFilter])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  const canView = !!profile && can(profile, 'warehouse', 'view')
  if (!canView) return <div className="p-8 text-sm text-gray-500">No warehouse access.</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Stock Movements</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">Every warehouse stock move — the audit trail behind putaway, picking and adjustments.</p>

        <div className="flex flex-wrap gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item / bin / batch / reference…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
          <WarehouseTabs value={wh} onChange={setWh} />
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">All types</option>
            <option value="putaway">Putaway</option>
            <option value="pick">Pick</option>
            <option value="adjust">Adjust</option>
            <option value="transfer">Transfer</option>
          </select>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['When', 'Type', 'Item', 'From', 'To', 'Batch', 'Qty', 'Reference', 'By'].map(h => (
                <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No movements {rows.length ? 'match the filters' : 'recorded yet'}.</td></tr>}
              {filtered.map(m => (
                <tr key={m.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(m.created_at)}</td>
                  <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${TYPE_CHIP[m.move_type] || 'bg-gray-100 text-gray-600'}`}>{m.move_type}</span></td>
                  <td className="px-3 py-2.5"><span className="font-mono font-medium">{m.item_code}</span> <span className="text-gray-400 text-xs">{m.description}</span></td>
                  <td className="px-3 py-2.5 font-mono text-xs">{m.from_location_code || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{m.to_location_code || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{m.batch_no || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5 font-medium tabular-nums">{fmtQty(m.quantity)}</td>
                  <td className="px-3 py-2.5 text-gray-500 text-xs">{m.reference || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5 text-gray-500 text-xs">{m.moved_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">Showing {filtered.length} of {rows.length} recent movements (latest 500).</p>
      </div>
    </div>
  )
}
