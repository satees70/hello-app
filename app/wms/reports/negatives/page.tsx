'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

// Every negative on-hand across BOTH stock ledgers, in one place — so the discrepancies that
// Head Office allowed (fill-now / reconciliation to-do) stay visible until a count clears them.
//   • wms_stock  — WMS bin-level on-hand (a bin picked below zero)
//   • item_stock — factory / raw-material on-hand (read via the item_stock_negatives() RPC)
interface Bin { item_code: string; description: string | null; warehouse_code: string; location_code: string; batch_no: string | null; exp_date: string | null; quantity: number; uom: string | null }
interface Fac { item_code: string; description: string | null; factory_code: string; quantity: number; looks_produced: boolean }

const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 2 })
const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'
function csv(name: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const body = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n')
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' })); a.download = name; a.click(); URL.revokeObjectURL(a.href)
}

export default function WmsNegativeStockPage() {
  const { profile, loading } = useProfile()
  const [bins, setBins] = useState<Bin[]>([])
  const [facs, setFacs] = useState<Fac[]>([])
  const [q, setQ] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(true)

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    const [b, f] = await Promise.all([
      supabase.from('wms_stock').select('item_code, description, warehouse_code, location_code, batch_no, exp_date, quantity, uom').lt('quantity', 0).order('quantity', { ascending: true }),
      supabase.rpc('item_stock_negatives'),
    ])
    if (b.error) setErr(b.error.message)
    setBins((b.data as Bin[]) || [])
    // The RPC is HO/own-factory gated; if it's missing, guide to the migration rather than error out.
    if (f.error && !/item_stock_negatives|does not exist|schema cache|could not find/i.test(f.error.message)) setErr(e => e || f.error!.message)
    setFacs((f.data as Fac[]) || [])
    setBusy(false)
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  const ql = q.trim().toLowerCase()
  const binF = useMemo(() => bins.filter(r => !ql || `${r.item_code} ${r.description ?? ''} ${r.location_code}`.toLowerCase().includes(ql)), [bins, ql])
  const facF = useMemo(() => facs.filter(r => !ql || `${r.item_code} ${r.description ?? ''} ${r.factory_code}`.toLowerCase().includes(ql)), [facs, ql])
  const binTot = binF.reduce((s, r) => s + Number(r.quantity || 0), 0)
  const facTot = facF.reduce((s, r) => s + Number(r.quantity || 0), 0)

  function exportCsv() {
    const rows: (string | number)[][] = [
      ...binF.map(r => ['WMS bin', r.item_code, r.description ?? '', `${r.warehouse_code}/${r.location_code}`, r.batch_no ?? '', fmtDate(r.exp_date), r.quantity]),
      ...facF.map(r => ['Factory', r.item_code, r.description ?? '', r.factory_code, r.looks_produced ? 'produced' : 'raw material', '', r.quantity]),
    ]
    csv('Negative_stock.csv', ['Ledger', 'Item', 'Description', 'Where', 'Batch / kind', 'Exp', 'Qty'], rows)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
          <h1 className="text-2xl font-bold">Negative stock</h1>
          <div className="flex items-center gap-2">
            <button onClick={load} className="text-sm text-emerald-700 hover:underline">↻ Refresh</button>
            <Link href="/wms/reports" className="text-sm text-emerald-700 hover:underline">← Reports</Link>
          </div>
        </div>
        <p className="text-gray-500 text-sm mb-4">Everywhere on-hand has gone below zero — the discrepancies to clear with a stock count. A WMS bin goes negative when stock is picked/filled beyond what the system had (e.g. Head Office &ldquo;Fill now&rdquo;); a factory item goes negative when more was used than the system recorded.</p>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-white rounded-xl border shadow-sm p-4"><div className="text-xs text-gray-500">WMS bins below zero</div><div className="text-2xl font-bold text-red-600 tabular-nums">{binF.length}</div><div className="text-xs text-gray-400 tabular-nums">net {fmtQty(binTot)}</div></div>
          <div className="bg-white rounded-xl border shadow-sm p-4"><div className="text-xs text-gray-500">Factory items below zero</div><div className="text-2xl font-bold text-red-600 tabular-nums">{facF.length}</div><div className="text-xs text-gray-400 tabular-nums">net {fmtQty(facTot)}</div></div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item, bin or factory…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          <button onClick={exportCsv} disabled={binF.length + facF.length === 0} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">⬇ CSV</button>
        </div>

        {err && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

        {/* WMS bins */}
        <h2 className="font-semibold text-gray-700 mb-2">WMS bins <span className="text-gray-400 font-normal text-sm">({binF.length})</span></h2>
        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Item', 'Description', 'Bin', 'Batch', 'Exp', 'Qty'].map(h => <th key={h} className={`px-3 py-2 font-medium whitespace-nowrap ${h === 'Qty' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {busy && binF.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">Loading…</td></tr>}
              {!busy && binF.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No WMS bins below zero. 🎉</td></tr>}
              {binF.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{r.item_code}</td>
                  <td className="px-3 py-2 max-w-[16rem] truncate" title={r.description || ''}>{r.description || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.warehouse_code}/{r.location_code}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.batch_no || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{fmtDate(r.exp_date)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-600">{fmtQty(r.quantity)}{r.uom ? <span className="text-gray-400 font-normal"> {r.uom}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Factory / raw-material item_stock */}
        <h2 className="font-semibold text-gray-700 mb-2">Factory on-hand <span className="text-gray-400 font-normal text-sm">({facF.length})</span></h2>
        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Item', 'Description', 'Factory', 'Kind', 'Qty'].map(h => <th key={h} className={`px-3 py-2 font-medium whitespace-nowrap ${h === 'Qty' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {busy && facF.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">Loading…</td></tr>}
              {!busy && facF.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">No factory items below zero. 🎉</td></tr>}
              {facF.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{r.item_code}</td>
                  <td className="px-3 py-2 max-w-[16rem] truncate" title={r.description || ''}>{r.description || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.factory_code}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className={`text-xs px-2 py-0.5 rounded-full ${r.looks_produced ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>{r.looks_produced ? 'produced' : 'raw material'}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-600">{fmtQty(r.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">Fix a factory item in <b>Packing → Stock</b> (set the counted quantity — it&rsquo;s audited). A WMS bin is corrected by a stock count (Warehouse → Counts) or a putaway that brings the real stock in.</p>
      </div>
    </div>
  )
}
