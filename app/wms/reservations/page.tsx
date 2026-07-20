'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

// Stale reservations: orders that reserved stock but were never picked, so their reservation
// silently locks physical stock away from every other order. Head Office can see them here
// (even the ones hidden past the Orders list's 100-row limit) and release them.
interface Row {
  order_id: string; order_no: string | null; status: string; customer_name: string | null; source: string | null
  created_at: string; pick_started_at: string | null; assigned_to_name: string | null
  reserved_lines: number; reserved_qty: number; reserved_since: string; picked_any: boolean
}
const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 2 })
const ageDays = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const HOURS = [{ h: 24, l: '1 day' }, { h: 48, l: '2 days' }, { h: 72, l: '3 days' }, { h: 168, l: '7 days' }]

export default function WmsReservationsPage() {
  const { profile, loading } = useProfile()
  const canRelease = !!profile && (profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')
  const [hours, setHours] = useState(48)
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    const { data, error } = await supabase.rpc('wms_stale_reserved_orders', { p_hours: hours })
    if (error) { setErr(/wms_stale_reserved_orders|does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-stale-reservations.sql in the Supabase SQL editor.' : error.message); setRows([]); return }
    setRows((data as Row[]) || [])
  }, [hours])
  useEffect(() => { if (profile) load() }, [profile, load])

  async function release(r: Row) {
    if (!canRelease) return
    const warn = r.picked_any ? '\n\n⚠ This order already has SOME stock picked — releasing will cancel it and lose that picking progress.' : ''
    if (!confirm(`Release the stock held by ${r.order_no || 'this order'} and cancel it?\n\nIt has ${r.reserved_lines} reserved line(s) (${fmtQty(r.reserved_qty)} qty) locked since ${fmtWhen(r.reserved_since)}.${warn}`)) return
    setBusy(r.order_id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_release_order', { p_order_id: r.order_id })
    setBusy('')
    if (error) { setErr(error.message); return }
    setMsg(`Released ${r.order_no || 'order'} — its reserved stock is now free to pick.`)
    setRows(rs => rs.filter(x => x.order_id !== r.order_id))
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  const totalQty = rows.reduce((s, r) => s + Number(r.reserved_qty || 0), 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Stale reservations</h1>
          <Link href="/wms" className="text-sm text-emerald-700 hover:underline">← Warehouse home</Link>
        </div>
        <p className="text-gray-500 text-sm mb-4">Orders that reserved stock but were never picked. Their reservation locks the stock away from every other order — so items show &ldquo;no stock&rdquo; even when they&rsquo;re physically on the shelf. Release the dead ones to free the stock.</p>

        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <span className="text-gray-500">Untouched for at least:</span>
          <select value={hours} onChange={e => setHours(Number(e.target.value))} className="border rounded-lg px-3 py-1.5">
            {HOURS.map(o => <option key={o.h} value={o.h}>{o.l}</option>)}
          </select>
          <button onClick={load} className="text-emerald-700 hover:underline text-xs">↻ Refresh</button>
          {rows.length > 0 && <span className="sm:ml-auto text-xs text-gray-500">{rows.length} order(s) locking <b className="text-gray-700">{fmtQty(totalQty)}</b> qty</span>}
        </div>

        {err && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}
        {msg && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {msg}</div>}
        {!canRelease && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm px-3 py-2">You can view this list, but only Head Office can release a reservation.</div>}

        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500">
              <tr>{['Order', 'Status', 'Customer', 'Reserved since', 'Lines', 'Qty locked', 'Picked?', ''].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-gray-400">No stale reservations — nothing locked past this age. 🎉</td></tr>}
              {rows.map(r => (
                <tr key={r.order_id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{r.order_no || r.order_id.slice(0, 8)}{r.source ? <span className="block text-[10px] text-gray-400">{r.source}</span> : null}</td>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-700">{r.status}</span></td>
                  <td className="px-3 py-2 max-w-[12rem] truncate" title={r.customer_name || ''}>{r.customer_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{fmtWhen(r.reserved_since)}<span className={`block ${ageDays(r.reserved_since) >= 3 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>{ageDays(r.reserved_since)}d ago</span></td>
                  <td className="px-3 py-2 tabular-nums">{r.reserved_lines}</td>
                  <td className="px-3 py-2 tabular-nums font-medium">{fmtQty(r.reserved_qty)}</td>
                  <td className="px-3 py-2">{r.picked_any ? <span className="text-amber-600 text-xs font-medium">⚠ some picked</span> : <span className="text-gray-400 text-xs">none</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {canRelease && <button onClick={() => release(r)} disabled={busy === r.order_id} className="text-xs bg-emerald-700 text-white rounded-lg px-3 py-1.5 hover:bg-emerald-800 disabled:opacity-50 font-medium">{busy === r.order_id ? 'Releasing…' : 'Release stock'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">Releasing frees the reserved stock and cancels the order (same as the app&rsquo;s Cancel, but reachable and recorded). If a customer still needs a released order, upload/re-create it fresh.</p>
      </div>
    </div>
  )
}
