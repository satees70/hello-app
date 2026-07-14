'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import { supabase, fetchAll } from '@/lib/supabase'

// Pick for Production — create the production order.
// A released pick run becomes a WMS order. Production asks in kg; each loose material
// is proposed as a BAG SKU × qty, but the office CONFIRMS (and can adjust) the
// conversion first — a cross-check to avoid picking the wrong pack. On confirm the
// order is created from exactly those lines, then picked/dispatched/received like a
// customer order.

const PACK = 'BAG|CTN|CARTON'
const isBagCode = (code: string) => new RegExp(`-\\d+(?:\\.\\d+)?\\s*KG\\s*/\\s*(?:${PACK})$`, 'i').test(code || '')
const parseKgpb = (code: string, desc: string) => { const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*KG\\s*/\\s*(?:${PACK})`, 'i').exec(`${code} ${desc || ''}`); return m ? Number(m[1]) : null }
const round = (n: number) => Math.round(n * 1000) / 1000
const ceil = (n: number) => Math.ceil(round(n))

interface MRItem { id: string; item_code: string; description: string | null; unit: string | null; requested_qty: number | null; received_qty: number | null }
interface Batch { urgent: boolean | null }
interface MR { id: string; factory_code: string; status: string; released_at: string | null; pick_run_no: string | null; material_request_items: MRItem[]; production_batches: Batch | Batch[] | null }
interface ProdOrder { id: string; pick_run: string | null; factory_code: string | null; status: string }
interface ItemRow { id: string; code: string; description: string | null; unit: string | null; stock_code: string | null; kg_per_bag: number | null; supplied_by_factory: boolean | null }

interface Mat { code: string; description: string; unit: string; remaining: number }
interface Run { runId: string; runNo: string; factory: string; released_at: string; mats: Record<string, Mat>; reqCount: number; urgent: boolean }
interface Cand { code: string; kgpb: number | null; onhand: number }
interface Line { mat: string; description: string; needed: number; unit: string; direct: boolean; cands: Cand[]; bagCode: string; kgpb: number; qty: string; uom: string }

const ACTIVE = ['Open', 'Partially Received']
const needsDbMsg = (m: string) => /create_production_order|wms_orders|function|column|pick_run|p_lines/i.test(m)
  ? 'This needs a database update — run db/2026-07-production-order.sql and db/2026-07-production-order-confirm.sql in the Supabase SQL editor.' : m

export default function PickForProductionPage() {
  const { profile, loading: pLoading, error: pErr } = useProfile()
  const [requests, setRequests] = useState<MR[]>([])
  const [orders, setOrders] = useState<ProdOrder[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [onhand, setOnhand] = useState<Record<string, number>>({})
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({})
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string>('')
  const [q, setQ] = useState('')
  const [confirmRun, setConfirmRun] = useState<Run | null>(null)   // run whose conversion is being confirmed
  const [lines, setLines] = useState<Line[]>([])

  const canCreate = !!profile && (can(profile, 'warehouse', 'edit') || profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')
  const facName = (c: string) => facs[c] || c

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [f, po, it] = await Promise.all([
        supabase.from('factories').select('code, name'),
        supabase.from('wms_orders').select('id, pick_run, factory_code, status').eq('source', 'production').neq('status', 'Cancelled'),
        fetchAll<ItemRow>('items', 'id, code, description, unit, stock_code, kg_per_bag, supplied_by_factory', 'code'),
      ])
      const st = await fetchAll<{ item_code: string; quantity: number }>('wms_stock', 'item_code, quantity', 'item_code')
      const oh: Record<string, number> = {}
      for (const s of st) oh[s.item_code.toUpperCase()] = (oh[s.item_code.toUpperCase()] || 0) + Number(s.quantity || 0)
      // Last-used bag SKU per loose material (most recent production order line).
      const ids = ((po.data as ProdOrder[]) || []).map(o => o.id)
      const lu: Record<string, string> = {}
      if (ids.length) {
        const { data: wl } = await supabase.from('wms_order_lines').select('item_code, created_at, order_id').in('order_id', ids).order('created_at', { ascending: false }).limit(2000)
        const scOf = new Map(it.map(i => [i.code.toUpperCase(), (i.stock_code || '').toUpperCase()]))
        for (const l of (wl as { item_code: string }[] || [])) { const loose = scOf.get(l.item_code.toUpperCase()); if (loose && !lu[loose]) lu[loose] = l.item_code }
      }
      const { data: mr, error: me } = await supabase
        .from('material_requests')
        .select('id, factory_code, status, released_at, pick_run_no, material_request_items(id, item_code, description, unit, requested_qty, received_qty), production_batches!batch_id(urgent)')
        .not('released_at', 'is', null).in('status', ACTIVE).order('created_at', { ascending: true })
      if (me) throw me
      setFacs(Object.fromEntries(((f.data as { code: string; name: string }[]) || []).map(x => [x.code, x.name])))
      setOrders((po.data as ProdOrder[]) || []); setItems(it); setOnhand(oh); setLastUsed(lu)
      setRequests((mr as unknown as MR[]) || [])
    } catch (e) { setError(needsDbMsg(e instanceof Error ? e.message : String(e))) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const factoryItems = useMemo(() => new Set(items.filter(i => i.supplied_by_factory).map(i => i.code)), [items])
  const itemByCode = useMemo(() => new Map(items.map(i => [i.code.toUpperCase(), i])), [items])
  // loose material code → the bag SKUs that map to it (via stock_code), with kg/bag + on-hand.
  const bagsByLoose = useMemo(() => {
    const m = new Map<string, Cand[]>()
    for (const i of items) {
      const loose = (i.stock_code || '').toUpperCase(); if (!loose) continue
      const kgpb = i.kg_per_bag != null ? Number(i.kg_per_bag) : parseKgpb(i.code, i.description || '')
      const arr = m.get(loose) || []; arr.push({ code: i.code, kgpb, onhand: onhand[i.code.toUpperCase()] || 0 }); m.set(loose, arr)
    }
    return m
  }, [items, onhand])

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
    return Object.values(map).filter(run => Object.values(run.mats).some(g => g.remaining > 0.001))
      .sort((a, b) => b.released_at.localeCompare(a.released_at) || a.factory.localeCompare(b.factory))
  }, [requests])

  // Choose a default bag: last-used → a size with enough stock (most on-hand) → largest bag.
  function chooseDefault(loose: string, needed: number, cands: Cand[]): Cand {
    const withKg = cands.filter(c => c.kgpb && c.kgpb > 0)
    const pool = withKg.length ? withKg : cands
    const lu = lastUsed[loose.toUpperCase()]
    const luc = lu && pool.find(c => c.code.toUpperCase() === lu.toUpperCase())
    if (luc) return luc
    const enough = pool.filter(c => c.onhand * (c.kgpb || 0) >= needed).sort((a, b) => b.onhand - a.onhand)
    if (enough.length) return enough[0]
    return [...pool].sort((a, b) => (b.kgpb || 0) - (a.kgpb || 0))[0] || cands[0]
  }

  function buildLines(run: Run): Line[] {
    const out: Line[] = []
    for (const g of Object.values(run.mats).sort((a, b) => a.code.localeCompare(b.code))) {
      if (factoryItems.has(g.code)) continue   // labels etc. are made at the factory
      const cands = bagsByLoose.get(g.code.toUpperCase()) || []
      if (isBagCode(g.code) || cands.length === 0) {
        // Already a bag SKU, or a unit/loose item with no bag mapping — pick as-is.
        out.push({ mat: g.code, description: g.description, needed: g.remaining, unit: g.unit || 'unit', direct: true, cands: [], bagCode: g.code, kgpb: parseKgpb(g.code, g.description) || 1, qty: String(ceil(g.remaining)), uom: g.unit || 'BAG' })
      } else {
        const def = chooseDefault(g.code, g.remaining, cands)
        const kgpb = def.kgpb || 1
        out.push({ mat: g.code, description: g.description, needed: g.remaining, unit: 'KG', direct: false, cands, bagCode: def.code, kgpb, qty: String(ceil(g.remaining / kgpb)), uom: 'BAG' })
      }
    }
    return out
  }

  function openConfirm(run: Run) { if (!canCreate) return; setError(null); setSuccess(null); setLines(buildLines(run)); setConfirmRun(run) }
  function setLine(i: number, patch: Partial<Line>) { setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l)) }
  function pickBag(i: number, code: string) {
    const l = lines[i]; const c = l.cands.find(x => x.code === code); const kgpb = c?.kgpb || 1
    setLine(i, { bagCode: code, kgpb, qty: String(ceil(l.needed / kgpb)) })
  }
  const lineKg = (l: Line) => l.direct ? Number(l.qty || 0) * (l.kgpb || 1) : Number(l.qty || 0) * (l.kgpb || 1)
  const lineShort = (l: Line) => l.direct ? Number(l.qty || 0) + 0.001 < l.needed : lineKg(l) + 0.001 < l.needed

  async function confirmCreate() {
    if (!confirmRun || !canCreate) return
    setBusy(true); setError(null); setSuccess(null)
    const payload = lines.filter(l => Number(l.qty) > 0).map(l => ({
      item_code: l.bagCode, description: l.description, quantity: Number(l.qty), uom: l.uom, item_id: itemByCode.get(l.bagCode.toUpperCase())?.id || null,
    }))
    if (!payload.length) { setBusy(false); setError('Nothing to order.'); return }
    const { error: e } = await supabase.rpc('create_production_order', { p_pick_run: confirmRun.runNo, p_factory: confirmRun.factory, p_lines: payload })
    setBusy(false)
    if (e) { setError(needsDbMsg(e.message)); return }
    setSuccess(`Production order created for ${confirmRun.runNo}. Pick it in Orders to Pick (WMS).`)
    setConfirmRun(null); load()
  }

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return runs
    return runs.filter(run => [run.runNo, facName(run.factory), ...Object.values(run.mats).map(g => `${g.code} ${g.description}`)].some(v => (v || '').toString().toLowerCase().includes(n)))
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
        <p className="text-gray-500 text-sm mb-5">Turn a released <b>pick run</b> into a production order. Production asked in <b>kg</b>; you <b>confirm the bag conversion</b> first, then it&apos;s picked on the normal <b>Orders to Pick</b> screen, dispatched, and received at the factory.</p>

        {!canCreate && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">You can view this, but only warehouse staff / HO can create production orders.</div>}
        {error && !confirmRun && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
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
                      <button onClick={() => openConfirm(run)} disabled={!canCreate}
                        className="text-xs px-3 py-1.5 rounded-lg bg-emerald-700 text-white font-medium hover:bg-emerald-800 disabled:opacity-40 whitespace-nowrap">
                        Create production order
                      </button>
                    )}
                    <button onClick={() => setOpen(isOpen ? '' : run.runId)} className="text-gray-400 text-lg">{isOpen ? '▾' : '▸'}</button>
                  </div>
                  {isOpen && (
                    <div className="border-t px-4 py-3">
                      <p className="text-xs text-gray-400 mb-2">Released {fmt(run.released_at)}</p>
                      <table className="w-full text-sm">
                        <thead className="text-xs text-gray-500"><tr>
                          <th className="text-left py-1 font-medium">Material</th><th className="text-left py-1 font-medium">Description</th><th className="text-right py-1 font-medium">Still needed</th>
                        </tr></thead>
                        <tbody>
                          {matList.map(g => (
                            <tr key={g.code} className="border-t">
                              <td className="py-1.5 font-mono">{g.code}</td><td className="py-1.5 text-gray-500">{g.description}</td>
                              <td className="py-1.5 text-right font-medium whitespace-nowrap">{round(g.remaining)} {g.unit}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Confirm the kg → bag conversion before creating the order */}
      {confirmRun && (
        <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-3 overflow-y-auto" onClick={() => !busy && setConfirmRun(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-6" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b">
              <h2 className="font-bold text-lg">Confirm bag conversion — {confirmRun.runNo}</h2>
              <p className="text-sm text-gray-500">Check each material converts to the right bag and quantity, then create the order. {facName(confirmRun.factory)}.</p>
            </div>
            <div className="px-5 py-3 max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 border-b"><tr>
                  <th className="text-left py-1.5 font-medium">Material · needed</th>
                  <th className="text-left py-1.5 font-medium">Send as (bag)</th>
                  <th className="text-right py-1.5 font-medium">Qty</th>
                  <th className="text-right py-1.5 font-medium">= gives</th>
                </tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const short = lineShort(l)
                    return (
                      <tr key={l.mat} className="border-b last:border-0 align-top">
                        <td className="py-2 pr-2">
                          <div className="font-mono font-medium">{l.mat}</div>
                          <div className="text-xs text-gray-500">{l.description}</div>
                          <div className="text-xs text-gray-400">need {round(l.needed)} {l.direct ? l.unit : 'KG'}</div>
                        </td>
                        <td className="py-2 pr-2">
                          {l.direct ? (
                            <span className="font-mono text-xs">{l.bagCode}<div className="text-gray-400">{l.unit}{!isBagCode(l.bagCode) && l.cands.length === 0 ? ' · as-is' : ''}</div></span>
                          ) : (
                            <select value={l.bagCode} onChange={e => pickBag(i, e.target.value)} className="border rounded px-2 py-1 text-xs font-mono max-w-[190px]">
                              {l.cands.map(c => <option key={c.code} value={c.code}>{c.code} · {c.kgpb || '?'}kg · {round(c.onhand)} on hand</option>)}
                            </select>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <input value={l.qty} onChange={e => setLine(i, { qty: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal"
                            className="w-16 border rounded px-2 py-1 text-sm text-right" />
                          <div className="text-[10px] text-gray-400">{l.direct ? l.unit : 'bags'}</div>
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          <span className={short ? 'text-red-600 font-medium' : 'text-gray-700'}>
                            {l.direct ? `${round(Number(l.qty || 0))} ${l.unit}` : `${round(lineKg(l))} kg`}
                          </span>
                          {short && <div className="text-[10px] text-red-600">under the {round(l.needed)} needed</div>}
                        </td>
                      </tr>
                    )
                  })}
                  {lines.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-gray-400">Nothing to order (all items are factory-supplied).</td></tr>}
                </tbody>
              </table>
              {lines.some(lineShort) && <p className="text-xs text-amber-600 mt-2">⚠ Some lines are under the needed amount — production may not get enough. Adjust the quantity, or create anyway if intended.</p>}
              {error && <p className="text-red-600 text-sm bg-red-50 rounded p-2 mt-2">{error}</p>}
            </div>
            <div className="px-5 py-3 border-t flex items-center gap-3">
              <button onClick={confirmCreate} disabled={busy || lines.length === 0}
                className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-40 text-sm font-medium">
                {busy ? 'Creating…' : 'Confirm & create order'}
              </button>
              <button onClick={() => !busy && setConfirmRun(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
