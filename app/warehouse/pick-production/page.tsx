'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import { supabase, fetchAll } from '@/lib/supabase'

// Pick for Production — the bottleneck fix, driven by COMBINED PICKING.
// The warehouse only picks once production's requests have been released into a pick
// run (a PR number). This page lists those released runs, POOLED by material exactly
// like the Combined-picking screen. Warehouse picks the pooled material in BAGS; the
// running tally converts bags → kg live and, on send, the quantity is booked into
// factory stock in ONE step and split back across the run's original requests
// (oldest-first, like receive_combined_lot). No separate "send", no waiting.
//
// Rules: over is allowed, short is NOT (Send is locked until each picked material
// reaches its target). Warehouse may switch the bag/material they actually send
// (override, with a note). Bags are suggested from what was sent last time.

const PACK = 'BAG|CTN|CARTON'
const looseCode = (code: string) => (code || '').replace(new RegExp(`[-\\s]*\\d+(?:\\.\\d+)?\\s*KG\\s*\\/\\s*(?:${PACK})\\s*$`, 'i'), '').trim().toUpperCase()
const kgPerBagOf = (code: string, desc: string) => { const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*KG\\s*\\/\\s*(?:${PACK})`, 'i').exec(`${code} ${desc || ''}`); return m ? Number(m[1]) : null }
const isBagUnit = (unit: string | null) => /bag|ctn|carton/i.test(unit || '')
const round = (n: number) => Math.round(n * 1000) / 1000

interface MRItem { id: string; item_id: string | null; item_code: string; description: string | null; unit: string | null; requested_qty: number | null; received_qty: number | null }
interface Batch { batch_no: string | null; urgent: boolean | null }
interface MR { id: string; request_no: string | null; factory_code: string; status: string; created_at: string; released_at: string | null; pick_run_no: string | null; warehouse_so_no: string | null; material_request_items: MRItem[]; production_batches: Batch | Batch[] | null }
interface Stock { id: string; item_id: string | null; item_code: string; description: string | null; location_id: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number; uom: string | null; production_only?: boolean | null }
interface ItemRow { code: string; description: string | null; unit: string | null; stock_code: string | null; kg_per_bag: number | null; supplied_by_factory: boolean | null }
interface PrevLine { item_code: string | null; source_item_code: string | null; kg_per_bag: number | null }

interface Mat { code: string; description: string; unit: string; itemId: string | null; requested: number; received: number; items: { id: string; requested_qty: number; received_qty: number }[] }
interface Run { runId: string; runNo: string; factory: string; released_at: string; soNo: string | null; mats: Record<string, Mat>; reqs: MR[]; urgent: boolean }
type Override = { key: string; stock: Stock; bags: string; kgpb: string; note: string }

const ACTIVE = ['Open', 'Partially Received']
const needsDbMsg = (m: string) => /wms_transfer_to_production|production_only|function|wms_production_transfer|column|p_materials|p_pick_run/i.test(m)
  ? 'This needs a database update — run db/2026-07-production-transfer.sql and db/2026-07-production-transfer-runs.sql in the Supabase SQL editor.' : m

export default function PickForProductionPage() {
  const { profile, loading: pLoading, error: pErr } = useProfile()
  const [requests, setRequests] = useState<MR[]>([])
  const [stocks, setStocks] = useState<Stock[]>([])
  const [items, setItems] = useState<ItemRow[]>([])
  const [prev, setPrev] = useState<PrevLine[]>([])
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState<string>('')      // expanded run id
  const [q, setQ] = useState('')

  const [bags, setBags] = useState<Record<string, string>>({})   // `${runId}::${code}::${stockId}` → bags
  const [kgpb, setKgpb] = useState<Record<string, string>>({})   // same key → kg/bag override
  const [ovr, setOvr] = useState<Record<string, Override[]>>({}) // `${runId}::${code}` → switched picks
  const [pick, setPick] = useState<string>('')                   // `${runId}::${code}` whose override picker is open
  const [pickQ, setPickQ] = useState('')

  const canPick = !!profile && (can(profile, 'warehouse', 'edit') || profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')
  const facName = (c: string) => facs[c] || c

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [f, it, st, pv] = await Promise.all([
        supabase.from('factories').select('code, name'),
        fetchAll<ItemRow>('items', 'code, description, unit, stock_code, kg_per_bag, supplied_by_factory', 'code'),
        fetchAll<Stock>('wms_stock', 'id, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom, production_only', 'item_code'),
        supabase.from('wms_production_transfer_lines').select('item_code, source_item_code, kg_per_bag').order('created_at', { ascending: false }).limit(1000),
      ])
      // Only released requests (part of a pick run) that still need picking, oldest-first
      // so pooled lines allocate oldest → newest.
      const { data: mr, error: me } = await supabase
        .from('material_requests')
        .select('id, request_no, factory_code, status, created_at, released_at, pick_run_no, warehouse_so_no, material_request_items(id, item_id, item_code, description, unit, requested_qty, received_qty), production_batches!batch_id(batch_no, urgent)')
        .not('released_at', 'is', null)
        .in('status', ACTIVE)
        .order('created_at', { ascending: true })
      if (me) throw me
      setFacs(Object.fromEntries(((f.data as { code: string; name: string }[]) || []).map(x => [x.code, x.name])))
      setItems(it); setStocks(st.filter(s => Number(s.quantity) > 0))
      setPrev((pv.data as PrevLine[]) || [])
      setRequests((mr as unknown as MR[]) || [])
    } catch (e) { setError(needsDbMsg(e instanceof Error ? e.message : String(e))) }
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const factoryItems = useMemo(() => new Set(items.filter(i => i.supplied_by_factory).map(i => i.code)), [items])

  // Map every item code → its loose code + kg-per-bag (stock_code / kg_per_bag win, else
  // parse the pack size out of the code — same rule as Goods Received).
  const itemMap = useMemo(() => {
    const m = new Map<string, { loose: string; kgpb: number | null }>()
    for (const i of items) {
      const loose = (i.stock_code || '').toUpperCase() || looseCode(i.code)
      const k = i.kg_per_bag != null ? Number(i.kg_per_bag) : kgPerBagOf(i.code, i.description || '')
      m.set(i.code.toUpperCase(), { loose, kgpb: k })
    }
    return m
  }, [items])
  const looseOf = useCallback((s: { item_code: string; description: string | null }) => itemMap.get(s.item_code.toUpperCase())?.loose ?? looseCode(s.item_code), [itemMap])
  const kgpbOf = useCallback((s: { item_code: string; description: string | null }) => itemMap.get(s.item_code.toUpperCase())?.kgpb ?? kgPerBagOf(s.item_code, s.description || ''), [itemMap])

  const suggestFor = useCallback((loose: string) => {
    const p = prev.find(x => (x.item_code || '').toUpperCase() === loose && x.source_item_code)
    return p ? { code: (p.source_item_code as string).toUpperCase(), kgpb: p.kg_per_bag != null ? Number(p.kg_per_bag) : null } : null
  }, [prev])

  // Build released pick runs, pooling material lines by code (warehouse-picked only).
  const runs = useMemo<Run[]>(() => {
    const map: Record<string, Run> = {}
    for (const r of requests) {
      if (!r.released_at) continue
      const runId = r.pick_run_no || `${r.factory_code}|${r.released_at}`
      const b = Array.isArray(r.production_batches) ? r.production_batches[0] : r.production_batches
      const run = (map[runId] = map[runId] || { runId, runNo: r.pick_run_no || '(unnumbered)', factory: r.factory_code, released_at: r.released_at, soNo: r.warehouse_so_no, mats: {}, reqs: [], urgent: false })
      run.reqs.push(r); if (b?.urgent) run.urgent = true
      if (r.warehouse_so_no && !run.soNo) run.soNo = r.warehouse_so_no
      for (const it of r.material_request_items || []) {
        if (factoryItems.has(it.item_code)) continue   // labels etc. are made at the factory, not picked
        const g = (run.mats[it.item_code] = run.mats[it.item_code] || { code: it.item_code, description: it.description || '', unit: it.unit || '', itemId: it.item_id, requested: 0, received: 0, items: [] })
        g.requested += Number(it.requested_qty || 0)
        g.received += Number(it.received_qty || 0)
        g.items.push({ id: it.id, requested_qty: Number(it.requested_qty || 0), received_qty: Number(it.received_qty || 0) })
      }
    }
    return Object.values(map)
      .filter(run => Object.values(run.mats).some(g => g.requested - g.received > 0.001))   // still needs picking
      .sort((a, b) => b.released_at.localeCompare(a.released_at) || a.factory.localeCompare(b.factory))
  }, [requests, factoryItems])

  // The warehouse bag stock that can fill a pooled material, plus its conversion.
  const matStock = useCallback((g: Mat) => {
    if (isBagUnit(g.unit)) return { bag: true, loose: g.code.toUpperCase(), cand: stocks.filter(s => s.item_code.toUpperCase() === g.code.toUpperCase()) }
    const loose = itemMap.get(g.code.toUpperCase())?.loose ?? looseCode(g.code)
    return { bag: false, loose, cand: stocks.filter(s => looseOf(s) === loose).sort((a, b) => Number(b.quantity) - Number(a.quantity)) }
  }, [stocks, itemMap, looseOf])
  const defKgpb = useCallback((g: Mat, s: Stock) => isBagUnit(g.unit) ? 1 : (kgpbOf(s) ?? null), [kgpbOf])

  const remainingOf = (g: Mat) => Math.max(0, g.requested - g.received)
  const matKg = useCallback((runId: string, g: Mat) => {
    let kg = 0
    for (const s of matStock(g).cand) {
      const b = Number(bags[`${runId}::${g.code}::${s.id}`] || 0)
      const d = defKgpb(g, s); const k = Number((kgpb[`${runId}::${g.code}::${s.id}`] ?? (d != null ? String(d) : '')) || 0)
      if (b > 0 && k > 0) kg += b * k
    }
    for (const o of (ovr[`${runId}::${g.code}`] || [])) { const b = Number(o.bags || 0), k = Number(o.kgpb || 0); if (b > 0 && k > 0) kg += b * k }
    return round(kg)
  }, [bags, kgpb, ovr, matStock, defKgpb])
  const matPicked = useCallback((runId: string, g: Mat) => {
    let n = 0
    for (const s of matStock(g).cand) if (Number(bags[`${runId}::${g.code}::${s.id}`] || 0) > 0) n++
    for (const o of (ovr[`${runId}::${g.code}`] || [])) if (Number(o.bags || 0) > 0) n++
    return n
  }, [bags, ovr, matStock])

  const setBag = (k: string, v: string) => setBags(b => ({ ...b, [k]: v.replace(/[^0-9.]/g, '') }))
  const setK = (k: string, v: string) => setKgpb(b => ({ ...b, [k]: v.replace(/[^0-9.]/g, '') }))

  function applySuggestion(runId: string, g: Mat) {
    const ms = matStock(g); const sug = suggestFor(ms.loose)
    const target = ms.cand.find(s => sug && s.item_code.toUpperCase() === sug.code) || ms.cand[0]
    if (!target) return
    const k = (defKgpb(g, target) ?? sug?.kgpb ?? 0)
    if (!k) return
    const need = Math.max(0, remainingOf(g) - matKg(runId, g))
    const n = Math.ceil(need / k)
    const key = `${runId}::${g.code}::${target.id}`
    if (n > 0) { setBag(key, String(n)); if (kgpb[key] == null) setK(key, String(k)) }
  }

  function addOverride(runId: string, g: Mat, s: Stock) {
    const okey = `${runId}::${g.code}`; const k = defKgpb(g, s)
    setOvr(o => ({ ...o, [okey]: [...(o[okey] || []), { key: `${s.id}-${(o[okey] || []).length}`, stock: s, bags: '', kgpb: k != null ? String(k) : '', note: '' }] }))
    setPick(''); setPickQ('')
  }
  const updOverride = (okey: string, key: string, patch: Partial<Override>) => setOvr(o => ({ ...o, [okey]: (o[okey] || []).map(x => x.key === key ? { ...x, ...patch } : x) }))
  const delOverride = (okey: string, key: string) => setOvr(o => ({ ...o, [okey]: (o[okey] || []).filter(x => x.key !== key) }))

  // Ready to send? ≥1 material picked, and every material we picked must reach its
  // target (over ok, short blocked). Materials with no picks are simply skipped.
  const runState = useCallback((run: Run) => {
    let anyPick = false, anyShort = false, shortMsg = ''
    for (const g of Object.values(run.mats)) {
      if (!matPicked(run.runId, g)) continue
      anyPick = true
      const need = remainingOf(g), got = matKg(run.runId, g)
      if (got + 0.001 < need) { anyShort = true; shortMsg = `${g.code}: ${round(got)} of ${round(need)} ${g.unit} — cannot send less` }
    }
    return { canSend: anyPick && !anyShort, anyPick, anyShort, shortMsg }
  }, [matPicked, matKg])

  async function send(run: Run) {
    if (!canPick) return
    const st = runState(run)
    if (!st.canSend) { setError(st.shortMsg || 'Pick at least one material to send.'); return }
    setBusy(run.runId); setError(null); setSuccess(null)
    const materials: Record<string, unknown>[] = []
    for (const g of Object.values(run.mats)) {
      const picks: Record<string, unknown>[] = []
      for (const s of matStock(g).cand) {
        const key = `${run.runId}::${g.code}::${s.id}`; const b = Number(bags[key] || 0)
        const d = defKgpb(g, s); const k = Number((kgpb[key] ?? (d != null ? String(d) : '')) || 0)
        if (b > 0 && k > 0) picks.push({ source_item_code: s.item_code, location_id: s.location_id, batch_no: s.batch_no, exp_date: s.exp_date, bags: b, uom: s.uom, kg_per_bag: k, kg: round(b * k), override_note: null })
      }
      for (const o of (ovr[`${run.runId}::${g.code}`] || [])) {
        const b = Number(o.bags || 0), k = Number(o.kgpb || 0)
        if (b > 0 && k > 0) picks.push({ source_item_code: o.stock.item_code, location_id: o.stock.location_id, batch_no: o.stock.batch_no, exp_date: o.stock.exp_date, bags: b, uom: o.stock.uom, kg_per_bag: k, kg: round(b * k), override_note: o.note || `switched to ${o.stock.item_code}` })
      }
      if (picks.length) materials.push({ item_id: g.itemId, item_code: g.code, description: g.description, request_item_ids: g.items.map(i => i.id), picks })
    }
    if (!materials.length) { setBusy(''); setError('Nothing to send.'); return }
    const { data, error: e } = await supabase.rpc('wms_transfer_to_production', { p_pick_run: run.runNo, p_factory: run.factory, p_materials: materials })
    setBusy('')
    if (e) { setError(needsDbMsg(e.message)); return }
    const res = data as { transfer_no?: string; materials?: number } | null
    setSuccess(`Sent ${res?.materials ?? ''} material(s) to production — ${res?.transfer_no ?? ''}. Production has the stock now.`)
    setBags({}); setKgpb({}); setOvr({}); setOpen('')
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
  if (pErr) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{pErr}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Pick for Production</h1>
          <a href="/material-requests" className="text-sm text-blue-600 hover:underline">Combined picking →</a>
        </div>
        <p className="text-gray-500 text-sm mb-5">Released <b>pick runs</b> from Combined picking. Production asked in <b>kg</b>; you send <b>bags</b> — pick the bags, the system tallies them to the target and sends them straight to the factory. Over is fine; you can’t send short.</p>

        {!canPick && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">You can view this, but only warehouse staff / HO can send stock to production.</div>}
        {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
        {success && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {success}</div>}

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search pick run / factory / material…" className="border rounded-lg px-3 py-2 text-sm w-full mb-4" />

        {loading ? <div className="text-gray-400 py-16 text-center">Loading…</div> : visible.length === 0 ? (
          <div className="text-gray-400 py-16 text-center bg-white rounded-xl border">No released pick runs to pick. Release a run from <b>Combined picking</b> first — then it shows up here with its PR number.</div>
        ) : (
          <div className="space-y-3">
            {visible.map(run => {
              const isOpen = open === run.runId; const st = runState(run)
              const matList = Object.values(run.mats).sort((a, b) => a.code.localeCompare(b.code))
              const anyPartial = run.reqs.some(r => r.status === 'Partially Received')
              return (
                <div key={run.runId} className="bg-white rounded-xl border shadow-sm overflow-hidden">
                  <button onClick={() => setOpen(isOpen ? '' : run.runId)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50">
                    <span className="font-mono font-semibold">{run.runNo}</span>
                    {run.urgent && <span className="text-[10px] font-bold text-red-600 bg-red-50 rounded px-1.5 py-0.5">URGENT</span>}
                    <span className="text-sm text-gray-500">{facName(run.factory)}</span>
                    <span className="text-xs text-gray-400">{matList.length} material(s) · {run.reqs.length} request(s)</span>
                    <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${anyPartial ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>{anyPartial ? 'Being picked' : 'Requested'}</span>
                    <span className="text-gray-400 text-lg">{isOpen ? '▾' : '▸'}</span>
                  </button>

                  {isOpen && (
                    <div className="border-t px-4 py-3 space-y-4">
                      <p className="text-xs text-gray-400">Released {fmt(run.released_at)}{run.soNo ? ` · SO ${run.soNo}` : ''}</p>
                      {matList.map(g => {
                        const ms = matStock(g); const okey = `${run.runId}::${g.code}`
                        const need = remainingOf(g); const got = matKg(run.runId, g); const sug = suggestFor(ms.loose)
                        const short = matPicked(run.runId, g) > 0 && got + 0.001 < need
                        const reached = got + 0.001 >= need && need > 0
                        return (
                          <div key={g.code} className="rounded-lg border bg-gray-50/60 p-3">
                            <div className="flex flex-wrap items-baseline gap-2 mb-2">
                              <span className="font-mono font-medium">{g.code}</span>
                              <span className="text-sm text-gray-500">{g.description}</span>
                              <span className={`ml-auto text-sm font-semibold ${short ? 'text-red-600' : reached ? 'text-green-700' : got > 0 ? 'text-amber-600' : 'text-gray-700'}`}>
                                {round(got)} / {round(need)} {g.unit}
                                {got > need && need > 0 && <span className="text-green-600 font-normal"> (+{round(got - need)} over)</span>}
                              </span>
                            </div>
                            {g.received > 0 && <p className="text-xs text-gray-400 mb-2">Already sent: {round(g.received)} {g.unit} of {round(g.requested)} {g.unit} requested.</p>}

                            {ms.cand.length === 0 && (ovr[okey] || []).length === 0 ? (
                              <p className="text-sm text-gray-400">No warehouse bags found for this material. Use <b>Switch bag / material</b> below to send from another item.</p>
                            ) : (
                              <div className="space-y-1.5">
                                {ms.cand.map(s => {
                                  const key = `${run.runId}::${g.code}::${s.id}`; const d = defKgpb(g, s)
                                  const k = kgpb[key] ?? (d != null ? String(d) : '')
                                  return (
                                    <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                                      <span className="font-mono text-xs w-32 truncate" title={s.item_code}>{s.item_code}</span>
                                      <span className="text-xs text-gray-500 w-24">bin {s.location_code}</span>
                                      <span className="text-xs text-gray-400 w-28">{s.batch_no ? `batch ${s.batch_no}` : 'no batch'}</span>
                                      <span className="text-xs text-gray-500">on hand {round(Number(s.quantity))} {s.uom || ''}</span>
                                      {s.production_only && <span className="text-[10px] text-purple-700 bg-purple-50 rounded px-1">🔒 prod</span>}
                                      <span className="ml-auto flex items-center gap-1">
                                        <input value={bags[key] || ''} onChange={e => setBag(key, e.target.value)} disabled={!canPick} inputMode="decimal"
                                          className="w-16 border rounded px-2 py-1 text-sm text-right" placeholder="0" />
                                        <span className="text-xs text-gray-400">bags{ms.bag ? '' : ' ×'}</span>
                                        {!ms.bag && <>
                                          <input value={k} onChange={e => setK(key, e.target.value)} disabled={!canPick} inputMode="decimal"
                                            className="w-14 border rounded px-2 py-1 text-sm text-right" placeholder="kg" title="kg per bag" />
                                          <span className="text-xs text-gray-400">kg</span>
                                        </>}
                                      </span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}

                            {(ovr[okey] || []).map(o => (
                              <div key={o.key} className="flex flex-wrap items-center gap-2 text-sm mt-1.5 bg-purple-50/60 rounded p-1.5">
                                <span className="text-[10px] text-purple-700 font-semibold">SWITCHED</span>
                                <span className="font-mono text-xs w-28 truncate" title={o.stock.item_code}>{o.stock.item_code}</span>
                                <span className="text-xs text-gray-500">bin {o.stock.location_code} · {round(Number(o.stock.quantity))} {o.stock.uom || ''}</span>
                                <input value={o.note} onChange={e => updOverride(okey, o.key, { note: e.target.value })} placeholder="reason for switch"
                                  className="border rounded px-2 py-1 text-xs flex-1 min-w-[120px]" />
                                <input value={o.bags} onChange={e => updOverride(okey, o.key, { bags: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal" className="w-14 border rounded px-2 py-1 text-sm text-right" placeholder="0" />
                                <span className="text-xs text-gray-400">×</span>
                                <input value={o.kgpb} onChange={e => updOverride(okey, o.key, { kgpb: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal" className="w-12 border rounded px-2 py-1 text-sm text-right" placeholder="kg" />
                                <span className="text-xs text-gray-400">kg</span>
                                <button onClick={() => delOverride(okey, o.key)} className="text-red-500 text-xs hover:underline">remove</button>
                              </div>
                            ))}

                            <div className="flex flex-wrap gap-3 mt-2">
                              {sug && <button onClick={() => applySuggestion(run.runId, g)} disabled={!canPick} className="text-xs text-blue-600 hover:underline">↺ Last time: {sug.code}{sug.kgpb ? ` (${sug.kgpb}kg)` : ''} — apply</button>}
                              {canPick && <button onClick={() => { setPick(pick === okey ? '' : okey); setPickQ('') }} className="text-xs text-purple-700 hover:underline">⇄ Switch bag / material</button>}
                            </div>

                            {pick === okey && (
                              <div className="mt-2 border rounded-lg bg-white p-2">
                                <input autoFocus value={pickQ} onChange={e => setPickQ(e.target.value)} placeholder="Search any warehouse item / bin…" className="border rounded px-2 py-1 text-sm w-full mb-1" />
                                <div className="max-h-44 overflow-auto divide-y">
                                  {stocks.filter(s => { const n = pickQ.trim().toLowerCase(); return n && [s.item_code, s.description, s.location_code, s.batch_no].some(v => (v || '').toLowerCase().includes(n)) }).slice(0, 30).map(s => (
                                    <button key={s.id} onClick={() => addOverride(run.runId, g, s)} className="w-full text-left px-2 py-1.5 text-sm hover:bg-purple-50 flex items-center gap-2">
                                      <span className="font-mono text-xs">{s.item_code}</span>
                                      <span className="text-xs text-gray-500 truncate">{s.description}</span>
                                      <span className="ml-auto text-xs text-gray-400">bin {s.location_code} · {round(Number(s.quantity))} {s.uom || ''}</span>
                                      {s.production_only && <span className="text-[10px] text-purple-700 bg-purple-50 rounded px-1">🔒</span>}
                                    </button>
                                  ))}
                                  {pickQ.trim() === '' && <p className="text-xs text-gray-400 px-2 py-2">Type to search warehouse stock.</p>}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}

                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        <button onClick={() => send(run)} disabled={!canPick || !st.canSend || busy === run.runId}
                          className="bg-indigo-700 text-white px-5 py-2 rounded-lg hover:bg-indigo-800 disabled:opacity-40 text-sm font-medium">
                          {busy === run.runId ? 'Sending…' : 'Send to production →'}
                        </button>
                        {st.anyShort && <span className="text-xs text-red-600">{st.shortMsg}</span>}
                        {!st.anyPick && <span className="text-xs text-gray-400">Pick bags for at least one material to send.</span>}
                        {st.canSend && <span className="text-xs text-green-600">Ready — bags convert and land in factory stock instantly.</span>}
                      </div>
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
