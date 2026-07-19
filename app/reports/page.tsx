'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase, fetchAll } from '@/lib/supabase'

// Management reporting dashboard (Head Office / admin only). Four views:
//  1) On-time delivery   2) Production throughput
//  3) Outstanding orders 4) Unified order status
// All data is read from tables the app already maintains. Caveats are shown in-page
// so the numbers aren't misread (on-time needs the driver app; throughput uses the
// dispatch time as the completion proxy; invoiced/delivered from the schedule is per-SO).

const KL = 'Asia/Kuala_Lumpur'
const dayKL = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: KL })   // YYYY-MM-DD
const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 2 })
const DAY = 86400000

interface Deliv { so_number: string; customer_name: string | null; route: string | null; delivery_date: string | null; delivered_at: string | null; invoiced: boolean }
interface Batch { factory_code: string | null; total_quantity: number | null; produced_qty: number | null; status: string | null; dispatched_at: string | null }
interface Line { so_number: string | null; customer_name: string | null; item_code: string | null; quantity: number | null; outstanding_qty: number | null; delivered_qty: number | null; delivery_date: string | null; factory_code: string | null; created_at: string; balance_cancelled_at: string | null }
interface PBI { so_number: string; production_batches: { item_code: string | null; factory_code: string | null; produced_qty: number | null; total_quantity: number | null; dispatched_at: string | null } | null }

// week label like "2026-W29" from an ISO timestamp (KL calendar)
function isoWeek(iso: string): string {
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: KL }))
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((t.getTime() - first.getTime()) / DAY - 3 + ((first.getUTCDay() + 6) % 7)) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

const STAGES = ['Pending', 'In production', 'Produced', 'At warehouse', 'Delivered', 'Invoiced'] as const
const STAGE_COLOR: Record<string, string> = {
  'Pending': 'bg-gray-200 text-gray-700', 'In production': 'bg-amber-100 text-amber-700',
  'Produced': 'bg-lime-100 text-lime-700', 'At warehouse': 'bg-teal-100 text-teal-700',
  'Delivered': 'bg-green-100 text-green-700', 'Invoiced': 'bg-emerald-600 text-white',
}

