'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

interface StockRow { item_code: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtN = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
const STAGE = new Set(['GOODS-IN', 'DISPATCH'])

const ORD_ORDER = ['Processing', 'Review', 'Released', 'Reserved', 'Picking', 'Picked', 'Partially Dispatched', 'Dispatched', 'Cancelled', 'Error']
const ORD_COLORS: Record<string, string> = { Processing: 'bg-gray-300', Review: 'bg-amber-400', Released: 'bg-teal-300', Reserved: 'bg-teal-500', Picking: 'bg-emerald-400', Picked: 'bg-emerald-400', 'Partially Dispatched': 'bg-emerald-600', Dispatched: 'bg-emerald-600', Cancelled: 'bg-gray-300', Error: 'bg-red-400' }
const PO_ORDER = ['Processing', 'Open', 'Partially Received', 'Fulfilled', 'Cancelled', 'Error']
const PO_COLORS: Record<string, string> = { Processing: 'bg-gray-300', Open: 'bg-amber-400', 'Partially Received': 'bg-emerald-400', Fulfilled: 'bg-emerald-500', Cancelled: 'bg-gray-300', Error: 'bg-red-400' }

export default function WmsHome() {
  const { profile, loading } = useProfile()
  const [work, setWork] = useState({ po: 0, putaway: 0, pick: 0, dispatch: 0 })
  const [alerts, setAlerts] = useState({ expired: 0, near: 0, low: 0, disc: 0, neg: 0 })
  const [snap, setSnap] = useState({ items: 0, onHand: 0, bins: 0, batches: 0, goodsIn: 0, dispatchHold: 0, reserved: 0 })
  const [exp, setExp] = useState({ expired: 0, w30: 0, w60: 0, w90: 0 })
  const [ordStatus, setOrdStatus] = useState<Record<string, number>>({})
  const [poStatus, setPoStatus] = useState<Record<string, number>>({})
  const [today, setToday] = useState<Record<string, number>>({})

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const [stock, settings, res, allOrd, allPo, todayMv, discRes, facNeg] = await Promise.all([
      fetchAll<StockRow>('wms_stock', 'item_code, location_code, batch_no, exp_date, quantity'),
      fetchAll<{ item_code: string; reorder_level: number | null }>('wms_item_settings', 'item_code, reorder_level'),
      supabase.from('wms_reservations').select('qty').eq('status', 'active').limit(5000),
      supabase.from('wms_orders').select('status').limit(3000),
      supabase.from('wms_purchase_orders').select('status').limit(3000),
      supabase.from('wms_stock_moves').select('move_type').gte('created_at', start.toISOString()).limit(5000),
      supabase.from('wms_count_lines').select('expected_qty, counted_qty, is_unexpected').not('counted_qty', 'is', null).limit(2000),
      supabase.rpc('item_stock_negatives'),   // factory / raw-material rows below zero (HO / own-factory)
    ])
    const t0 = start.getTime()
    let onHand = 0, goodsIn = 0, dispatchHold = 0, putawayLines = 0, binsNeg = 0
    const items = new Set<string>(), bins = new Set<string>(), batches = new Set<string>(), oh = new Map<string, number>()
    const e = { expired: 0, w30: 0, w60: 0, w90: 0 }
    for (const s of stock) {
      const q = Number(s.quantity)
      if (q < 0) binsNeg++
      if (q <= 0) continue
      onHand += q; items.add(s.item_code); batches.add(`${s.item_code}|${s.batch_no}`)
      oh.set(s.item_code.toUpperCase(), (oh.get(s.item_code.toUpperCase()) || 0) + q)
      if (s.location_code === 'GOODS-IN') { goodsIn += q; putawayLines++ }
      else if (s.location_code === 'DISPATCH') dispatchHold += q
      else bins.add(s.location_code)
      if (s.exp_date) { const d = Math.round((new Date(s.exp_date + 'T00:00:00').getTime() - t0) / 86400000); if (d < 0) e.expired++; else if (d <= 30) e.w30++; else if (d <= 60) e.w60++; else if (d <= 90) e.w90++ }
    }
    let low = 0; for (const st of settings) { if (st.reorder_level == null) continue; if ((oh.get(st.item_code.toUpperCase()) || 0) <= st.reorder_level) low++ }
    let disc = 0; for (const l of ((discRes.data as { expected_qty: number; counted_qty: number; is_unexpected: boolean }[]) || [])) { if (l.is_unexpected || Number(l.counted_qty) !== Number(l.expected_qty)) disc++ }
    const reserved = clean(((res.data as { qty: number }[]) || []).reduce((a, r) => a + Number(r.qty || 0), 0))
    const tally = (rows: { [k: string]: string }[] | null, key: string) => { const m: Record<string, number> = {}; for (const r of rows || []) m[r[key]] = (m[r[key]] || 0) + 1; return m }
    const ord = tally(allOrd.data, 'status'), po = tally(allPo.data, 'status')
    setOrdStatus(ord); setPoStatus(po); setToday(tally(todayMv.data, 'move_type'))
    const facNegCount = ((facNeg.data as unknown[]) || []).length
    setExp(e); setAlerts({ expired: e.expired, near: e.w30, low, disc, neg: binsNeg + facNegCount })
    setSnap({ items: items.size, onHand: clean(onHand), bins: bins.size, batches: batches.size, goodsIn: clean(goodsIn), dispatchHold: clean(dispatchHold), reserved })
    setWork({
      po: (po['Open'] || 0) + (po['Partially Received'] || 0),
      putaway: putawayLines,
      pick: (ord['Review'] || 0) + (ord['Released'] || 0) + (ord['Reserved'] || 0) + (ord['Picking'] || 0),
      dispatch: (ord['Picked'] || 0) + (ord['Partially Dispatched'] || 0),
    })
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Warehouse — overview</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">Hello{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''} — here’s the picture at a glance.</p>

        <p className="text-xs font-semibold text-gray-400 tracking-wide mb-2">WORK TO DO</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Tile href="/wms/purchase-orders" n={work.po} label="POs to receive" accent="text-amber-600" />
          <Tile href="/wms/putaway" n={work.putaway} label="Pending putaway" accent="text-emerald-700" />
          <Tile href="/wms/orders" n={work.pick} label="Orders to pick" accent="text-emerald-600" />
          <Tile href="/wms/dispatch" n={work.dispatch} label="Ready to dispatch" accent="text-teal-600" />
        </div>

        <p className="text-xs font-semibold text-gray-400 tracking-wide mb-2">NEEDS ATTENTION</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
          <Tile href="/wms/reports/negatives" n={alerts.neg} label="Negative stock" accent="text-red-600" />
          <Tile href="/wms/reports/expiry" n={alerts.expired} label="Expired lots" accent="text-red-600" />
          <Tile href="/wms/reports/expiry" n={alerts.near} label="Near expiry (30d)" accent="text-amber-600" />
          <Tile href="/wms/reports" n={alerts.low} label="Low stock" accent="text-orange-600" />
          <Tile href="/wms/reports/activity" n={alerts.disc} label="Count discrepancies" accent="text-violet-600" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          <Card title="Stock snapshot" href="/wms/reports" cta="Reports">
            <Row label="Items in stock" value={fmtN(snap.items)} />
            <Row label="Total on-hand (units)" value={fmtN(snap.onHand)} />
            <Row label="Bins in use" value={fmtN(snap.bins)} />
            <Row label="Distinct batches" value={fmtN(snap.batches)} />
            <Row label="Reserved (for orders)" value={fmtN(snap.reserved)} />
            <Row label="In goods-in (awaiting putaway)" value={fmtN(snap.goodsIn)} />
            <Row label="In dispatch holding (packed)" value={fmtN(snap.dispatchHold)} last />
          </Card>
          <Card title="Expiry breakdown" href="/wms/reports/expiry" cta="Expiry alerts">
            <Row label="🔴 Expired" value={fmtN(exp.expired)} strong={exp.expired > 0} />
            <Row label="Within 30 days" value={fmtN(exp.w30)} strong={exp.w30 > 0} />
            <Row label="Within 60 days" value={fmtN(exp.w60)} />
            <Row label="Within 90 days" value={fmtN(exp.w90)} last />
            <p className="px-4 py-2 text-xs text-gray-400">Lots with an expiry, soonest first on the expiry page.</p>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          <div className="bg-white rounded-xl border shadow-sm p-4">
            <div className="flex items-center justify-between mb-3"><div className="text-sm font-semibold text-gray-700">Customer orders</div><Link href="/wms/orders" className="text-xs text-emerald-700 hover:underline">All orders →</Link></div>
            <StatusBar data={ordStatus} order={ORD_ORDER} colors={ORD_COLORS} empty="No orders yet." hrefBase="/wms/orders" />
          </div>
          <div className="bg-white rounded-xl border shadow-sm p-4">
            <div className="flex items-center justify-between mb-3"><div className="text-sm font-semibold text-gray-700">Purchase orders</div><Link href="/wms/purchase-orders" className="text-xs text-emerald-700 hover:underline">All POs →</Link></div>
            <StatusBar data={poStatus} order={PO_ORDER} colors={PO_COLORS} empty="No purchase orders yet." hrefBase="/wms/purchase-orders" />
          </div>
        </div>

        <div className="bg-white rounded-xl border shadow-sm p-4">
          <div className="text-xs font-semibold text-gray-400 tracking-wide mb-2">COMPLETED TODAY</div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {([['receipt', 'Received'], ['putaway', 'Put away'], ['pick', 'Picked'], ['transfer', 'Transfers'], ['dispatch', 'Dispatched'], ['adjust', 'Adjusted']] as const).map(([k, l]) => (
              <span key={k} className="flex items-center gap-1.5"><b className="tabular-nums text-emerald-700">{today[k] || 0}</b> <span className="text-gray-500">{l}</span></span>
            ))}
            <Link href="/wms/movements" className="ml-auto text-xs text-emerald-700 hover:underline">Movement log →</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

function Tile({ href, n, label, accent }: { href: string; n: number; label: string; accent: string }) {
  return (
    <Link href={href} className="bg-white rounded-xl border shadow-sm px-4 py-3 hover:border-emerald-300 transition-colors">
      <div className={`text-2xl font-bold tabular-nums ${accent}`}>{n}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </Link>
  )
}
function Card({ title, href, cta, children }: { title: string; href: string; cta: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-gray-50"><h2 className="text-sm font-semibold text-gray-700">{title}</h2><Link href={href} className="text-xs text-emerald-700 hover:underline">{cta} →</Link></div>
      <div>{children}</div>
    </div>
  )
}
function Row({ label, value, strong, last }: { label: string; value: string; strong?: boolean; last?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-4 py-2 text-sm ${last ? '' : 'border-b'}`}>
      <span className="text-gray-600">{label}</span>
      <span className={`tabular-nums ${strong ? 'font-bold text-red-600' : 'font-medium text-gray-800'}`}>{value}</span>
    </div>
  )
}
function StatusBar({ data, order, colors, empty, hrefBase }: { data: Record<string, number>; order: string[]; colors: Record<string, string>; empty: string; hrefBase: string }) {
  const keys = [...order.filter(k => (data[k] || 0) > 0), ...Object.keys(data).filter(k => !order.includes(k) && data[k] > 0)]
  const total = keys.reduce((s, k) => s + data[k], 0)
  if (!total) return <div className="text-xs text-gray-400">{empty}</div>
  return (
    <>
      <div className="flex h-3 rounded-full overflow-hidden bg-gray-100">
        {keys.map(k => <Link key={k} href={`${hrefBase}?status=${encodeURIComponent(k)}`} className={`${colors[k] || 'bg-gray-400'} hover:opacity-80`} style={{ width: `${(data[k] / total) * 100}%` }} title={`${k}: ${data[k]} — click to filter`} />)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2.5 text-xs">
        {keys.map(k => <Link key={k} href={`${hrefBase}?status=${encodeURIComponent(k)}`} className="flex items-center gap-1.5 hover:underline"><span className={`w-2.5 h-2.5 rounded-sm ${colors[k] || 'bg-gray-400'}`} />{k} <b className="tabular-nums">{data[k]}</b></Link>)}
      </div>
    </>
  )
}
