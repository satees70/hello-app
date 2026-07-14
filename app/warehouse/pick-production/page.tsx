'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import { supabase } from '@/lib/supabase'

// Pick for Production — create the production order.
// A released pick run (from Combined picking) becomes a WMS order here. Production
// asks in kg; on create, each loose material is converted to bags (last-used size)
// so it can be picked on the normal Orders-to-Pick screen, dispatched as a DO, and
// received at the factory's Goods Received. This page is just the "turn the run into
// an order" step — picking and dispatch then happen in the WMS like any customer order.

interface MRItem { id: string; item_code: string; description: string | null; unit: string | null; requested_qty: number | null; received_qty: number | null }
interface Batch { urgent: boolean | null }
interface MR { id: string; factory_code: string; status: string; released_at: string | null; pick_run_no: string | null; material_request_items: MRItem[]; production_batches: Batch | Batch[] | null }
interface ProdOrder { id: string; pick_run: string | null; factory_code: string | null; status: string }

interface Mat { code: string; description: string; unit: string; remaining: number }
interface Run { runId: string; runNo: string; factory: string; released_at: string; mats: Record<string, Mat>; reqCount: number; urgent: boolean }

const ACTIVE = ['Open', 'Partially Received']
const round = (n: number) => Math.round(n * 1000) / 1000
const needsDbMsg = (m: string) => /create_production_order|wms_orders|function|column|pick_run/i.test(m)
  ? 'This needs a database update — run db/2026-07-production-order.sql in the Supabase SQL editor.' : m

