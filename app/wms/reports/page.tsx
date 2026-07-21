'use client'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'
import { downloadCsv } from '@/lib/csv'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'

interface Stock { item_code: string; description: string | null; location_code: string; batch_no: string; exp_date: string | null; quantity: number; uom: string | null; created_at: string }
interface Loc { code: string; aisle: string | null; location_type: string }
interface Item { code: string; description: string; unit: string }
interface Setting { item_code: string; reorder_level: number | null }
interface PlanRow { item_code: string; reorder_max: number | null; lead_time_days: number | null }
interface UsageRow { item_code: string; avg_daily_use: number | null }
interface ItemSetting { reorder_level: number | null; reorder_max: number | null; lead_time_days: number | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const ageDays = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000))
const ageBucket = (d: number) => d <= 30 ? '0–30d' : d <= 60 ? '31–60d' : d <= 90 ? '61–90d' : '90d+'

type View = 'item' | 'bin' | 'zone' | 'batch' | 'aging' | 'low' | 'neg'
const VIEWS: { k: View; label: string }[] = [
  { k: 'item', label: 'On-hand by item' }, { k: 'bin', label: 'By bin' }, { k: 'zone', label: 'By zone' },
  { k: 'batch', label: 'By batch' }, { k: 'aging', label: 'Stock aging' }, { k: 'low', label: 'Low stock' },
  { k: 'neg', label: '⚠ Negative stock' },
]

