'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'

// Live factory overview for the home dashboard: per-factory orders, what's in
// production, and how much is pending. Scope follows the user (RLS): a factory
// user sees their own; HO sees all.

interface SLine { so_number: string | null; item_code: string | null; description: string | null; quantity: number | null; delivered_qty: number | null; factory_code: string | null }
interface Batch { item_code: string | null; description: string | null; factory_code: string | null; status: string | null; produced_qty: number | null; total_quantity: number | null; dispatched_at: string | null }

function Kpi({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

export default function FactoryOverview() {
  const [lines, setLines] = useState<SLine[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fac, setFac] = useState('')   // '' = all factories the user can see

  const facName = (c: string | null) => (c && facs[c]) || c || '—'

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [f, sl, b] = await Promise.all([
        supabase.from('factories').select('code, name'),
        fetchAll<SLine>('sales_order_lines', 'so_number, item_code, description, quantity, delivered_qty, factory_code', qb => qb.is('superseded_at', null)),
        supabase.from('production_batches').select('item_code, description, factory_code, status, produced_qty, total_quantity, dispatched_at').is('dispatched_at', null).neq('status', 'Bypassed').limit(2000),
      ])
      setFacs(Object.fromEntries(((f.data as { code: string; name: string }[]) || []).map(x => [x.code, x.name])))
      setLines(sl || [])
      setBatches((b.data as Batch[]) || [])
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  // A line still owing = ordered qty not fully delivered out.
  const pendingLine = (l: SLine) => Number(l.quantity || 0) > Number(l.delivered_qty || 0)
  const isReady = (b: Batch) => Number(b.total_quantity || 0) > 0 && Number(b.produced_qty || 0) >= Number(b.total_quantity || 0)

  const facList = useMemo(() => [...new Set([...lines.map(l => l.factory_code), ...batches.map(b => b.factory_code)].filter(Boolean) as string[])].sort(), [lines, batches])

  const view = useMemo(() => {
    const L = fac ? lines.filter(l => l.factory_code === fac) : lines
    const B = fac ? batches.filter(b => b.factory_code === fac) : batches
    const pend = L.filter(pendingLine)
    const openSOs = new Set(pend.map(l => l.so_number).filter(Boolean))
    const inProd = B.filter(b => !isReady(b))
    const ready = B.filter(isReady)
    // per factory rows
    const codes = fac ? [fac] : facList
    const rows = codes.map(code => {
      const lp = L.filter(l => l.factory_code === code && pendingLine(l))
      const bb = B.filter(b => b.factory_code === code)
      return {
        code,
        openSOs: new Set(lp.map(l => l.so_number).filter(Boolean)).size,
        pendingLines: lp.length,
        inProd: bb.filter(b => !isReady(b)).length,
        ready: bb.filter(isReady).length,
      }
    }).filter(r => r.openSOs || r.pendingLines || r.inProd || r.ready)
    // items running now (in production), grouped by item
    const byItem = new Map<string, { item: string; desc: string; qty: number; facs: Set<string> }>()
    for (const b of inProd) {
      const key = b.item_code || '—'
      const e = byItem.get(key) ?? { item: key, desc: b.description || '', qty: 0, facs: new Set<string>() }
      e.qty += Number(b.total_quantity || b.produced_qty || 0)
      if (b.factory_code) e.facs.add(b.factory_code)
      byItem.set(key, e)
    }
    const running = [...byItem.values()].sort((a, b) => b.qty - a.qty)
    return {
      openOrders: openSOs.size, pendingLines: pend.length, inProdCount: inProd.length, readyCount: ready.length,
      rows: rows.sort((a, b) => a.code.localeCompare(b.code)), running,
    }
  }, [lines, batches, fac, facList])

  return (
    <div className="bg-gray-50 rounded-2xl border p-4 sm:p-5 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-bold">🏭 Factory overview</h2>
        <select value={fac} onChange={e => setFac(e.target.value)} className="text-sm border rounded-lg px-2 py-1.5 bg-white">
          <option value="">All factories</option>
          {facList.map(c => <option key={c} value={c}>{facName(c)}</option>)}
        </select>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
      {loading ? <div className="text-gray-400 py-10 text-center">Loading overview…</div> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Kpi label="Open orders" value={view.openOrders} color="text-emerald-600" />
            <Kpi label="Order lines pending" value={view.pendingLines} color="text-amber-600" />
            <Kpi label="Items in production" value={view.inProdCount} color="text-indigo-600" />
            <Kpi label="Ready to dispatch" value={view.readyCount} color="text-green-600" />
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Per-factory breakdown */}
            <div className="bg-white rounded-xl border shadow-sm">
              <div className="px-4 py-2 border-b font-semibold text-sm">By factory</div>
              {view.rows.length === 0 ? <p className="px-4 py-4 text-gray-400 text-sm">Nothing active.</p> : (
                <div className="overflow-auto max-h-80">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-gray-500 bg-gray-50 sticky top-0"><tr>
                      <th className="text-left px-4 py-1.5 font-medium">Factory</th>
                      <th className="text-right px-2 py-1.5 font-medium">Open orders</th>
                      <th className="text-right px-2 py-1.5 font-medium">Pending</th>
                      <th className="text-right px-2 py-1.5 font-medium">In prod.</th>
                      <th className="text-right px-4 py-1.5 font-medium">Ready</th>
                    </tr></thead>
                    <tbody>
                      {view.rows.map(r => (
                        <tr key={r.code} className="border-t">
                          <td className="px-4 py-1.5">{facName(r.code)}</td>
                          <td className="px-2 py-1.5 text-right text-emerald-700">{r.openSOs || '—'}</td>
                          <td className="px-2 py-1.5 text-right text-amber-700">{r.pendingLines || '—'}</td>
                          <td className="px-2 py-1.5 text-right text-indigo-700">{r.inProd || '—'}</td>
                          <td className="px-4 py-1.5 text-right text-green-700">{r.ready || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* What's running now */}
            <div className="bg-white rounded-xl border shadow-sm">
              <div className="px-4 py-2 border-b font-semibold text-sm">⚙️ In production now <span className="text-gray-400 font-normal">· {view.running.length} item(s)</span></div>
              {view.running.length === 0 ? <p className="px-4 py-4 text-gray-400 text-sm">Nothing in production.</p> : (
                <ul className="divide-y max-h-80 overflow-auto">
                  {view.running.map(r => (
                    <li key={r.item} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <span className="font-mono font-medium">{r.item}</span>
                      {r.desc && <span className="text-gray-500 truncate">{r.desc}</span>}
                      <span className="ml-auto text-gray-600 whitespace-nowrap">{r.qty.toLocaleString()} <span className="text-gray-400">qty</span></span>
                      {!fac && <span className="text-gray-400 text-xs whitespace-nowrap">{[...r.facs].map(facName).join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <p className="text-gray-400 text-xs mt-3">Pending = order lines not yet fully delivered. In production = batches produced but not dispatched.</p>
        </>
      )}
    </div>
  )
}
