'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

interface PO { id: string; po_number: string | null; supplier_name: string | null; status: string; expected_date: string | null; wms_po_lines?: { count: number }[] }
interface Ord { id: string; order_no: string | null; customer_name: string | null; status: string; delivery_date: string | null; wms_order_lines?: { count: number }[] }
interface Pend { id: string; item_code: string; description: string | null; batch_no: string; quantity: number }
interface Move { id: string; move_type: string; item_code: string; from_location_code: string | null; to_location_code: string | null; quantity: number; moved_by_name: string | null; created_at: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const STATUS_CHIP: Record<string, string> = {
  Open: 'bg-amber-100 text-amber-700', 'Partially Received': 'bg-blue-100 text-blue-700', Review: 'bg-amber-100 text-amber-700',
  Released: 'bg-emerald-100 text-emerald-700', Picking: 'bg-blue-100 text-blue-700', Fulfilled: 'bg-emerald-100 text-emerald-700', Picked: 'bg-emerald-100 text-emerald-700',
}
const MOVE_CHIP: Record<string, string> = { receipt: 'bg-sky-100 text-sky-700', putaway: 'bg-emerald-100 text-emerald-700', pick: 'bg-blue-100 text-blue-700', transfer: 'bg-violet-100 text-violet-700', adjust: 'bg-amber-100 text-amber-700' }

export default function WmsHome() {
  const { profile, loading } = useProfile()
  const [pos, setPos] = useState<PO[]>([]); const [orders, setOrders] = useState<Ord[]>([])
  const [pending, setPending] = useState<Pend[]>([]); const [moves, setMoves] = useState<Move[]>([])
  const [counts, setCounts] = useState({ po: 0, ord: 0, pend: 0, pendQty: 0 })
  const [alerts, setAlerts] = useState({ expired: 0, near: 0, low: 0, disc: 0 })

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [poRes, ordRes, pendRes, mvRes, poCount, ordCount] = await Promise.all([
      supabase.from('wms_purchase_orders').select('id, po_number, supplier_name, status, expected_date, wms_po_lines(count)').in('status', ['Open', 'Partially Received']).order('created_at', { ascending: false }).limit(6),
      supabase.from('wms_orders').select('id, order_no, customer_name, status, delivery_date, wms_order_lines(count)').in('status', ['Review', 'Released', 'Picking']).order('created_at', { ascending: false }).limit(6),
      supabase.from('wms_stock').select('id, item_code, description, batch_no, quantity').eq('location_code', 'GOODS-IN').gt('quantity', 0).order('item_code').limit(50),
      supabase.from('wms_stock_moves').select('id, move_type, item_code, from_location_code, to_location_code, quantity, moved_by_name, created_at').order('created_at', { ascending: false }).limit(8),
      supabase.from('wms_purchase_orders').select('id', { count: 'exact', head: true }).in('status', ['Open', 'Partially Received']),
      supabase.from('wms_orders').select('id', { count: 'exact', head: true }).in('status', ['Review', 'Released', 'Picking']),
    ])
    const pend = (pendRes.data as Pend[]) || []
    setPos((poRes.data as PO[]) || []); setOrders((ordRes.data as Ord[]) || []); setPending(pend); setMoves((mvRes.data as Move[]) || [])
    setCounts({ po: poCount.count ?? 0, ord: ordCount.count ?? 0, pend: pend.length, pendQty: clean(pend.reduce((s, r) => s + Number(r.quantity || 0), 0)) })

    // Alerts: expired / near-expiry (30d) / low-stock / count discrepancies
    const todayISO = new Date().toISOString().slice(0, 10)
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const [expC, nearC, settings, stockQ, discRes] = await Promise.all([
      supabase.from('wms_stock').select('id', { count: 'exact', head: true }).lt('exp_date', todayISO).gt('quantity', 0),
      supabase.from('wms_stock').select('id', { count: 'exact', head: true }).gte('exp_date', todayISO).lte('exp_date', in30).gt('quantity', 0),
      fetchAll<{ item_code: string; reorder_level: number | null }>('wms_item_settings', 'item_code, reorder_level'),
      fetchAll<{ item_code: string; quantity: number }>('wms_stock', 'item_code, quantity'),
      supabase.from('wms_count_lines').select('expected_qty, counted_qty, is_unexpected').not('counted_qty', 'is', null).limit(1000),
    ])
    const oh = new Map<string, number>()
    for (const s of stockQ) { const k = s.item_code.toUpperCase(); oh.set(k, (oh.get(k) || 0) + Number(s.quantity)) }
    let low = 0
    for (const st of settings) { if (st.reorder_level == null) continue; if ((oh.get(st.item_code.toUpperCase()) || 0) <= st.reorder_level) low++ }
    let disc = 0
    for (const l of ((discRes.data as { expected_qty: number; counted_qty: number; is_unexpected: boolean }[]) || [])) { if (l.is_unexpected || Number(l.counted_qty) !== Number(l.expected_qty)) disc++ }
    setAlerts({ expired: expC.count ?? 0, near: nearC.count ?? 0, low, disc })
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Warehouse — today</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">Hello{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''} — here’s what needs doing.</p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Tile href="/wms/purchase-orders" n={counts.po} label="POs to receive" accent="text-amber-600" />
          <Tile href="/wms/orders" n={counts.ord} label="Orders to pick" accent="text-blue-600" />
          <Tile href="/wms/putaway" n={counts.pend} label="Pending putaway" accent="text-emerald-700" />
          <Tile href="/wms/stock" n={counts.pendQty} label="Qty in goods-in" accent="text-gray-500" isQty />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <Tile href="/wms/reports/expiry" n={alerts.expired} label="Expired lots" accent="text-red-600" />
          <Tile href="/wms/reports/expiry" n={alerts.near} label="Near expiry (30d)" accent="text-amber-600" />
          <Tile href="/wms/reports" n={alerts.low} label="Low stock" accent="text-orange-600" />
          <Tile href="/wms/reports/activity" n={alerts.disc} label="Count discrepancies" accent="text-violet-600" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          <Panel title="To receive" href="/wms/purchase-orders" cta="All purchase orders">
            {pos.length === 0 ? <Empty text="No open purchase orders." /> : pos.map(o => (
              <Link key={o.id} href={`/wms/receive/${o.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-gray-50 border-b last:border-0">
                <div className="min-w-0"><div className="font-mono text-sm font-medium truncate">{o.po_number || '(no number)'}</div><div className="text-xs text-gray-500 truncate">{o.supplier_name || '—'}{o.expected_date ? ` · exp ${o.expected_date}` : ''}</div></div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[o.status] || 'bg-gray-100'}`}>{o.status}</span>
              </Link>
            ))}
          </Panel>

          <Panel title="To pick" href="/wms/orders" cta="All orders">
            {orders.length === 0 ? <Empty text="No orders waiting to pick." /> : orders.map(o => (
              <Link key={o.id} href={`/wms/pick/${o.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-gray-50 border-b last:border-0">
                <div className="min-w-0"><div className="font-mono text-sm font-medium truncate">{o.order_no || '(no number)'}</div><div className="text-xs text-gray-500 truncate">{o.customer_name || '—'}{o.delivery_date ? ` · deliver ${o.delivery_date}` : ''}</div></div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[o.status] || 'bg-gray-100'}`}>{o.status}</span>
              </Link>
            ))}
          </Panel>
        </div>

        <Panel title={`Pending putaway${counts.pend ? ` (${counts.pend})` : ''}`} href="/wms/putaway" cta="Go to putaway">
          {pending.length === 0 ? <Empty text="Nothing waiting to be shelved." /> : pending.slice(0, 6).map(p => (
            <div key={p.id} className="flex items-center justify-between gap-2 px-4 py-2.5 border-b last:border-0">
              <div className="min-w-0"><span className="font-mono text-sm font-medium">{p.item_code}</span> <span className="text-xs text-gray-500 truncate">{p.description}{p.batch_no ? ` · b:${p.batch_no}` : ''}</span></div>
              <span className="shrink-0 text-sm font-medium tabular-nums">×{fmtQty(p.quantity)}</span>
            </div>
          ))}
        </Panel>

        <div className="mt-6">
          <Panel title="Recent activity" href="/wms/movements" cta="Full log">
            {moves.length === 0 ? <Empty text="No stock movements yet." /> : moves.map(m => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-2 border-b last:border-0 text-sm">
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium capitalize ${MOVE_CHIP[m.move_type] || 'bg-gray-100'}`}>{m.move_type}</span>
                <span className="font-mono font-medium">{m.item_code}</span>
                <span className="text-xs text-gray-400">{m.from_location_code || '—'} → {m.to_location_code || '—'}</span>
                <span className="ml-auto tabular-nums text-gray-600">{fmtQty(m.quantity)}</span>
                <span className="text-xs text-gray-400 hidden sm:inline whitespace-nowrap">{fmtTime(m.created_at)}</span>
              </div>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Tile({ href, n, label, accent, isQty }: { href: string; n: number; label: string; accent: string; isQty?: boolean }) {
  return (
    <Link href={href} className="bg-white rounded-xl border shadow-sm px-4 py-3 hover:border-emerald-300 transition-colors">
      <div className={`text-2xl font-bold tabular-nums ${accent}`}>{isQty ? fmtQty(n) : n}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </Link>
  )
}
function Panel({ title, href, cta, children }: { title: string; href: string; cta: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        <Link href={href} className="text-xs text-emerald-700 hover:underline">{cta} →</Link>
      </div>
      <div>{children}</div>
    </div>
  )
}
function Empty({ text }: { text: string }) { return <div className="px-4 py-6 text-center text-gray-400 text-sm">{text}</div> }