export default function StockReportsPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [stock, setStock] = useState<Stock[]>([])
  const [neg, setNeg] = useState<Stock[]>([])   // bins that went negative — need reconciliation
  const [locs, setLocs] = useState<Map<string, Loc>>(new Map())
  const [items, setItems] = useState<Item[]>([])
  const [settings, setSettings] = useState<Map<string, ItemSetting>>(new Map())
  const [usage, setUsage] = useState<Map<string, number>>(new Map())
  const [planMsg, setPlanMsg] = useState('')
  const [view, setView] = useState<View>('item')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())   // item codes expanded to show bins/batches
  const [q, setQ] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [addItem, setAddItem] = useState(''); const [addLevel, setAddLevel] = useState(''); const [addMax, setAddMax] = useState(''); const [addLead, setAddLead] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  const load = useCallback(async () => {
    const [st, lo, it, se, plan, use] = await Promise.all([
      fetchAll<Stock>('wms_stock', 'item_code, description, location_code, batch_no, exp_date, quantity, uom, created_at'),
      fetchAll<Loc>('wms_locations', 'code, aisle, location_type'),
      fetchAll<Item>('items', 'code, description, unit', 'code'),
      fetchAll<Setting>('wms_item_settings', 'item_code, reorder_level'),
      supabase.from('wms_item_settings').select('item_code, reorder_max, lead_time_days'),
      supabase.rpc('wms_item_usage', { p_days: 90 }),
    ])
    setStock(st.filter(s => s.quantity > 0)); setNeg(st.filter(s => s.quantity < 0)); setItems(it)
    setLocs(new Map(lo.map(l => [l.code.toUpperCase(), l])))
    // Base reorder levels always load (existing behaviour). Target/lead-time columns + usage
    // are additive and only appear once db/2026-07-reorder-planning.sql has been run.
    const missing = (e: { message: string } | null) => !!e && /reorder_max|lead_time_days|wms_item_usage|column|function/i.test(e.message) && /does not exist|schema cache|could not find/i.test(e.message)
    setPlanMsg(missing(plan.error) || missing(use.error) ? 'For target (max) levels, supplier lead time and usage-driven suggestions, run db/2026-07-reorder-planning.sql in the Supabase SQL editor.' : '')
    const m = new Map<string, ItemSetting>()
    for (const s of se) m.set(s.item_code.toUpperCase(), { reorder_level: s.reorder_level, reorder_max: null, lead_time_days: null })
    for (const p of (plan.data as PlanRow[] | null) || []) { const k = p.item_code.toUpperCase(); const e = m.get(k) || { reorder_level: null, reorder_max: null, lead_time_days: null }; e.reorder_max = p.reorder_max; e.lead_time_days = p.lead_time_days; m.set(k, e) }
    setSettings(m)
    setUsage(new Map(((use.data as UsageRow[] | null) || []).map(u => [u.item_code.toUpperCase(), Number(u.avg_daily_use)])))
  }, [])

  const zoneOf = (code: string) => locs.get(code.toUpperCase())?.aisle || ''
  // Two-warehouse split: narrow stock to the chosen warehouse (GCH = description starts "GCH").
  const whStock = useMemo(() => stock.filter(s => passWh(wh, s.description)), [stock, wh])
  const toggleExp = (code: string) => setExpanded(s => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n })
  // The bin/batch lines that make up an item's on-hand (for the expand detail).
  const itemLines = (code: string) => whStock.filter(s => s.item_code === code).sort((a, b) => a.location_code.localeCompare(b.location_code) || (a.batch_no || '').localeCompare(b.batch_no || ''))
  const descByCode = useMemo(() => new Map(items.map(i => [i.code.toUpperCase(), i.description])), [items])
  const onHandByItem = useMemo(() => { const m = new Map<string, number>(); for (const s of whStock) m.set(s.item_code, clean((m.get(s.item_code) || 0) + Number(s.quantity))); return m }, [whStock])
  const onHandUpper = useMemo(() => { const m = new Map<string, number>(); for (const s of whStock) { const k = s.item_code.toUpperCase(); m.set(k, clean((m.get(k) || 0) + Number(s.quantity))) } return m }, [whStock])

  // Reorder planning for one item (UPPER code): usage-driven suggested reorder LEVEL =
  // avg daily use × lead-time days, falling back to the hand-entered reorder level when usage
  // or lead time is missing. Suggested order qty tops up to the target (max) when set, else to
  // the effective reorder level. LOW = on-hand at/below the effective reorder level.
  const planFor = useCallback((codeUpper: string) => {
    const s = settings.get(codeUpper) || { reorder_level: null, reorder_max: null, lead_time_days: null }
    const oh = onHandUpper.get(codeUpper) || 0
    const avg = usage.has(codeUpper) ? Number(usage.get(codeUpper)) : null
    const lead = s.lead_time_days ?? null
    const usageLevel = (avg != null && lead != null && avg > 0 && lead > 0) ? clean(avg * lead) : null
    const effLevel = usageLevel ?? s.reorder_level ?? null
    const target = s.reorder_max ?? null
    const suggestQty = target != null ? Math.max(0, clean(target - oh)) : (effLevel != null ? Math.max(0, clean(effLevel - oh)) : 0)
    const low = effLevel != null && oh <= effLevel
    return { s, oh, avg, lead, usageLevel, effLevel, target, suggestQty, low }
  }, [settings, usage, onHandUpper])

  // Build {headers, rows} for the current view.
  const report = useMemo((): { headers: string[]; rows: (string | number)[][] } => {
    if (view === 'item') {
      const m = new Map<string, { desc: string; qty: number; uom: string; bins: Set<string> }>()
      for (const s of whStock) { const e = m.get(s.item_code) || { desc: s.description || '', qty: 0, uom: s.uom || '', bins: new Set<string>() }; e.qty = clean(e.qty + Number(s.quantity)); e.bins.add(s.location_code); m.set(s.item_code, e) }
      return { headers: ['Item', 'Description', 'On-hand', 'Unit', 'Bins'], rows: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, v.desc, fmtQty(v.qty), v.uom, v.bins.size]) }
    }
    if (view === 'bin') return { headers: ['Bin', 'Type', 'Item', 'Batch', 'Expiry', 'Qty'], rows: whStock.slice().sort((a, b) => a.location_code.localeCompare(b.location_code) || a.item_code.localeCompare(b.item_code)).map(s => [s.location_code, locs.get(s.location_code.toUpperCase())?.location_type || '', s.item_code, s.batch_no, fmtDate(s.exp_date), fmtQty(s.quantity)]) }
    if (view === 'zone') {
      const m = new Map<string, { items: Set<string>; qty: number }>()
      for (const s of whStock) { const z = zoneOf(s.location_code) || '(none)'; const e = m.get(z) || { items: new Set<string>(), qty: 0 }; e.items.add(s.item_code); e.qty = clean(e.qty + Number(s.quantity)); m.set(z, e) }
      return { headers: ['Zone', 'Items', 'On-hand'], rows: [...m.entries()].sort().map(([k, v]) => [k, v.items.size, fmtQty(v.qty)]) }
    }
    if (view === 'batch') {
      const m = new Map<string, { desc: string; exp: string | null; qty: number }>()
      for (const s of whStock) { const k = `${s.item_code}|${s.batch_no}`; const e = m.get(k) || { desc: s.description || '', exp: s.exp_date, qty: 0 }; e.qty = clean(e.qty + Number(s.quantity)); m.set(k, e) }
      return { headers: ['Item', 'Batch', 'Expiry', 'On-hand'], rows: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k.split('|')[0], k.split('|')[1] || '—', fmtDate(v.exp), fmtQty(v.qty)]) }
    }
    if (view === 'aging') return { headers: ['Item', 'Bin', 'Batch', 'Qty', 'Age (days)', 'Bucket'], rows: whStock.map(s => ({ s, d: ageDays(s.created_at) })).sort((a, b) => b.d - a.d).map(({ s, d }) => [s.item_code, s.location_code, s.batch_no, fmtQty(s.quantity), d, ageBucket(d)]) }
    if (view === 'neg') return { headers: ['Item', 'Description', 'Bin', 'Batch', 'Qty'], rows: neg.filter(s => passWh(wh, s.description)).slice().sort((a, b) => a.quantity - b.quantity).map(s => [s.item_code, s.description || '', s.location_code, s.batch_no || '—', fmtQty(s.quantity)]) }
    // low stock — the reorder buy-list. Filter by the item's warehouse (from the item master).
    const rows: (string | number)[][] = []
    for (const [code, s] of settings.entries()) {
      if (s.reorder_level == null && s.reorder_max == null && s.lead_time_days == null) continue
      if (!passWh(wh, descByCode.get(code))) continue
      const p = planFor(code)
      rows.push([code, fmtQty(p.oh), p.s.reorder_level != null ? fmtQty(p.s.reorder_level) : '—', p.target != null ? fmtQty(p.target) : '—', p.avg != null ? fmtQty(p.avg) : '—', p.lead != null ? String(p.lead) : '—', p.suggestQty > 0 ? fmtQty(p.suggestQty) : '—', p.low ? 'LOW' : 'ok'])
    }
    return { headers: ['Item', 'On hand', 'Reorder level', 'Target (max)', 'Avg daily use', 'Lead time', 'Suggested order', 'Status'], rows: rows.sort((a, b) => (a[7] === 'LOW' ? 0 : 1) - (b[7] === 'LOW' ? 0 : 1) || String(a[0]).localeCompare(String(b[0]))) }
  }, [view, whStock, neg, locs, settings, planFor, onHandUpper, wh, descByCode])

  const filtered = useMemo(() => { const n = q.trim().toLowerCase(); return n ? report.rows.filter(r => r.some(c => String(c).toLowerCase().includes(n))) : report.rows }, [report, q])

  const numOrNull = (v: string) => v === '' ? null : Number(v)
  const intOrNull = (v: string) => v === '' ? null : Math.round(Number(v))
  async function saveSettings(code: string, patch: Partial<ItemSetting>) {
    if (!canEdit) return
    await supabase.from('wms_item_settings').upsert({ item_code: code, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'item_code' })
    setSettings(m => { const n = new Map(m); const k = code.toUpperCase(); n.set(k, { ...(n.get(k) || { reorder_level: null, reorder_max: null, lead_time_days: null }), ...patch }); return n })
  }
  async function addReorder() {
    const code = addItem.trim(); if (!code || !canEdit) return
    const patch: Partial<ItemSetting> = { reorder_level: numOrNull(addLevel) }
    if (!planMsg) { patch.reorder_max = numOrNull(addMax); patch.lead_time_days = intOrNull(addLead) }
    await saveSettings(code, patch); setAddItem(''); setAddLevel(''); setAddMax(''); setAddLead('')
  }
  // The reorder buy-list: only items at/below their effective reorder level, with a suggested
  // order qty (top up to the target/max when set, else to the reorder level). The buyer raises
  // the actual POs (per supplier) from this.
  function reorderListCsv() {
    const rows: (string | number)[][] = []
    for (const [code, s] of settings.entries()) {
      if (s.reorder_level == null && s.reorder_max == null && s.lead_time_days == null) continue
      if (!passWh(wh, descByCode.get(code))) continue
      const p = planFor(code)
      if (!p.low) continue
      rows.push([code, descByCode.get(code) || '', fmtQty(p.oh), p.s.reorder_level != null ? fmtQty(p.s.reorder_level) : '', p.target != null ? fmtQty(p.target) : '', p.avg != null ? fmtQty(p.avg) : '', p.lead != null ? String(p.lead) : '', p.suggestQty > 0 ? fmtQty(p.suggestQty) : ''])
    }
    rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    downloadCsv('Reorder_list.csv', ['Item', 'Description', 'On hand', 'Reorder level', 'Target (max)', 'Avg daily use', 'Lead time', 'Suggested order'], rows)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div><h1 className="text-2xl font-bold">Stock Reports</h1><p className="text-gray-500 text-sm mt-1">On-hand, aging and low-stock. <Link href="/wms/reports/stock-card" className="text-emerald-700 underline">Stock card</Link> · <Link href="/wms/reports/expiry" className="text-emerald-700 underline">Expiry alerts</Link> · <Link href="/wms/reports/activity" className="text-emerald-700 underline">Activity</Link> · <Link href="/wms/reports/adjustments" className="text-emerald-700 underline">Adjustments</Link> · <Link href="/wms/reports/counting" className="text-emerald-700 underline">Count by counter</Link> · <Link href="/wms/reports/batch" className="text-emerald-700 underline">Batch recall</Link> · <Link href="/wms/reports/negatives" className="text-red-600 underline">Negative stock</Link></p></div>
          <div className="flex items-center gap-2">
            {view === 'low' && <button onClick={reorderListCsv} className="border border-amber-300 text-amber-800 bg-amber-50 px-3 py-2 rounded-lg text-sm font-medium hover:bg-amber-100">🛒 Reorder list</button>}
            <button onClick={() => downloadCsv(`Stock_${view}.csv`, report.headers, filtered)} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {VIEWS.map(v => <button key={v.k} onClick={() => setView(v.k)} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${view === v.k ? 'bg-emerald-700 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'}`}>{v.label}</button>)}
        </div>

        {view === 'low' && planMsg && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 mb-4 text-sm">{planMsg}</div>
        )}

        {view === 'low' && canEdit && (
          <div className="bg-white rounded-xl border shadow-sm p-4 mb-4 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]"><label className="block text-xs text-gray-500 mb-1">Set reorder plan for an item</label><ItemPicker items={items} value={addItem} onPick={it => setAddItem(it.code)} /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Reorder level</label><input value={addLevel} onChange={e => setAddLevel(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="level" className="w-24 border rounded-lg px-3 py-2 text-sm text-right" inputMode="decimal" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Target (max)</label><input value={addMax} onChange={e => setAddMax(e.target.value.replace(/[^0-9.]/g, ''))} disabled={!!planMsg} placeholder="max" className="w-24 border rounded-lg px-3 py-2 text-sm text-right disabled:bg-gray-100" inputMode="decimal" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Lead time (days)</label><input value={addLead} onChange={e => setAddLead(e.target.value.replace(/[^0-9]/g, ''))} disabled={!!planMsg} placeholder="days" className="w-24 border rounded-lg px-3 py-2 text-sm text-right disabled:bg-gray-100" inputMode="numeric" /></div>
            <button onClick={addReorder} disabled={!addItem} className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">Save</button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          <WarehouseTabs value={wh} onChange={setWh} />
        </div>

        {/* Desktop: table */}
        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{report.headers.map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}{view === 'low' && canEdit && <th className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">Edit · level / max / lead</th>}</tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={report.headers.length + 1} className="text-center py-10 text-gray-400">No data.</td></tr>}
              {filtered.map((r, i) => {
                const code = String(r[0]); const isItem = view === 'item'; const open = isItem && expanded.has(code)
                return (
                <Fragment key={i}>
                  <tr onClick={isItem ? () => toggleExp(code) : undefined} className={`border-b last:border-0 hover:bg-gray-50 ${isItem ? 'cursor-pointer' : ''} ${(view === 'low' && r[7] === 'LOW') || view === 'neg' ? 'bg-red-50/40' : ''}`}>
                    {r.map((c, j) => (
                      <td key={j} className={`px-3 py-2 ${j === 0 ? 'font-mono font-medium' : 'tabular-nums'} ${view === 'low' && j === 7 && c === 'LOW' ? 'text-red-600 font-semibold' : ''}`}>
                        {isItem && j === 0 ? <span className="inline-flex items-center gap-1.5"><span className="text-gray-400 text-xs">{open ? '▾' : '▸'}</span>{c}</span> : c}
                      </td>
                    ))}
                    {view === 'low' && canEdit && (() => { const st = settings.get(String(r[0]).toUpperCase()); return (
                      <td className="px-3 py-2"><div className="flex items-center gap-1 justify-end">
                        <input title="Reorder level" defaultValue={st?.reorder_level ?? ''} onBlur={e => saveSettings(String(r[0]), { reorder_level: numOrNull(e.target.value.replace(/[^0-9.]/g, '')) })} className="w-16 border rounded px-1.5 py-1 text-xs text-right" placeholder="lvl" />
                        <input title="Target (max)" defaultValue={st?.reorder_max ?? ''} disabled={!!planMsg} onBlur={e => saveSettings(String(r[0]), { reorder_max: numOrNull(e.target.value.replace(/[^0-9.]/g, '')) })} className="w-16 border rounded px-1.5 py-1 text-xs text-right disabled:bg-gray-100" placeholder="max" />
                        <input title="Lead time (days)" defaultValue={st?.lead_time_days ?? ''} disabled={!!planMsg} onBlur={e => saveSettings(String(r[0]), { lead_time_days: intOrNull(e.target.value.replace(/[^0-9]/g, '')) })} className="w-16 border rounded px-1.5 py-1 text-xs text-right disabled:bg-gray-100" placeholder="days" />
                      </div></td>
                    ) })()}
                  </tr>
                  {open && (
                    <tr className="bg-gray-50/60"><td colSpan={report.headers.length} className="px-6 py-2">
                      <table className="w-full text-xs">
                        <thead className="text-gray-500"><tr>{['Bin', 'Batch', 'Expiry', 'Qty'].map(h => <th key={h} className={`font-medium py-1 ${h === 'Qty' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
                        <tbody>
                          {itemLines(code).map((s, k) => (
                            <tr key={k}>
                              <td className="font-mono py-0.5">{s.location_code === 'PENDING' ? <span className="bg-amber-100 text-amber-800 rounded px-1 font-semibold">📦 PENDING</span> : s.location_code}</td>
                              <td className="font-mono">{s.batch_no || '—'}</td>
                              <td>{fmtDate(s.exp_date) || '—'}</td>
                              <td className="text-right tabular-nums font-medium">{fmtQty(s.quantity)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              )})}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per row, so long descriptions read on their own line */}
        <div className="sm:hidden space-y-2">
          {filtered.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No data.</div>}
          {filtered.map((r, i) => (
            <div key={i} className={`bg-white rounded-xl border shadow-sm p-3 ${(view === 'low' && r[7] === 'LOW') || view === 'neg' ? 'border-red-200 bg-red-50/50' : ''}`}>
              <div className="font-mono font-semibold text-sm mb-1.5">{r[0]}</div>
              <div className="space-y-1">
                {r.map((c, j) => j === 0 ? null : (
                  report.headers[j] === 'Description'
                    ? <div key={j} className="text-sm text-gray-700 leading-snug">{c}</div>
                    : <div key={j} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-gray-500 text-xs">{report.headers[j]}</span>
                        <span className={`tabular-nums font-medium text-right ${view === 'low' && j === 7 && c === 'LOW' ? 'text-red-600 font-semibold' : ''}`}>{c}</span>
                      </div>
                ))}
                {view === 'low' && canEdit && (() => { const st = settings.get(String(r[0]).toUpperCase()); return (
                  <div className="pt-1.5 mt-1 border-t space-y-1.5">
                    <div className="flex items-center justify-between gap-3"><span className="text-gray-500 text-xs">Reorder level</span><input defaultValue={st?.reorder_level ?? ''} onBlur={e => saveSettings(String(r[0]), { reorder_level: numOrNull(e.target.value.replace(/[^0-9.]/g, '')) })} className="w-24 border rounded px-2 py-1 text-xs text-right" placeholder="level" /></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-gray-500 text-xs">Target (max)</span><input defaultValue={st?.reorder_max ?? ''} disabled={!!planMsg} onBlur={e => saveSettings(String(r[0]), { reorder_max: numOrNull(e.target.value.replace(/[^0-9.]/g, '')) })} className="w-24 border rounded px-2 py-1 text-xs text-right disabled:bg-gray-100" placeholder="max" /></div>
                    <div className="flex items-center justify-between gap-3"><span className="text-gray-500 text-xs">Lead time (days)</span><input defaultValue={st?.lead_time_days ?? ''} disabled={!!planMsg} onBlur={e => saveSettings(String(r[0]), { lead_time_days: intOrNull(e.target.value.replace(/[^0-9]/g, '')) })} className="w-24 border rounded px-2 py-1 text-xs text-right disabled:bg-gray-100" placeholder="days" /></div>
                  </div>
                ) })()}
              </div>
              {view === 'item' && (
                <button onClick={() => toggleExp(String(r[0]))} className="text-xs text-emerald-700 hover:underline mt-2">{expanded.has(String(r[0])) ? '▾ Hide bins & batches' : '▸ Show bins & batches'}</button>
              )}
              {view === 'item' && expanded.has(String(r[0])) && (
                <div className="mt-2 border-t pt-2 space-y-1">
                  {itemLines(String(r[0])).map((s, k) => (
                    <div key={k} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">{s.location_code === 'PENDING' ? <span className="bg-amber-100 text-amber-800 rounded px-1 font-semibold">📦 PENDING</span> : <span className="font-mono">{s.location_code}</span>}<span className="text-gray-400"> · {s.batch_no || '—'}</span>{s.exp_date ? <span className="text-gray-400"> · exp {fmtDate(s.exp_date)}</span> : ''}</span>
                      <span className="tabular-nums font-medium shrink-0">{fmtQty(s.quantity)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-3">{filtered.length} rows{view === 'aging' ? ' · age = time since the lot landed in its bin' : ''}{view === 'neg' ? ' · a negative bin means more was taken out than the system had — reconcile it with a stock count' : ''}.</p>
      </div>
    </div>
  )
}