export default function ReportsPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const allowed = !!profile && (profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')

  const [deliv, setDeliv] = useState<Deliv[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [openLines, setOpenLines] = useState<Line[]>([])
  const [prod, setProd] = useState<Map<string, { produced: number; total: number; dispatched: boolean }>>(new Map())
  const [sched, setSched] = useState<Map<string, { delivered: boolean; invoiced: boolean }>>(new Map())
  const [busy, setBusy] = useState(true)

  useEffect(() => { if (!loading && profile && !allowed) router.replace('/dashboard') }, [loading, profile, allowed, router])

  const load = useCallback(async () => {
    setBusy(true)
    const since = new Date(Date.now() - 90 * DAY).toISOString()
    const [{ data: dv }, { data: bt }, lines] = await Promise.all([
      supabase.from('delivery_schedule').select('so_number, customer_name, route, delivery_date, delivered_at, invoiced').not('delivered_at', 'is', null).gte('delivered_at', since),
      supabase.from('production_batches').select('factory_code, total_quantity, produced_qty, status, dispatched_at').not('dispatched_at', 'is', null).neq('status', 'Cancelled').gte('dispatched_at', since).limit(5000),
      fetchAll<Line>('sales_order_lines', 'so_number, customer_name, item_code, quantity, outstanding_qty, delivered_qty, delivery_date, factory_code, created_at, balance_cancelled_at', q => q.is('superseded_at', null)),
    ])
    setDeliv((dv as Deliv[]) || [])
    setBatches((bt as Batch[]) || [])
    const open = (lines || []).filter(l => Math.max(0, Number(l.outstanding_qty ?? l.quantity ?? 0) - Number(l.delivered_qty || 0)) > 0 && !l.balance_cancelled_at)
    setOpenLines(open)

    // Production + schedule stage for the open SOs (chunk the .in() to stay under URL limits).
    const sos = [...new Set(open.map(l => l.so_number).filter(Boolean))] as string[]
    const prodMap = new Map<string, { produced: number; total: number; dispatched: boolean }>()
    const schedMap = new Map<string, { delivered: boolean; invoiced: boolean }>()
    for (let i = 0; i < sos.length; i += 200) {
      const chunk = sos.slice(i, i + 200)
      const [{ data: pbi }, { data: sc }] = await Promise.all([
        supabase.from('production_batch_items').select('so_number, production_batches!batch_id(item_code, factory_code, produced_qty, total_quantity, dispatched_at)').in('so_number', chunk),
        supabase.from('delivery_schedule').select('so_number, delivered_at, invoiced').in('so_number', chunk),
      ])
      ;((pbi as unknown as PBI[]) || []).forEach(r => {
        const b = r.production_batches; if (!b) return
        const k = `${b.factory_code}|${b.item_code}|${r.so_number}`
        const cur = prodMap.get(k) || { produced: 0, total: 0, dispatched: false }
        prodMap.set(k, { produced: cur.produced + Number(b.produced_qty || 0), total: cur.total + Number(b.total_quantity || 0), dispatched: cur.dispatched || !!b.dispatched_at })
      })
      ;((sc as { so_number: string; delivered_at: string | null; invoiced: boolean }[]) || []).forEach(r => {
        const cur = schedMap.get(r.so_number) || { delivered: false, invoiced: false }
        schedMap.set(r.so_number, { delivered: cur.delivered || !!r.delivered_at, invoiced: cur.invoiced || !!r.invoiced })
      })
    }
    setProd(prodMap); setSched(schedMap)
    setBusy(false)
  }, [])
  useEffect(() => { if (allowed) load() }, [allowed, load])

  // ---- View 1: on-time delivery ----
  const onTime = useMemo(() => {
    const withTarget = deliv.filter(d => d.delivery_date && d.delivered_at)
    let ok = 0, late = 0
    const byRoute: Record<string, { total: number; late: number }> = {}
    withTarget.forEach(d => {
      const good = dayKL(d.delivered_at!) <= d.delivery_date!
      if (good) ok++; else late++
      const r = d.route || '—'; byRoute[r] = byRoute[r] || { total: 0, late: 0 }; byRoute[r].total++; if (!good) byRoute[r].late++
    })
    const pct = withTarget.length ? Math.round((ok / withTarget.length) * 100) : null
    const routes = Object.entries(byRoute).map(([route, v]) => ({ route, ...v })).sort((a, b) => b.late - a.late).slice(0, 8)
    return { total: withTarget.length, ok, late, pct, noTarget: deliv.length - withTarget.length, routes }
  }, [deliv])

  // ---- View 2: production throughput ----
  const throughput = useMemo(() => {
    const byWeek: Record<string, { count: number; qty: number }> = {}
    const byFac: Record<string, { count: number; qty: number }> = {}
    batches.forEach(b => {
      if (!b.dispatched_at) return
      const w = isoWeek(b.dispatched_at); byWeek[w] = byWeek[w] || { count: 0, qty: 0 }; byWeek[w].count++; byWeek[w].qty += Number(b.produced_qty || 0)
      const f = b.factory_code || '—'; byFac[f] = byFac[f] || { count: 0, qty: 0 }; byFac[f].count++; byFac[f].qty += Number(b.produced_qty || 0)
    })
    const weeks = Object.entries(byWeek).map(([week, v]) => ({ week, ...v })).sort((a, b) => a.week < b.week ? 1 : -1).slice(0, 8)
    const facs = Object.entries(byFac).map(([factory, v]) => ({ factory, ...v })).sort((a, b) => b.count - a.count)
    return { total: batches.length, weeks, facs, maxW: Math.max(1, ...weeks.map(w => w.count)) }
  }, [batches])

  // ---- View 3: outstanding orders ----
  const outstanding = useMemo(() => {
    const bucketOf = (days: number) => days <= 7 ? '0–7 days' : days <= 30 ? '8–30 days' : days <= 60 ? '31–60 days' : '60+ days'
    const buckets: Record<string, { count: number; qty: number }> = { '0–7 days': { count: 0, qty: 0 }, '8–30 days': { count: 0, qty: 0 }, '31–60 days': { count: 0, qty: 0 }, '60+ days': { count: 0, qty: 0 } }
    const byFac: Record<string, { count: number; qty: number }> = {}
    const rows = openLines.map(l => {
      const out = Math.max(0, Number(l.outstanding_qty ?? l.quantity ?? 0) - Number(l.delivered_qty || 0))
      const age = Math.floor((Date.now() - new Date(l.created_at).getTime()) / DAY)
      return { ...l, out, age }
    })
    rows.forEach(r => {
      const b = bucketOf(r.age); buckets[b].count++; buckets[b].qty += r.out
      const f = r.factory_code || '—'; byFac[f] = byFac[f] || { count: 0, qty: 0 }; byFac[f].count++; byFac[f].qty += r.out
    })
    const oldest = [...rows].sort((a, b) => b.age - a.age).slice(0, 15)
    const facs = Object.entries(byFac).map(([factory, v]) => ({ factory, ...v })).sort((a, b) => b.count - a.count)
    return { total: rows.length, buckets: Object.entries(buckets).map(([bucket, v]) => ({ bucket, ...v })), facs, oldest }
  }, [openLines])

  // ---- View 4: unified order status (per open line) ----
  const pipeline = useMemo(() => {
    const counts: Record<string, number> = Object.fromEntries(STAGES.map(s => [s, 0]))
    const staged = openLines.map(l => {
      const k = `${l.factory_code}|${l.item_code}|${l.so_number}`
      const b = prod.get(k); const s = l.so_number ? sched.get(l.so_number) : undefined
      const deliveredFull = Number(l.quantity || 0) > 0 && Number(l.delivered_qty || 0) >= Number(l.quantity || 0)
      let stage: string
      if (s?.invoiced) stage = 'Invoiced'
      else if (deliveredFull || s?.delivered) stage = 'Delivered'
      else if (b?.dispatched) stage = 'At warehouse'
      else if (b && b.total > 0 && b.produced >= b.total) stage = 'Produced'
      else if (b && b.produced > 0) stage = 'In production'
      else stage = 'Pending'
      counts[stage]++
      return { ...l, stage }
    })
    return { counts, total: staged.length }
  }, [openLines, prod, sched])

  if (loading || (profile && !allowed)) return <div className="min-h-screen"><Navbar factoryCode={profile?.factory_code || ''} fullName={profile?.full_name || ''} role={profile?.role || ''} /><div className="p-8 text-sm text-gray-500">Loading…</div></div>

  const Tile = ({ label, value, sub, tone = 'gray' }: { label: string; value: string; sub?: string; tone?: string }) => (
    <div className={`rounded-xl border p-4 bg-white`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-600' : 'text-gray-800'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
  const Card = ({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) => (
    <section className="mb-8">
      <h2 className="font-semibold text-lg mb-1">{title}</h2>
      {note && <p className="text-xs text-gray-400 mb-3">{note}</p>}
      {children}
    </section>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile?.factory_code || ''} fullName={profile?.full_name || ''} role={profile?.role || ''} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
          <h1 className="text-2xl font-bold">Management Reports</h1>
          <button onClick={load} disabled={busy} className="text-sm text-emerald-700 hover:underline disabled:opacity-50">{busy ? 'Loading…' : '↻ Refresh'}</button>
        </div>

        {/* 1 — On-time delivery */}
        <Card title="On-time delivery" note="Last 90 days · compares each delivery date with when the driver marked it delivered. Needs the driver app in use to be meaningful.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <Tile label="On-time" value={onTime.pct == null ? '—' : `${onTime.pct}%`} tone="green" sub={`${onTime.ok} of ${onTime.total}`} />
            <Tile label="Late" value={String(onTime.late)} tone={onTime.late ? 'red' : 'gray'} />
            <Tile label="Delivered (with a target date)" value={String(onTime.total)} />
            <Tile label="No target date" value={String(onTime.noTarget)} sub="excluded from %" />
          </div>
          {onTime.routes.length > 0 && (
            <div className="bg-white rounded-xl border overflow-x-auto">
              <table className="w-full text-sm"><thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Route', 'Deliveries', 'Late', 'On-time %'].map(h => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>{onTime.routes.map(r => <tr key={r.route} className="border-b last:border-0"><td className="px-3 py-2 font-medium">{r.route}</td><td className="px-3 py-2">{r.total}</td><td className={`px-3 py-2 ${r.late ? 'text-red-600 font-medium' : ''}`}>{r.late}</td><td className="px-3 py-2">{Math.round(((r.total - r.late) / r.total) * 100)}%</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Card>

        {/* 2 — Production throughput */}
        <Card title="Production throughput" note="Last 90 days · counts batches once dispatched to the warehouse (there is no separate 'production finished' timestamp, so dispatch is the proxy).">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border p-4">
              <div className="text-xs text-gray-500 mb-2">Batches dispatched per week</div>
              {throughput.weeks.length === 0 ? <div className="text-gray-400 text-sm">No data.</div> : throughput.weeks.map(w => (
                <div key={w.week} className="flex items-center gap-2 mb-1.5 text-xs">
                  <span className="w-20 text-gray-500 tabular-nums">{w.week}</span>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden"><div className="bg-emerald-500 h-full" style={{ width: `${(w.count / throughput.maxW) * 100}%` }} /></div>
                  <span className="w-8 text-right tabular-nums font-medium">{w.count}</span>
                  <span className="w-16 text-right text-gray-400 tabular-nums">{fmtQty(w.qty)}</span>
                </div>
              ))}
            </div>
            <div className="bg-white rounded-xl border overflow-x-auto">
              <table className="w-full text-sm"><thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Factory', 'Batches', 'Qty produced'].map(h => <th key={h} className="text-left px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                <tbody>{throughput.facs.map(f => <tr key={f.factory} className="border-b last:border-0"><td className="px-3 py-2 font-medium">{f.factory}</td><td className="px-3 py-2">{f.count}</td><td className="px-3 py-2 tabular-nums">{fmtQty(f.qty)}</td></tr>)}
                  {throughput.facs.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-400">No data.</td></tr>}</tbody>
              </table>
            </div>
          </div>
        </Card>

        {/* 3 — Outstanding orders */}
        <Card title="Outstanding orders" note="Open order lines still owed to customers (by quantity — pricing lives in SQL Account). Age is measured from when the order was uploaded.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            {outstanding.buckets.map(b => <Tile key={b.bucket} label={b.bucket} value={String(b.count)} sub={`${fmtQty(b.qty)} qty`} tone={b.bucket === '60+ days' && b.count ? 'red' : 'gray'} />)}
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="bg-white rounded-xl border overflow-x-auto">
              <div className="px-3 py-2 border-b text-xs font-semibold text-gray-600">By factory</div>
              <table className="w-full text-sm"><tbody>{outstanding.facs.map(f => <tr key={f.factory} className="border-b last:border-0"><td className="px-3 py-2 font-medium">{f.factory}</td><td className="px-3 py-2 text-right">{f.count} lines</td><td className="px-3 py-2 text-right tabular-nums text-gray-500">{fmtQty(f.qty)}</td></tr>)}
                {outstanding.facs.length === 0 && <tr><td className="px-3 py-6 text-center text-gray-400">Nothing outstanding.</td></tr>}</tbody></table>
            </div>
            <div className="bg-white rounded-xl border overflow-x-auto">
              <div className="px-3 py-2 border-b text-xs font-semibold text-gray-600">Oldest open lines</div>
              <table className="w-full text-sm"><thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['SO', 'Item', 'Customer', 'Age', 'Out'].map(h => <th key={h} className="text-left px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                <tbody>{outstanding.oldest.map((r, i) => <tr key={i} className="border-b last:border-0"><td className="px-2 py-1.5 font-mono text-xs">{r.so_number}</td><td className="px-2 py-1.5 font-mono text-xs">{r.item_code}</td><td className="px-2 py-1.5 text-xs truncate max-w-[8rem]">{r.customer_name}</td><td className={`px-2 py-1.5 text-xs ${r.age > 60 ? 'text-red-600 font-medium' : ''}`}>{r.age}d</td><td className="px-2 py-1.5 text-xs tabular-nums">{fmtQty(r.out)}</td></tr>)}</tbody></table>
            </div>
          </div>
        </Card>

        {/* 4 — Unified order status */}
        <Card title="Order status pipeline" note={`Where the ${pipeline.total} open order lines currently sit. Delivered/Invoiced come from the delivery schedule (per sales order), so a multi-item order shares one delivered/invoiced flag.`}>
          <div className="bg-white rounded-xl border p-4">
            <div className="flex w-full h-6 rounded-lg overflow-hidden mb-3">
              {STAGES.map(s => { const n = pipeline.counts[s]; const pct = pipeline.total ? (n / pipeline.total) * 100 : 0; return pct > 0 ? <div key={s} className={STAGE_COLOR[s]} style={{ width: `${pct}%` }} title={`${s}: ${n}`} /> : null })}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {STAGES.map(s => (
                <div key={s} className="text-center">
                  <div className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STAGE_COLOR[s]}`}>{s}</div>
                  <div className="text-lg font-bold mt-1">{pipeline.counts[s]}</div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
