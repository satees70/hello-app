'use client'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
interface StockRow { location_code: string; batch_no: string; quantity: number; uom: string | null; exp_date: string | null }
interface Line { mat: string; description: string; needed: number; unit: string; neededKg: number | null; cands: Cand[]; bagCode: string; kgpb: number; qty: string; uom: string }

const ACTIVE = ['Open', 'Partially Received']
const needsDbMsg = (m: string) => /create_production_order|wms_orders|function|column|pick_run|p_lines/i.test(m)
  ? 'This needs a database update — run db/2026-07-production-order.sql and db/2026-07-production-order-confirm.sql in the Supabase SQL editor.' : m

export default function PickForProductionPage() {
  const { profile, loading: pLoading, error: pErr } = useProfile()
  const [requests, setRequests] = useState<MR[]>([])
  const [orders, setOrders] = useState<ProdOrder[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [onhand, setOnhand] = useState<Record<string, number>>({})
  const [stockByCode, setStockByCode] = useState<Record<string, StockRow[]>>({})
  const [lastUsed, setLastUsed] = useState<Record<string, string>>({})
  const [searchFor, setSearchFor] = useState<number | null>(null)   // which line's item search is open
  const [searchQ, setSearchQ] = useState('')
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string>('')
  const [q, setQ] = useState('')
  const [confirmRun, setConfirmRun] = useState<Run | null>(null)   // run whose conversion is being confirmed
  const [amendOrderId, setAmendOrderId] = useState<string | null>(null)   // set when amending an existing order
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
      const st = await fetchAll<{ item_code: string; quantity: number; location_code: string; batch_no: string; exp_date: string | null; uom: string | null }>('wms_stock', 'item_code, quantity, location_code, batch_no, exp_date, uom', 'item_code')
      const oh: Record<string, number> = {}
      const sbc: Record<string, StockRow[]> = {}
      for (const s of st) {
        if (Number(s.quantity) <= 0) continue
        const k = s.item_code.toUpperCase()
        oh[k] = (oh[k] || 0) + Number(s.quantity || 0)
        ;(sbc[k] = sbc[k] || []).push({ location_code: s.location_code, batch_no: s.batch_no, quantity: Number(s.quantity), uom: s.uom, exp_date: s.exp_date })
      }
      for (const k of Object.keys(sbc)) sbc[k].sort((a, b) => b.quantity - a.quantity)
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
      setOrders((po.data as ProdOrder[]) || []); setItems(it); setOnhand(oh); setStockByCode(sbc); setLastUsed(lu)
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

  // Is this a weight material (loose kg, or a kg-per-bag pack) vs a plain unit item?
  const isWeightUnit = (unit: string) => /kg|gram|\bg\b/i.test(unit)

  function buildLines(run: Run): Line[] {
    const out: Line[] = []
    for (const g of Object.values(run.mats).sort((a, b) => a.code.localeCompare(b.code))) {
      if (factoryItems.has(g.code)) continue   // labels etc. are made at the factory
      const cands = bagsByLoose.get(g.code.toUpperCase()) || []
      const packKg = parseKgpb(g.code, g.description)
      if (isBagCode(g.code) && packKg) {
        // Requested in bags of kg — need in kg = bags × kg/bag; default sends this SKU as-is.
        out.push({ mat: g.code, description: g.description, needed: g.remaining, unit: g.unit || 'BAG', neededKg: g.remaining * packKg, cands, bagCode: g.code, kgpb: packKg, qty: String(ceil(g.remaining)), uom: g.unit || 'BAG' })
      } else if (isWeightUnit(g.unit) || cands.length > 0) {
        // Loose kg material. If a bag SKU maps to it, default to the best bag; else send loose.
        if (cands.length > 0) {
          const def = chooseDefault(g.code, g.remaining, cands); const kgpb = def.kgpb || 1
          out.push({ mat: g.code, description: g.description, needed: g.remaining, unit: 'KG', neededKg: g.remaining, cands, bagCode: def.code, kgpb, qty: String(ceil(g.remaining / kgpb)), uom: 'BAG' })
        } else {
          out.push({ mat: g.code, description: g.description, needed: g.remaining, unit: 'KG', neededKg: g.remaining, cands, bagCode: g.code, kgpb: 1, qty: String(ceil(g.remaining)), uom: g.unit || 'KG' })
        }
      } else {
        // Plain unit item (masks, stretch film) — 1:1, no kg conversion.
        out.push({ mat: g.code, description: g.description, needed: g.remaining, unit: g.unit || 'Unit', neededKg: null, cands, bagCode: g.code, kgpb: 1, qty: String(ceil(g.remaining)), uom: g.unit || 'Unit' })
      }
    }
    return out
  }

  function openConfirm(run: Run) { if (!canCreate) return; setError(null); setSuccess(null); setAmendOrderId(null); setLines(buildLines(run)); setConfirmRun(run) }
  // Amend an already-created order: seed the dialog from its current lines (editable).
  async function openAmend(run: Run) {
    if (!canCreate) return
    const ord = orderFor(run.runNo, run.factory); if (!ord) return
    setError(null); setSuccess(null)
    const { data } = await supabase.from('wms_order_lines').select('item_code, description, quantity, uom').eq('order_id', ord.id).order('line_no')
    const built: Line[] = ((data as { item_code: string; description: string | null; quantity: number; uom: string | null }[]) || []).map(ol => ({
      mat: ol.item_code, description: ol.description || '', needed: Number(ol.quantity), unit: ol.uom || '', neededKg: null, cands: [],
      bagCode: ol.item_code, kgpb: 1, qty: String(ol.quantity), uom: ol.uom || 'BAG',
    }))
    setAmendOrderId(ord.id); setLines(built); setConfirmRun(run)
  }
  function setLine(i: number, patch: Partial<Line>) { setLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l)) }
  // The office can type/pick any item code to send. Recompute kg-per-bag and the suggested
  // quantity from the new code (bag SKUs convert against the kg need; unit items stay 1:1).
  function setSendCode(i: number, code: string) {
    const l = lines[i]; const item = itemByCode.get(code.toUpperCase())
    const kgpb = item?.kg_per_bag != null ? Number(item.kg_per_bag) : (parseKgpb(code, item?.description || '') ?? 1)
    if (l.neededKg != null) {
      const k = kgpb || 1
      setLine(i, { bagCode: code, kgpb: k, qty: String(ceil(l.neededKg / k)), uom: isBagCode(code) ? 'BAG' : (item?.unit || 'KG'), description: item?.description ?? l.description })
    } else {
      setLine(i, { bagCode: code, kgpb: 1, qty: String(ceil(l.needed)), uom: item?.unit || l.unit, description: item?.description ?? l.description })
    }
  }
  // Search ALL items by code OR name (some codes are hard to read), with stock shown.
  function matchItems(qs: string) {
    const n = qs.trim().toLowerCase()
    const out = items
      .filter(it => !n || it.code.toLowerCase().includes(n) || (it.description || '').toLowerCase().includes(n))
      .map(it => { const rows = stockByCode[it.code.toUpperCase()] || []; return { code: it.code, description: it.description || '', total: rows.reduce((s, r) => s + r.quantity, 0), rows } })
    out.sort((a, b) => (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0) || a.code.localeCompare(b.code))
    return out.slice(0, 50)
  }
  const stockText = (code: string) => {
    const rows = stockByCode[code.toUpperCase()] || []
    if (!rows.length) return ''
    return rows.slice(0, 3).map(r => `${r.location_code}${r.batch_no ? ' b:' + r.batch_no : ''} ×${round(r.quantity)}`).join('  ·  ') + (rows.length > 3 ? '  …' : '')
  }

  const lineKg = (l: Line) => Number(l.qty || 0) * (l.kgpb || 1)
  const lineShort = (l: Line) => l.neededKg != null ? lineKg(l) + 0.001 < l.neededKg : Number(l.qty || 0) + 0.001 < l.needed

  async function confirmCreate() {
    if (!confirmRun || !canCreate) return
    setBusy(true); setError(null); setSuccess(null)
    const payload = lines.filter(l => Number(l.qty) > 0).map(l => ({
      item_code: l.bagCode, description: l.description, quantity: Number(l.qty), uom: l.uom, item_id: itemByCode.get(l.bagCode.toUpperCase())?.id || null,
    }))
    if (!payload.length) { setBusy(false); setError('Nothing to order.'); return }
    const { error: e } = amendOrderId
      ? await supabase.rpc('wms_amend_production_order', { p_order_id: amendOrderId, p_lines: payload })
      : await supabase.rpc('create_production_order', { p_pick_run: confirmRun.runNo, p_factory: confirmRun.factory, p_lines: payload })
    setBusy(false)
    if (e) { setError(/wms_amend_production_order/.test(e.message) && /does not exist|schema cache|could not find/i.test(e.message) ? 'This needs a database update — run db/2026-07-wms-amend-production.sql in the Supabase SQL editor.' : needsDbMsg(e.message)); return }
    setSuccess(amendOrderId
      ? `Order amended for ${confirmRun.runNo}. Re-release it in Orders to Pick to pick the corrected items.`
      : `Production order created for ${confirmRun.runNo}. Pick it in Orders to Pick (WMS).`)
    setConfirmRun(null); setAmendOrderId(null); load()
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
                      <div className="flex items-center gap-1.5">
                        <a href="/wms/orders" className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 whitespace-nowrap">✓ Order created · {ord.status} → pick</a>
                        {canCreate && !['Dispatched', 'Partially Dispatched', 'Cancelled'].includes(ord.status) && (
                          <button onClick={() => openAmend(run)}
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 font-medium hover:bg-emerald-50 whitespace-nowrap" title="Fix a wrong item/quantity (only before picking starts)">Amend</button>
                        )}
                      </div>
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
              <h2 className="font-bold text-lg">{amendOrderId ? 'Amend production order' : 'Confirm bag conversion'} — {confirmRun.runNo}</h2>
              <p className="text-sm text-gray-500">{amendOrderId
                ? 'Fix the item code or quantity that was processed wrongly, then save. This works only while nothing has been picked — the order goes back to Review to be re-released.'
                : 'Check each material converts to the right item/bag and quantity — you can change the code or qty — then create the order.'} {facName(confirmRun.factory)}.</p>
            </div>
            <div className="px-5 py-3 max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 border-b"><tr>
                  <th className="text-left py-1.5 font-medium">Material · needed</th>
                  <th className="text-left py-1.5 font-medium">Send as (item / bag)</th>
                  <th className="text-right py-1.5 font-medium">Qty</th>
                  <th className="text-right py-1.5 font-medium">= gives</th>
                </tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const short = lineShort(l)
                    return (
                      <Fragment key={l.mat}>
                      <tr className={`align-top ${searchFor === i ? '' : 'border-b last:border-0'}`}>
                        <td className="py-2 pr-2">
                          <div className="font-mono font-medium">{l.mat}</div>
                          <div className="text-xs text-gray-500">{l.description}</div>
                          <div className="text-xs text-gray-400">need {round(l.needed)} {l.unit}</div>
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-1">
                            <input value={l.bagCode} onChange={e => setSendCode(i, e.target.value.toUpperCase())}
                              className="border rounded px-2 py-1 text-xs font-mono w-full max-w-[170px]" />
                            <button type="button" onClick={() => { setSearchFor(searchFor === i ? null : i); setSearchQ('') }}
                              className="text-xs border rounded px-1.5 py-1 hover:bg-emerald-50 shrink-0" title="Search items &amp; stock">🔍</button>
                          </div>
                          <div className="text-[10px] text-gray-400">
                            {l.neededKg != null ? (isBagCode(l.bagCode) ? `${l.kgpb}kg/bag` : 'loose kg') : (l.uom)}
                            {(() => { const oh = onhand[l.bagCode.toUpperCase()]; return oh ? ` · ${round(oh)} on hand` : (l.bagCode ? ' · no stock' : '') })()}
                            {!itemByCode.get(l.bagCode.toUpperCase()) && l.bagCode ? ' · ⚠ not in items' : ''}
                          </div>
                          {stockText(l.bagCode) && <div className="text-[10px] text-gray-400 mt-0.5">📍 {stockText(l.bagCode)}</div>}
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <input value={l.qty} onChange={e => setLine(i, { qty: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal"
                            className="w-16 border rounded px-2 py-1 text-sm text-right" />
                          <div className="text-[10px] text-gray-400">{l.uom}</div>
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          <span className={short ? 'text-red-600 font-medium' : 'text-gray-700'}>
                            {l.neededKg != null ? `${round(lineKg(l))} kg` : `${round(Number(l.qty || 0))} ${l.uom}`}
                          </span>
                          {short && <div className="text-[10px] text-red-600">under the {round(l.needed)} {l.unit} needed</div>}
                        </td>
                      </tr>
                      {searchFor === i && (
                        <tr className="border-b"><td colSpan={4} className="pb-3">
                          <div className="border rounded-lg bg-gray-50 p-2">
                            <input autoFocus value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search any item by name or code…" className="border rounded px-2 py-1.5 text-sm w-full mb-1.5" />
                            <div className="max-h-56 overflow-auto divide-y bg-white rounded border">
                              {matchItems(searchQ).map(m => (
                                <button key={m.code} type="button" onClick={() => { setSendCode(i, m.code); setSearchFor(null); setSearchQ('') }}
                                  className="w-full text-left px-2.5 py-1.5 hover:bg-emerald-50">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-medium">{m.code}</span>
                                    <span className="text-xs text-gray-500 truncate">{m.description}</span>
                                    <span className={`ml-auto text-xs whitespace-nowrap ${m.total > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>{m.total > 0 ? `${round(m.total)} on hand` : 'no stock'}</span>
                                  </div>
                                  {m.rows.length > 0 && <div className="text-[10px] text-gray-400 truncate">{m.rows.slice(0, 3).map(r => `📍${r.location_code}${r.batch_no ? ' b:' + r.batch_no : ''} ×${round(r.quantity)}${r.uom ? ' ' + r.uom : ''}`).join('   ')}{m.rows.length > 3 ? '  …' : ''}</div>}
                                </button>
                              ))}
                              {matchItems(searchQ).length === 0 && <p className="text-xs text-gray-400 px-2 py-3">{searchQ ? 'No item matches.' : 'Type a name or code…'}</p>}
                            </div>
                          </div>
                        </td></tr>
                      )}
                      </Fragment>
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
                {busy ? (amendOrderId ? 'Saving…' : 'Creating…') : (amendOrderId ? 'Save amended order' : 'Confirm & create order')}
              </button>
              <button onClick={() => !busy && setConfirmRun(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