export default function PickForProductionPage() {
  const { profile, loading: pLoading, error: pErr } = useProfile()
  const [requests, setRequests] = useState<MR[]>([])
  const [orders, setOrders] = useState<ProdOrder[]>([])
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState<string>('')
  const [q, setQ] = useState('')

  const canCreate = !!profile && (can(profile, 'warehouse', 'edit') || profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')
  const facName = (c: string) => facs[c] || c

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [f, po] = await Promise.all([
        supabase.from('factories').select('code, name'),
        supabase.from('wms_orders').select('id, pick_run, factory_code, status').eq('source', 'production').neq('status', 'Cancelled'),
      ])
      const { data: mr, error: me } = await supabase
        .from('material_requests')
        .select('id, factory_code, status, released_at, pick_run_no, material_request_items(id, item_code, description, unit, requested_qty, received_qty), production_batches!batch_id(urgent)')
        .not('released_at', 'is', null)
        .in('status', ACTIVE)
        .order('created_at', { ascending: true })
      if (me) throw me
      setFacs(Object.fromEntries(((f.data as { code: string; name: string }[]) || []).map(x => [x.code, x.name])))
      setOrders((po.data as ProdOrder[]) || [])
      setRequests((mr as unknown as MR[]) || [])
    } catch (e) { setError(needsDbMsg(e instanceof Error ? e.message : String(e))) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const orderFor = useCallback((runNo: string, fac: string) => orders.find(o => o.pick_run === runNo && o.factory_code === fac), [orders])

  const runs = useMemo<Run[]>(() => {
    const map: Record<string, Run> = {}
    for (const r of requests) {
      if (!r.released_at) continue
      const runId = r.pick_run_no || `${r.factory_code}|${r.released_at}`
      const b = Array.isArray(r.production_batches) ? r.production_batches[0] : r.production_batches
      const run = (map[runId] = map[runId] || { runId, runNo: r.pick_run_no || '(unnumbered)', factory: r.factory_code, released_at: r.released_at, mats: {}, reqCount: 0, urgent: false })
      run.reqCount++; if (b?.urgent) run.urgent = true
      for (const it of r.material_request_items || []) {
        const g = (run.mats[it.item_code] = run.mats[it.item_code] || { code: it.item_code, description: it.description || '', unit: it.unit || '', remaining: 0 })
        g.remaining += Math.max(0, Number(it.requested_qty || 0) - Number(it.received_qty || 0))
      }
    }
    return Object.values(map)
      .filter(run => Object.values(run.mats).some(g => g.remaining > 0.001))
      .sort((a, b) => b.released_at.localeCompare(a.released_at) || a.factory.localeCompare(b.factory))
  }, [requests])

  async function createOrder(run: Run) {
    if (!canCreate) return
    setBusy(run.runId); setError(null); setSuccess(null)
    const { error: e } = await supabase.rpc('create_production_order', { p_pick_run: run.runNo, p_factory: run.factory })
    setBusy('')
    if (e) { setError(needsDbMsg(e.message)); return }
    setSuccess(`Production order created for ${run.runNo}. Pick it in Orders to Pick (WMS).`)
    load()
  }

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return runs
    return runs.filter(run => [run.runNo, facName(run.factory), ...Object.values(run.mats).map(g => `${g.code} ${g.description}`)]
      .some(v => (v || '').toString().toLowerCase().includes(n)))
  }, [runs, q, facs])

  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  if (pLoading && !pErr) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (pErr) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{pErr}</p><a href="/login" className="text-emerald-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Pick for Production</h1>
          <a href="/material-requests" className="text-sm text-emerald-600 hover:underline">Combined picking →</a>
        </div>
        <p className="text-gray-500 text-sm mb-5">Turn a released <b>pick run</b> into a production order. Production asked in <b>kg</b>; the order is created in <b>bags</b> so the warehouse picks it on the normal <b>Orders to Pick</b> screen, dispatches a DO, and the factory receives it in Goods Received.</p>

        {!canCreate && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">You can view this, but only warehouse staff / HO can create production orders.</div>}
        {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
        {success && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {success} <a href="/wms/orders" className="underline font-medium">Open Orders to Pick →</a></div>}

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search pick run / factory / material…" className="border rounded-lg px-3 py-2 text-sm w-full mb-4" />

        {loading ? <div className="text-gray-400 py-16 text-center">Loading…</div> : visible.length === 0 ? (
          <div className="text-gray-400 py-16 text-center bg-white rounded-xl border">No released pick runs. Release a run from <b>Combined picking</b> first — then create its production order here.</div>
        ) : (
          <div className="space-y-3">
            {visible.map(run => {
              const isOpen = open === run.runId; const ord = orderFor(run.runNo, run.factory)
              const matList = Object.values(run.mats).sort((a, b) => a.code.localeCompare(b.code))
              return (
                <div key={run.runId} className="bg-white rounded-xl border shadow-sm overflow-hidden">
                  <div className="w-full flex items-center gap-3 px-4 py-3">
                    <button onClick={() => setOpen(isOpen ? '' : run.runId)} className="flex items-center gap-3 text-left flex-1 min-w-0">
                      <span className="font-mono font-semibold">{run.runNo}</span>
                      {run.urgent && <span className="text-[10px] font-bold text-red-600 bg-red-50 rounded px-1.5 py-0.5">URGENT</span>}
                      <span className="text-sm text-gray-500 truncate">{facName(run.factory)}</span>
                      <span className="text-xs text-gray-400 whitespace-nowrap">{matList.length} material(s) · {run.reqCount} request(s)</span>
                    </button>
                    {ord ? (
                      <a href="/wms/orders" className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 whitespace-nowrap">✓ Order created · {ord.status} → pick</a>
                    ) : (
                      <button onClick={() => createOrder(run)} disabled={!canCreate || busy === run.runId}
                        className="text-xs px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-medium hover:bg-emerald-800 disabled:opacity-40 whitespace-nowrap">
                        {busy === run.runId ? 'Creating…' : 'Create production order'}
                      </button>
                    )}
                    <button onClick={() => setOpen(isOpen ? '' : run.runId)} className="text-gray-400 text-lg">{isOpen ? '▾' : '▸'}</button>
                  </div>

                  {isOpen && (
                    <div className="border-t px-4 py-3">
                      <p className="text-xs text-gray-400 mb-2">Released {fmt(run.released_at)}</p>
                      <table className="w-full text-sm">
                        <thead className="text-xs text-gray-500"><tr>
                          <th className="text-left py-1 font-medium">Material</th>
                          <th className="text-left py-1 font-medium">Description</th>
                          <th className="text-right py-1 font-medium">Still needed</th>
                        </tr></thead>
                        <tbody>
                          {matList.map(g => (
                            <tr key={g.code} className="border-t">
                              <td className="py-1.5 font-mono">{g.code}</td>
                              <td className="py-1.5 text-gray-500">{g.description}</td>
                              <td className="py-1.5 text-right font-medium whitespace-nowrap">{round(g.remaining)} {g.unit}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {ord && <p className="text-xs text-emerald-700 mt-2">Order already created — continue in <a href="/wms/orders" className="underline">Orders to Pick</a>.</p>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
