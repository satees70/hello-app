'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

// WMS bin-level on-hand that has gone below zero — the warehouse discrepancies to clear with a
// stock count. This is the WMS ledger ONLY (wms_stock); factory / raw-material on-hand
// (item_stock) is a separate entity and is not shown here.
interface Bin { item_code: string; description: string | null; warehouse_code: string; location_code: string; batch_no: string | null; exp_date: string | null; quantity: number; uom: string | null }

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
  const [q, setQ] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(true)

  const load = useCallback(async () => {
    setBusy(true); setErr('')
    const { data, error } = await supabase.from('wms_stock')
      .select('item_code, description, warehouse_code, location_code, batch_no, exp_date, quantity, uom')
      .lt('quantity', 0).order('quantity', { ascending: true })
    if (error) setErr(error.message)
    setBins((data as Bin[]) || [])
    setBusy(false)
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  const ql = q.trim().toLowerCase()
  const rows = useMemo(() => bins.filter(r => !ql || `${r.item_code} ${r.description ?? ''} ${r.location_code}`.toLowerCase().includes(ql)), [bins, ql])
  const total = rows.reduce((s, r) => s + Number(r.quantity || 0), 0)

  function exportCsv() {
    csv('WMS_negative_stock.csv', ['Item', 'Description', 'Warehouse', 'Bin', 'Batch', 'Exp', 'Qty', 'UOM'],
      rows.map(r => [r.item_code, r.description ?? '', r.warehouse_code, r.location_code, r.batch_no ?? '', fmtDate(r.exp_date), r.quantity, r.uom ?? '']))
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
          <h1 className="text-2xl font-bold">Negative stock <span className="text-gray-400 font-normal text-lg">(warehouse)</span></h1>
          <div className="flex items-center gap-2">
            <button onClick={load} className="text-sm text-emerald-700 hover:underline">↻ Refresh</button>
            <Link href="/wms/reports" className="text-sm text-emerald-700 hover:underline">← Reports</Link>
          </div>
        </div>
        <p className="text-gray-500 text-sm mb-4">WMS bins that have gone below zero — the warehouse discrepancies to clear with a stock count. A bin goes negative when stock is picked or filled beyond what the system had (e.g. Head Office &ldquo;Fill now&rdquo;). This is the warehouse ledger only; factory / production on-hand is tracked separately.</p>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="bg-white rounded-xl border shadow-sm px-4 py-3">
            <div className="text-xs text-gray-500">Bins below zero</div>
            <div className="text-2xl font-bold text-red-600 tabular-nums">{rows.length}<span className="text-sm text-gray-400 font-normal"> · net {fmtQty(total)}</span></div>
          </div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item or bin…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          <button onClick={exportCsv} disabled={rows.length === 0} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">⬇ CSV</button>
        </div>

        {err && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}

        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Item', 'Description', 'Bin', 'Batch', 'Exp', 'Qty'].map(h => <th key={h} className={`px-3 py-2 font-medium whitespace-nowrap ${h === 'Qty' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {busy && rows.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-gray-400">Loading…</td></tr>}
              {!busy && rows.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-gray-400">No warehouse bins below zero. 🎉</td></tr>}
              {rows.map((r, i) => (
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
        <p className="text-xs text-gray-400 mt-3">A bin is corrected by a stock count (Warehouse → Counts) or a putaway that brings the real stock in — both audited.</p>
      </div>
    </div>
  )
}
