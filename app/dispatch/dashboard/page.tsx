'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

// Delivery Orders — overall status. Shows the dispatch → out-for-delivery →
// received pipeline at a glance, with what's still awaiting warehouse receipt.

interface Line { received_at: string | null }
interface DO {
  id: string; do_number: string | null; factory_code: string; created_at: string
  departed_at: string | null; received_at: string | null; warehouse_grn: string | null; vehicle: string | null
  dispatch_order_lines: Line[]; material_returns: Line[]
}
const allItems = (o: DO): Line[] => [...(o.dispatch_order_lines || []), ...(o.material_returns || [])]
type Stage = 'awaiting' | 'out' | 'received'
const stageOf = (o: DO): Stage => o.received_at ? 'received' : o.departed_at ? 'out' : 'awaiting'
const STAGE_LABEL: Record<Stage, string> = { awaiting: 'Awaiting lorry out', out: 'Out for delivery', received: 'Received' }
const STAGE_STYLE: Record<Stage, string> = { awaiting: 'bg-gray-100 text-gray-600', out: 'bg-emerald-100 text-emerald-700', received: 'bg-green-100 text-green-700' }

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

export default function DispatchDashboardPage() {
  const { profile, loading: pLoading, error: pErr } = useProfile()
  const [orders, setOrders] = useState<DO[]>([])
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const facName = (c: string) => facs[c] || c
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  const hoursSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const [{ data: f }, { data, error: e }] = await Promise.all([
      supabase.from('factories').select('code, name'),
      supabase.from('dispatch_orders')
        .select('id, do_number, factory_code, created_at, departed_at, received_at, warehouse_grn, vehicle, dispatch_order_lines(received_at), material_returns(received_at)')
        .order('created_at', { ascending: false }).limit(300),
    ])
    setFacs(Object.fromEntries(((f as { code: string; name: string }[]) || []).map(x => [x.code, x.name])))
    if (e) setError(e.message)
    setOrders((data as unknown as DO[]) || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const s = useMemo(() => {
    const awaiting = orders.filter(o => stageOf(o) === 'awaiting')
    const out = orders.filter(o => stageOf(o) === 'out')
    const received = orders.filter(o => stageOf(o) === 'received')
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' })
    const receivedToday = received.filter(o => o.received_at && new Date(o.received_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }) === today)
    const grnMissing = received.filter(o => !o.warehouse_grn)
    // Per factory: out vs received.
    const byFac = new Map<string, { out: number; received: number; awaiting: number }>()
    for (const o of orders) {
      const st = stageOf(o); const d = byFac.get(o.factory_code) ?? { out: 0, received: 0, awaiting: 0 }
      d[st]++; byFac.set(o.factory_code, d)
    }
    return { awaiting, out, received, receivedToday, grnMissing, byFac: [...byFac.entries()].sort((a, b) => a[0].localeCompare(b[0])) }
  }, [orders])

  if (pLoading && !pErr) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (pErr) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{pErr}</p><a href="/login" className="text-emerald-600 underline">Back to login</a></div>
  if (!profile) return null

  const lineProg = (o: DO) => { const ls = allItems(o); return `${ls.filter(l => l.received_at).length}/${ls.length}` }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Delivery Orders — status</h1>
          <a href="/dispatch" className="text-sm text-emerald-600 hover:underline">Go to Dispatch →</a>
        </div>
        <p className="text-gray-500 text-sm mb-5">Where every delivery order sits: created → out for delivery → received at the warehouse.</p>

        {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
        {loading ? <div className="text-gray-400 py-16 text-center">Loading…</div> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <Kpi label="Awaiting lorry out" value={s.awaiting.length} color="text-gray-700" />
              <Kpi label="Out for delivery" value={s.out.length} color="text-emerald-600" />
              <Kpi label="Received today" value={s.receivedToday.length} color="text-green-600" />
              <Kpi label="Received · GRN missing" value={s.grnMissing.length} color="text-amber-600" />
            </div>

            <div className="grid lg:grid-cols-2 gap-4 mb-4">
              {/* Out for delivery — awaiting warehouse receipt */}
              <div className="bg-white rounded-xl border shadow-sm">
                <div className="px-4 py-2 border-b font-semibold text-sm">🚚 Out for delivery <span className="text-gray-400 font-normal">· {s.out.length} awaiting receipt</span></div>
                {s.out.length === 0 ? <p className="px-4 py-4 text-gray-400 text-sm">Nothing out for delivery.</p> : (
                  <ul className="divide-y max-h-80 overflow-auto">
                    {s.out.map(o => { const hrs = o.departed_at ? hoursSince(o.departed_at) : 0; return (
                      <li key={o.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                        <span className="font-mono font-medium">{o.do_number}</span>
                        <span className="text-gray-400 text-xs">{facName(o.factory_code)}{o.vehicle ? ` · ${o.vehicle}` : ''}</span>
                        <span className="text-gray-400 text-xs">· {lineProg(o)} items</span>
                        <span className={`ml-auto text-xs ${hrs >= 24 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{hrs < 1 ? 'just now' : hrs < 24 ? `${hrs}h out` : `${Math.floor(hrs / 24)}d out`}</span>
                      </li>
                    ) })}
                  </ul>
                )}
              </div>

              {/* By factory */}
              <div className="bg-white rounded-xl border shadow-sm">
                <div className="px-4 py-2 border-b font-semibold text-sm">🏭 By factory</div>
                {s.byFac.length === 0 ? <p className="px-4 py-4 text-gray-400 text-sm">No delivery orders.</p> : (
                  <table className="w-full text-sm">
                    <thead className="text-xs text-gray-500"><tr><th className="text-left px-4 py-1.5 font-medium">Factory</th><th className="text-right px-2 py-1.5 font-medium">Awaiting</th><th className="text-right px-2 py-1.5 font-medium">Out</th><th className="text-right px-4 py-1.5 font-medium">Received</th></tr></thead>
                    <tbody>
                      {s.byFac.map(([code, d]) => (
                        <tr key={code} className="border-t">
                          <td className="px-4 py-1.5">{facName(code)}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600">{d.awaiting || '—'}</td>
                          <td className="px-2 py-1.5 text-right text-emerald-700">{d.out || '—'}</td>
                          <td className="px-4 py-1.5 text-right text-green-700">{d.received || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Recent */}
            <div className="bg-white rounded-xl border shadow-sm">
              <div className="px-4 py-2 border-b font-semibold text-sm">Recent delivery orders</div>
              <div className="overflow-auto max-h-96">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b sticky top-0"><tr>{['DO No.', 'Factory', 'Stage', 'Items', 'GRN', 'When'].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
                  <tbody>
                    {orders.slice(0, 100).map(o => { const st = stageOf(o); return (
                      <tr key={o.id} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{o.do_number}</td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{facName(o.factory_code)}</td>
                        <td className="px-3 py-2 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STAGE_STYLE[st]}`}>{STAGE_LABEL[st]}</span></td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{lineProg(o)}</td>
                        <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap">{o.warehouse_grn || (st === 'received' ? <span className="text-amber-600 font-sans">⚠ none</span> : '—')}</td>
                        <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{fmt(o.received_at || o.departed_at || o.created_at)}</td>
                      </tr>
                    ) })}
                    {orders.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No delivery orders.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
