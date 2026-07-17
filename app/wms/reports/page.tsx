'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
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

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const ageDays = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000))
const ageBucket = (d: number) => d <= 30 ? '0–30d' : d <= 60 ? '31–60d' : d <= 90 ? '61–90d' : '90d+'

type View = 'item' | 'bin' | 'zone' | 'batch' | 'aging' | 'low'
const VIEWS: { k: View; label: string }[] = [
  { k: 'item', label: 'On-hand by item' }, { k: 'bin', label: 'By bin' }, { k: 'zone', label: 'By zone' },
  { k: 'batch', label: 'By batch' }, { k: 'aging', label: 'Stock aging' }, { k: 'low', label: 'Low stock' },
]

export default function StockReportsPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [stock, setStock] = useState<Stock[]>([])
  const [locs, setLocs] = useState<Map<string, Loc>>(new Map())
  const [items, setItems] = useState<Item[]>([])
  const [reorder, setReorder] = useState<Map<string, number | null>>(new Map())
  const [view, setView] = useState<View>('item')
  const [q, setQ] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [addItem, setAddItem] = useState(''); const [addLevel, setAddLevel] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  const load = useCallback(async () => {
    const [st, lo, it, se] = await Promise.all([
      fetchAll<Stock>('wms_stock', 'item_code, description, location_code, batch_no, exp_date, quantity, uom, created_at'),
      fetchAll<Loc>('wms_locations', 'code, aisle, location_type'),
      fetchAll<Item>('items', 'code, description, unit', 'code'),
      fetchAll<Setting>('wms_item_settings', 'item_code, reorder_level'),
    ])
    setStock(st.filter(s => s.quantity > 0)); setItems(it)
    setLocs(new Map(lo.map(l => [l.code.toUpperCase(), l])))
    setReorder(new Map(se.map(s => [s.item_code.toUpperCase(), s.reorder_level])))
  }, [])

  const zoneOf = (code: string) => locs.get(code.toUpperCase())?.aisle || ''
  // Two-warehouse split: narrow stock to the chosen warehouse (GCH = description starts "GCH").
  const whStock = useMemo(() => stock.filter(s => passWh(wh, s.description)), [stock, wh])
  const descByCode = useMemo(() => new Map(items.map(i => [i.code.toUpperCase(), i.description])), [items])
  const onHandByItem = useMemo(() => { const m = new Map<string, number>(); for (const s of whStock) m.set(s.item_code, clean((m.get(s.item_code) || 0) + Number(s.quantity))); return m }, [whStock])
  const onHandUpper = useMemo(() => { const m = new Map<string, number>(); for (const s of whStock) { const k = s.item_code.toUpperCase(); m.set(k, clean((m.get(k) || 0) + Number(s.quantity))) } return m }, [whStock])

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
    // low stock — filter by the item's warehouse (from the item master description)
    const rows: (string | number)[][] = []
    for (const [code, lvl] of reorder.entries()) { if (lvl == null) continue; if (!passWh(wh, descByCode.get(code.toUpperCase()))) continue; const oh = onHandUpper.get(code) || 0; rows.push([code, fmtQty(oh), fmtQty(lvl), oh <= lvl ? 'LOW' : 'ok']) }
    return { headers: ['Item', 'On-hand', 'Reorder level', 'Status'], rows: rows.sort((a, b) => (a[3] === 'LOW' ? 0 : 1) - (b[3] === 'LOW' ? 0 : 1) || String(a[0]).localeCompare(String(b[0]))) }
  }, [view, whStock, locs, reorder, onHandUpper, wh, descByCode])

  const filtered = useMemo(() => { const n = q.trim().toLowerCase(); return n ? report.rows.filter(r => r.some(c => String(c).toLowerCase().includes(n))) : report.rows }, [report, q])

  async function saveReorder(code: string, val: string) {
    if (!canEdit) return
    const lvl = val === '' ? null : Number(val)
    await supabase.from('wms_item_settings').upsert({ item_code: code, reorder_level: lvl, updated_at: new Date().toISOString() }, { onConflict: 'item_code' })
    setReorder(m => new Map(m).set(code.toUpperCase(), lvl))
  }
  async function addReorder() {
    const code = addItem.trim(); if (!code || !canEdit) return
    await saveReorder(code, addLevel); setAddItem(''); setAddLevel('')
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div><h1 className="text-2xl font-bold">Stock Reports</h1><p className="text-gray-500 text-sm mt-1">On-hand, aging and low-stock. <Link href="/wms/reports/stock-card" className="text-emerald-700 underline">Stock card</Link> · <Link href="/wms/reports/expiry" className="text-emerald-700 underline">Expiry alerts</Link> · <Link href="/wms/reports/activity" className="text-emerald-700 underline">Activity</Link> · <Link href="/wms/reports/adjustments" className="text-emerald-700 underline">Adjustments</Link> · <Link href="/wms/reports/counting" className="text-emerald-700 underline">Count by counter</Link></p></div>
          <button onClick={() => downloadCsv(`Stock_${view}.csv`, report.headers, filtered)} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {VIEWS.map(v => <button key={v.k} onClick={() => setView(v.k)} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${view === v.k ? 'bg-emerald-700 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'}`}>{v.label}</button>)}
        </div>

        {view === 'low' && canEdit && (
          <div className="bg-white rounded-xl border shadow-sm p-4 mb-4 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px]"><label className="block text-xs text-gray-500 mb-1">Set reorder level for an item</label><ItemPicker items={items} value={addItem} onPick={it => setAddItem(it.code)} /></div>
            <input value={addLevel} onChange={e => setAddLevel(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="level" className="w-28 border rounded-lg px-3 py-2 text-sm text-right" inputMode="decimal" />
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
            <thead className="bg-gray-50 border-b"><tr>{report.headers.map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}{view === 'low' && canEdit && <th className="px-3 py-2.5" />}</tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={report.headers.length + 1} className="text-center py-10 text-gray-400">No data.</td></tr>}
              {filtered.map((r, i) => (
                <tr key={i} className={`border-b last:border-0 hover:bg-gray-50 ${view === 'low' && r[3] === 'LOW' ? 'bg-red-50/40' : ''}`}>
                  {r.map((c, j) => (
                    <td key={j} className={`px-3 py-2 ${j === 0 ? 'font-mono font-medium' : 'tabular-nums'} ${view === 'low' && j === 3 && c === 'LOW' ? 'text-red-600 font-semibold' : ''}`}>{c}</td>
                  ))}
                  {view === 'low' && canEdit && <td className="px-3 py-2"><input defaultValue={String(r[2] === '—' ? '' : r[2]).replace(/,/g, '')} onBlur={e => saveReorder(String(r[0]), e.target.value.replace(/[^0-9.]/g, ''))} className="w-20 border rounded px-2 py-1 text-xs text-right" placeholder="level" /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per row, so long descriptions read on their own line */}
        <div className="sm:hidden space-y-2">
          {filtered.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No data.</div>}
          {filtered.map((r, i) => (
            <div key={i} className={`bg-white rounded-xl border shadow-sm p-3 ${view === 'low' && r[3] === 'LOW' ? 'border-red-200 bg-red-50/50' : ''}`}>
              <div className="font-mono font-semibold text-sm mb-1.5">{r[0]}</div>
              <div className="space-y-1">
                {r.map((c, j) => j === 0 ? null : (
                  report.headers[j] === 'Description'
                    ? <div key={j} className="text-sm text-gray-700 leading-snug">{c}</div>
                    : <div key={j} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-gray-500 text-xs">{report.headers[j]}</span>
                        <span className={`tabular-nums font-medium text-right ${view === 'low' && j === 3 && c === 'LOW' ? 'text-red-600 font-semibold' : ''}`}>{c}</span>
                      </div>
                ))}
                {view === 'low' && canEdit && (
                  <div className="flex items-center justify-between gap-3 pt-1.5 mt-1 border-t">
                    <span className="text-gray-500 text-xs">Reorder level</span>
                    <input defaultValue={String(r[2] === '—' ? '' : r[2]).replace(/,/g, '')} onBlur={e => saveReorder(String(r[0]), e.target.value.replace(/[^0-9.]/g, ''))} className="w-24 border rounded px-2 py-1 text-xs text-right" placeholder="level" />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-3">{filtered.length} rows{view === 'aging' ? ' · age = time since the lot landed in its bin' : ''}.</p>
      </div>
    </div>
  )
}
