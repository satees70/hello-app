'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import { supabase, fetchAll } from '@/lib/supabase'

// Pick for Production — the bottleneck fix.
// Production raises a Material Request in loose KG. Warehouse holds the material
// in BAGS. Here the warehouse picks bags against the request; the running tally
// converts bags → kg live, and "Send to production" transfers them in ONE step:
// bags leave WMS, the equal kg is booked into factory stock instantly, and the
// Material Request auto-fills. No separate "release/send", no waiting.
//
// Rules: over is allowed, short is NOT (Send is locked until each material you
// picked reaches its kg target). Warehouse may switch the bag/material they
// actually send (override, with a note). Bags are suggested from last time.

const PACK = 'BAG|CTN|CARTON'
const looseCode = (code: string) => (code || '').replace(new RegExp(`[-\\s]*\\d+(?:\\.\\d+)?\\s*KG\\s*\\/\\s*(?:${PACK})\\s*$`, 'i'), '').trim().toUpperCase()
const kgPerBagOf = (code: string, desc: string) => { const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*KG\\s*\\/\\s*(?:${PACK})`, 'i').exec(`${code} ${desc || ''}`); return m ? Number(m[1]) : null }
const round = (n: number) => Math.round(n * 1000) / 1000

interface MRItem { id: string; request_id: string; item_id: string | null; item_code: string; description: string | null; unit: string | null; required_qty: number | null; requested_qty: number | null; received_qty: number | null }
interface Batch { batch_no: string | null; item_code: string | null; description: string | null; urgent: boolean | null }
interface MR { id: string; request_no: string | null; factory_code: string; status: string; created_at: string; created_by_name: string | null; material_request_items: MRItem[]; production_batches: Batch | Batch[] | null }
interface Stock { id: string; item_id: string | null; item_code: string; description: string | null; location_id: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number; uom: string | null; production_only?: boolean | null }
interface ItemRow { code: string; description: string | null; unit: string | null; stock_code: string | null; kg_per_bag: number | null }
interface PrevLine { item_code: string | null; source_item_code: string | null; kg_per_bag: number | null }

type Override = { key: string; stock: Stock; bags: string; kgpb: string; note: string }

const needsDbMsg = (m: string) => /wms_transfer_to_production|production_only|function|wms_production_transfer|column/i.test(m)
  ? 'This needs a database update — run db/2026-07-production-transfer.sql in the Supabase SQL editor.' : m

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
  const [open, setOpen] = useState<string>('')      // expanded request id
  const [q, setQ] = useState('')

  const [bags, setBags] = useState<Record<string, string>>({})   // `${lineId}::${stockId}` → bags
  const [kgpb, setKgpb] = useState<Record<string, string>>({})   // `${lineId}::${stockId}` → kg/bag override
  const [ovr, setOvr] = useState<Record<string, Override[]>>({}) // lineId → switched picks
  const [pick, setPick] = useState<string>('')                   // lineId whose override picker is open
  const [pickQ, setPickQ] = useState('')

  // Matches the RPC's own gate (has_perm('warehouse','edit')): the same staff who
  // pick WMS orders can send to production. HO/admin pass by default.
  const canPick = !!profile && (can(profile, 'warehouse', 'edit') || profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')
  const facName = (c: string) => facs[c] || c
  const batchOf = (r: MR): Batch | null => Array.isArray(r.production_batches) ? (r.production_batches[0] || null) : r.production_batches

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [f, it, st, pv] = await Promise.all([
        supabase.from('factories').select('code, name'),
        fetchAll<ItemRow>('items', 'code, description, unit, stock_code, kg_per_bag', 'code'),
        fetchAll<Stock>('wms_stock', 'id, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom, production_only', 'item_code'),
        supabase.from('wms_production_transfer_lines').select('item_code, source_item_code, kg_per_bag').order('created_at', { ascending: false }).limit(1000),
      ])
      const { data: mr, error: me } = await supabase
        .from('material_requests')
        .select('id, request_no, factory_code, status, created_at, created_by_name, material_request_items(id, request_id, item_id, item_code, description, unit, required_qty, requested_qty, received_qty), production_batches!batch_id(batch_no, item_code, description, urgent)')
        .in('status', ['Open', 'Partially Received'])
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

  // Map every item code → its loose code + kg-per-bag (stock_code / kg_per_bag win,
  // else parse the pack size out of the code, same rule as Goods Received).
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

  // Suggested bag SKU + kg/bag for a loose material, from what was sent last time.
  const suggestFor = useCallback((loose: string) => {
    const p = prev.find(x => (x.item_code || '').toUpperCase() === loose && x.source_item_code)
    return p ? { code: (p.source_item_code as string).toUpperCase(), kgpb: p.kg_per_bag != null ? Number(p.kg_per_bag) : null } : null
  }, [prev])

  const remainingOf = (l: MRItem) => Math.max(0, Number(l.requested_qty || 0) - Number(l.received_qty || 0))
  const stockFor = useCallback((loose: string) => stocks.filter(s => looseOf(s) === loose).sort((a, b) => Number(b.quantity) - Number(a.quantity)), [stocks, looseOf])

  // Live kg tally for one request line = matching-stock picks + override picks.
  const lineKg = useCallback((l: MRItem) => {
    let kg = 0
    for (const s of stockFor(l.item_code.toUpperCase())) {
      const b = Number(bags[`${l.id}::${s.id}`] || 0)
      const k = Number(kgpb[`${l.id}::${s.id}`] ?? kgpbOf(s) ?? 0)
      if (b > 0 && k > 0) kg += b * k
    }
    for (const o of (ovr[l.id] || [])) { const b = Number(o.bags || 0), k = Number(o.kgpb || 0); if (b > 0 && k > 0) kg += b * k }
    return round(kg)
  }, [bags, kgpb, ovr, stockFor, kgpbOf])

  const linePicked = (l: MRItem) => {
    let n = 0
    for (const s of stockFor(l.item_code.toUpperCase())) if (Number(bags[`${l.id}::${s.id}`] || 0) > 0) n++
    for (const o of (ovr[l.id] || [])) if (Number(o.bags || 0) > 0) n++
    return n
  }

  const setBag = (lineId: string, stockId: string, v: string) => setBags(b => ({ ...b, [`${lineId}::${stockId}`]: v.replace(/[^0-9.]/g, '') }))
  const setK = (lineId: string, stockId: string, v: string) => setKgpb(b => ({ ...b, [`${lineId}::${stockId}`]: v.replace(/[^0-9.]/g, '') }))

  function applySuggestion(l: MRItem) {
    const loose = l.item_code.toUpperCase()
    const sug = suggestFor(loose)
    const cand = stockFor(loose)
    const target = cand.find(s => sug && s.item_code.toUpperCase() === sug.code) || cand[0]
    if (!target) return
    const k = kgpbOf(target) ?? sug?.kgpb ?? 0
    if (!k) return
    const need = Math.max(0, remainingOf(l) - lineKg(l))
    const n = Math.ceil(need / k)
    if (n > 0) { setBag(l.id, target.id, String(n)); if (kgpb[`${l.id}::${target.id}`] == null) setK(l.id, target.id, String(k)) }
  }

  function addOverride(lineId: string, s: Stock) {
    const k = kgpbOf(s)
    setOvr(o => ({ ...o, [lineId]: [...(o[lineId] || []), { key: `${s.id}-${(o[lineId] || []).length}`, stock: s, bags: '', kgpb: k != null ? String(k) : '', note: '' }] }))
    setPick(''); setPickQ('')
  }
  function updOverride(lineId: string, key: string, patch: Partial<Override>) {
    setOvr(o => ({ ...o, [lineId]: (o[lineId] || []).map(x => x.key === key ? { ...x, ...patch } : x) }))
  }
  function delOverride(lineId: string, key: string) {
    setOvr(o => ({ ...o, [lineId]: (o[lineId] || []).filter(x => x.key !== key) }))
  }

  // Is this request ready to send? Need ≥1 pick, and every line we picked must
  // reach its target (over ok, short blocked). Lines with no picks are skipped.
  const requestState = useCallback((r: MR) => {
    let anyPick = false, anyShort = false, shortMsg = ''
    for (const l of r.material_request_items || []) {
      const picked = linePicked(l)
      if (!picked) continue
      anyPick = true
      const need = remainingOf(l), got = lineKg(l)
      if (got + 0.001 < need) { anyShort = true; shortMsg = `${l.item_code}: ${round(got)} of ${need} kg — cannot send less` }
    }
    return { canSend: anyPick && !anyShort, anyPick, anyShort, shortMsg }
  }, [linePicked, lineKg])

  async function send(r: MR) {
    if (!canPick) return
    const st = requestState(r)
    if (!st.canSend) { setError(st.shortMsg || 'Pick at least one material to send.'); return }
    setBusy(r.id); setError(null); setSuccess(null)
    const lines: Record<string, unknown>[] = []
    for (const l of r.material_request_items || []) {
      for (const s of stockFor(l.item_code.toUpperCase())) {
        const b = Number(bags[`${l.id}::${s.id}`] || 0)
        const k = Number(kgpb[`${l.id}::${s.id}`] ?? kgpbOf(s) ?? 0)
        if (b > 0 && k > 0) lines.push({ request_item_id: l.id, item_id: l.item_id, item_code: l.item_code, description: l.description, source_item_code: s.item_code, location_id: s.location_id, batch_no: s.batch_no, exp_date: s.exp_date, bags: b, uom: s.uom, kg_per_bag: k, kg: round(b * k), override_note: null })
      }
      for (const o of (ovr[l.id] || [])) {
        const b = Number(o.bags || 0), k = Number(o.kgpb || 0)
        if (b > 0 && k > 0) lines.push({ request_item_id: l.id, item_id: l.item_id, item_code: l.item_code, description: l.description, source_item_code: o.stock.item_code, location_id: o.stock.location_id, batch_no: o.stock.batch_no, exp_date: o.stock.exp_date, bags: b, uom: o.stock.uom, kg_per_bag: k, kg: round(b * k), override_note: o.note || `switched to ${o.stock.item_code}` })
      }
    }
    if (!lines.length) { setBusy(''); setError('Nothing to send.'); return }
    const { data, error: e } = await supabase.rpc('wms_transfer_to_production', { p_request_id: r.id, p_lines: lines })
    setBusy('')
    if (e) { setError(needsDbMsg(e.message)); return }
    const res = data as { transfer_no?: string; kg?: number } | null
    setSuccess(`Sent ${res?.kg ?? ''} kg to production — ${res?.transfer_no ?? ''}. Production has the stock now.`)
    setBags({}); setKgpb({}); setOvr({}); setOpen('')
    load()
  }

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return requests
    return requests.filter(r => [r.request_no, facName(r.factory_code), batchOf(r)?.batch_no, ...(r.material_request_items || []).map(l => `${l.item_code} ${l.description}`)]
      .some(v => (v || '').toString().toLowerCase().includes(n)))
  }, [requests, q, facs])

  if (pLoading && !pErr) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (pErr) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{pErr}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Pick for Production</h1>
          <a href="/material-requests" className="text-sm text-blue-600 hover:underline">Pick Runs →</a>
        </div>
        <p className="text-gray-500 text-sm mb-5">Production asked in <b>kg</b>; you send <b>bags</b>. Pick the bags — the system tallies them to the kg target and sends them straight to the factory. Over is fine; you can’t send short.</p>

        {!canPick && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">You can view this, but only warehouse staff / HO can send stock to production.</div>}
        {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
        {success && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {success}</div>}

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search request / factory / material…" className="border rounded-lg px-3 py-2 text-sm w-full mb-4" />

        {loading ? <div className="text-gray-400 py-16 text-center">Loading…</div> : visible.length === 0 ? (
          <div className="text-gray-400 py-16 text-center bg-white rounded-xl border">No open material requests. When production raises one, it shows up here.</div>
        ) : (
          <div className="space-y-3">
            {visible.map(r => {
              const b = batchOf(r); const isOpen = open === r.id; const st = requestState(r)
              const lineCount = (r.material_request_items || []).length
              return (
                <div key={r.id} className="bg-white rounded-xl border shadow-sm overflow-hidden">
                  <button onClick={() => setOpen(isOpen ? '' : r.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50">
                    <span className="font-mono font-semibold">{r.request_no || '—'}</span>
                    {b?.urgent && <span className="text-[10px] font-bold text-red-600 bg-red-50 rounded px-1.5 py-0.5">URGENT</span>}
                    <span className="text-sm text-gray-500">{facName(r.factory_code)}{b?.batch_no ? ` · batch ${b.batch_no}` : ''}</span>
                    <span className="text-xs text-gray-400">{lineCount} material(s)</span>
                    <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${r.status === 'Partially Received' ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>{r.status === 'Partially Received' ? 'Being picked' : 'Requested'}</span>
                    <span className="text-gray-400 text-lg">{isOpen ? '▾' : '▸'}</span>
                  </button>

                  {isOpen && (
                    <div className="border-t px-4 py-3 space-y-4">
                      {(r.material_request_items || []).map(l => {
                        const loose = l.item_code.toUpperCase(); const cand = stockFor(loose)
                        const need = remainingOf(l); const got = lineKg(l); const sug = suggestFor(loose)
                        const short = linePicked(l) > 0 && got + 0.001 < need
                        const reached = got + 0.001 >= need && need > 0
                        return (
                          <div key={l.id} className="rounded-lg border bg-gray-50/60 p-3">
                            <div className="flex flex-wrap items-baseline gap-2 mb-2">
                              <span className="font-mono font-medium">{l.item_code}</span>
                              <span className="text-sm text-gray-500">{l.description}</span>
                              <span className={`ml-auto text-sm font-semibold ${short ? 'text-red-600' : reached ? 'text-green-700' : got > 0 ? 'text-amber-600' : 'text-gray-700'}`}>
                                {round(got)} / {round(need)} kg
                                {got > need && need > 0 && <span className="text-green-600 font-normal"> (+{round(got - need)} over)</span>}
                              </span>
                            </div>
                            {Number(l.received_qty || 0) > 0 && <p className="text-xs text-gray-400 mb-2">Already in factory: {round(Number(l.received_qty))} kg of {round(Number(l.requested_qty || 0))} kg requested.</p>}

                            {cand.length === 0 && (ovr[l.id] || []).length === 0 ? (
                              <p className="text-sm text-gray-400">No warehouse bags found for this material. Use <b>Switch bag / material</b> below to send from another item.</p>
                            ) : (
                              <div className="space-y-1.5">
                                {cand.map(s => {
                                  const key = `${l.id}::${s.id}`; const k = kgpb[key] ?? (kgpbOf(s) != null ? String(kgpbOf(s)) : '')
                                  return (
                                    <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                                      <span className="font-mono text-xs w-32 truncate" title={s.item_code}>{s.item_code}</span>
                                      <span className="text-xs text-gray-500 w-24">bin {s.location_code}</span>
                                      <span className="text-xs text-gray-400 w-28">{s.batch_no ? `batch ${s.batch_no}` : 'no batch'}</span>
                                      <span className="text-xs text-gray-500">on hand {round(Number(s.quantity))} {s.uom || ''}</span>
                                      {s.production_only && <span className="text-[10px] text-purple-700 bg-purple-50 rounded px-1">🔒 prod</span>}
                                      <span className="ml-auto flex items-center gap-1">
                                        <input value={bags[key] || ''} onChange={e => setBag(l.id, s.id, e.target.value)} disabled={!canPick} inputMode="decimal"
                                          className="w-16 border rounded px-2 py-1 text-sm text-right" placeholder="0" />
                                        <span className="text-xs text-gray-400">bags ×</span>
                                        <input value={k} onChange={e => setK(l.id, s.id, e.target.value)} disabled={!canPick} inputMode="decimal"
                                          className="w-14 border rounded px-2 py-1 text-sm text-right" placeholder="kg" title="kg per bag" />
                                        <span className="text-xs text-gray-400">kg</span>
                                      </span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}

                            {/* Override: switch to a different bag / material */}
                            {(ovr[l.id] || []).map(o => (
                              <div key={o.key} className="flex flex-wrap items-center gap-2 text-sm mt-1.5 bg-purple-50/60 rounded p-1.5">
                                <span className="text-[10px] text-purple-700 font-semibold">SWITCHED</span>
                                <span className="font-mono text-xs w-28 truncate" title={o.stock.item_code}>{o.stock.item_code}</span>
                                <span className="text-xs text-gray-500">bin {o.stock.location_code} · {round(Number(o.stock.quantity))} {o.stock.uom || ''}</span>
                                <input value={o.note} onChange={e => updOverride(l.id, o.key, { note: e.target.value })} placeholder="reason for switch"
                                  className="border rounded px-2 py-1 text-xs flex-1 min-w-[120px]" />
                                <input value={o.bags} onChange={e => updOverride(l.id, o.key, { bags: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal" className="w-14 border rounded px-2 py-1 text-sm text-right" placeholder="0" />
                                <span className="text-xs text-gray-400">×</span>
                                <input value={o.kgpb} onChange={e => updOverride(l.id, o.key, { kgpb: e.target.value.replace(/[^0-9.]/g, '') })} inputMode="decimal" className="w-12 border rounded px-2 py-1 text-sm text-right" placeholder="kg" />
                                <span className="text-xs text-gray-400">kg</span>
                                <button onClick={() => delOverride(l.id, o.key)} className="text-red-500 text-xs hover:underline">remove</button>
                              </div>
                            ))}

                            <div className="flex flex-wrap gap-3 mt-2">
                              {sug && <button onClick={() => applySuggestion(l)} disabled={!canPick} className="text-xs text-blue-600 hover:underline">↺ Last time: {sug.code}{sug.kgpb ? ` (${sug.kgpb}kg)` : ''} — apply</button>}
                              {canPick && <button onClick={() => { setPick(pick === l.id ? '' : l.id); setPickQ('') }} className="text-xs text-purple-700 hover:underline">⇄ Switch bag / material</button>}
                            </div>

                            {pick === l.id && (
                              <div className="mt-2 border rounded-lg bg-white p-2">
                                <input autoFocus value={pickQ} onChange={e => setPickQ(e.target.value)} placeholder="Search any warehouse item / bin…" className="border rounded px-2 py-1 text-sm w-full mb-1" />
                                <div className="max-h-44 overflow-auto divide-y">
                                  {stocks.filter(s => { const n = pickQ.trim().toLowerCase(); return n && [s.item_code, s.description, s.location_code, s.batch_no].some(v => (v || '').toLowerCase().includes(n)) }).slice(0, 30).map(s => (
                                    <button key={s.id} onClick={() => addOverride(l.id, s)} className="w-full text-left px-2 py-1.5 text-sm hover:bg-purple-50 flex items-center gap-2">
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
                        <button onClick={() => send(r)} disabled={!canPick || !st.canSend || busy === r.id}
                          className="bg-indigo-700 text-white px-5 py-2 rounded-lg hover:bg-indigo-800 disabled:opacity-40 text-sm font-medium">
                          {busy === r.id ? 'Sending…' : 'Send to production →'}
                        </button>
                        {st.anyShort && <span className="text-xs text-red-600">{st.shortMsg}</span>}
                        {!st.anyPick && <span className="text-xs text-gray-400">Pick bags for at least one material to send.</span>}
                        {st.canSend && <span className="text-xs text-green-600">Ready — bags convert to kg and land in factory stock instantly.</span>}
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
