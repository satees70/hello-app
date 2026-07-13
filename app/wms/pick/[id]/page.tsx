'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

interface Order { id: string; order_no: string | null; customer_name: string | null; status: string }
interface Line { id: string; line_no: number | null; item_id: string | null; item_code: string; description: string | null; quantity: number; qty_picked: number; uom: string | null }
interface Stock { id: string; item_code: string; location_id: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number }
interface Loc { id: string; location_type: string; pick_sequence: number | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''

const STATUS_CHIP: Record<string, string> = {
  Review: 'bg-amber-100 text-amber-700', Released: 'bg-emerald-100 text-emerald-700',
  Picking: 'bg-blue-100 text-blue-700', Picked: 'bg-emerald-100 text-emerald-700',
}

export default function WmsPickPage() {
  const { id } = useParams<{ id: string }>()
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [stock, setStock] = useState<Stock[]>([])
  const [locMeta, setLocMeta] = useState<Map<string, Loc>>(new Map())
  const [qtyInput, setQtyInput] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const { data: o } = await supabase.from('wms_orders').select('id, order_no, customer_name, status').eq('id', id).single()
    const { data: ls } = await supabase.from('wms_order_lines').select('*').eq('order_id', id).order('line_no')
    const lineList = (ls as Line[]) || []
    const codes = [...new Set(lineList.map(l => l.item_code))]
    const st = codes.length
      ? (await supabase.from('wms_stock').select('id, item_code, location_id, location_code, batch_no, exp_date, quantity').in('item_code', codes)).data as Stock[]
      : []
    const locs = await fetchAll<Loc>('wms_locations', 'id, location_type, pick_sequence')
    setOrder((o as Order) || null); setLines(lineList); setStock(st || [])
    setLocMeta(new Map(locs.map(l => [l.id, l])))
  }, [id])

  useEffect(() => { if (profile) load() }, [profile, load])

  // FEFO allocation preview for a line: SL bins first, earliest expiry, walking order.
  const allocate = useCallback((itemCode: string, need: number) => {
    const rows = stock.filter(s => s.item_code === itemCode && s.quantity > 0).slice()
    rows.sort((a, b) => {
      const la = locMeta.get(a.location_id), lb = locMeta.get(b.location_id)
      const slA = la?.location_type === 'SL' ? 0 : 1, slB = lb?.location_type === 'SL' ? 0 : 1
      if (slA !== slB) return slA - slB
      const ea = a.exp_date || '9999-12-31', eb = b.exp_date || '9999-12-31'
      if (ea !== eb) return ea < eb ? -1 : 1
      return (la?.pick_sequence ?? 999999) - (lb?.pick_sequence ?? 999999) || a.location_code.localeCompare(b.location_code)
    })
    const allocs: { bin: string; batch: string; exp: string | null; qty: number }[] = []
    let left = need
    for (const r of rows) {
      if (left <= 0) break
      const take = Math.min(r.quantity, left)
      allocs.push({ bin: r.location_code, batch: r.batch_no, exp: r.exp_date, qty: take })
      left = clean(left - take)
    }
    return { allocs, shortfall: Math.max(clean(left), 0) }
  }, [stock, locMeta])

  const remainingOf = (l: Line) => clean(l.quantity - l.qty_picked)

  async function pick(l: Line, qty: number) {
    if (!canEdit || qty <= 0) return
    setBusy(l.id); setErr(''); setMsg('')
    const { data, error } = await supabase.rpc('wms_pick_line', { p_line_id: l.id, p_qty: qty, p_reference: order?.order_no ?? null })
    setBusy('')
    if (error) { setErr(error.message); return }
    const res = data as { picked: number; shortfall: number }
    setMsg(res.shortfall > 0
      ? `Picked ${fmtQty(res.picked)} of ${l.item_code} — short by ${fmtQty(res.shortfall)} (not enough stock).`
      : `Picked ${fmtQty(res.picked)} of ${l.item_code}.`)
    setQtyInput(q => ({ ...q, [l.id]: '' }))
    load()
  }

  async function pickAll() {
    for (const l of lines) { const rem = remainingOf(l); if (rem > 0) await pick(l, rem) }
  }

  const totals = useMemo(() => ({
    lines: lines.length,
    done: lines.filter(l => remainingOf(l) <= 0).length,
    remaining: clean(lines.reduce((s, l) => s + Math.max(remainingOf(l), 0), 0)),
  }), [lines])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!order) return <div className="p-8 text-sm text-gray-500">Order not found. <Link href="/wms/orders" className="text-emerald-700 underline">Back to orders</Link></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/wms/orders" className="text-sm text-emerald-700 hover:underline">← Orders to Pick</Link>
        <div className="flex flex-wrap items-center gap-3 mt-2 mb-1">
          <h1 className="text-2xl font-bold">Pick {order.order_no || '(no number)'}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[order.status] || 'bg-gray-100 text-gray-600'}`}>{order.status}</span>
        </div>
        <p className="text-gray-500 text-sm mb-6">{order.customer_name || 'Customer ?'} · {totals.done}/{totals.lines} lines picked · {fmtQty(totals.remaining)} still to pick</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access, so you can’t book picks.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        {canEdit && totals.remaining > 0 && (
          <button onClick={pickAll} disabled={!!busy}
            className="mb-5 bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">
            Pick everything remaining
          </button>
        )}

        <div className="space-y-3">
          {lines.map(l => {
            const rem = remainingOf(l)
            const done = rem <= 0
            const sug = allocate(l.item_code, rem)
            const input = qtyInput[l.id] ?? (rem > 0 ? String(rem) : '')
            return (
              <div key={l.id} className={`bg-white rounded-xl border shadow-sm p-4 ${done ? 'opacity-70' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-mono font-semibold">{l.item_code}{!l.item_id && <span className="ml-1 text-amber-600" title="Not in Items master">⚠</span>}</div>
                    <div className="text-sm text-gray-500 max-w-[420px]">{l.description}</div>
                    <div className="text-xs text-gray-500 mt-1 tabular-nums">
                      Ordered <b>{fmtQty(l.quantity)}</b>{l.uom ? ' ' + l.uom : ''} · Picked <b className="text-emerald-700">{fmtQty(l.qty_picked)}</b> · Remaining <b className={rem > 0 ? 'text-amber-600' : 'text-gray-400'}>{fmtQty(rem)}</b>
                    </div>
                  </div>
                  {done
                    ? <span className="text-emerald-700 text-sm font-medium">✓ Picked</span>
                    : canEdit && (
                      <div className="flex items-center gap-2">
                        <input value={input} onChange={e => setQtyInput(q => ({ ...q, [l.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                          className="w-24 border rounded-lg px-3 py-1.5 text-sm text-right tabular-nums" inputMode="decimal" />
                        <button onClick={() => pick(l, Number(input))} disabled={busy === l.id || !(Number(input) > 0)}
                          className="bg-emerald-700 text-white px-4 py-1.5 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium whitespace-nowrap">
                          {busy === l.id ? 'Picking…' : 'Pick'}
                        </button>
                      </div>
                    )}
                </div>
                {!done && (
                  <div className="mt-3 border-t pt-3">
                    <div className="text-xs text-gray-500 mb-1.5">Pick from (earliest expiry first):</div>
                    {sug.allocs.length === 0
                      ? <div className="text-xs text-red-600">No stock in the warehouse for this item.</div>
                      : <div className="flex flex-wrap gap-2">
                          {sug.allocs.map((a, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5 bg-gray-50 border rounded-lg px-2.5 py-1 text-xs">
                              <span className="font-mono font-medium">{a.bin}</span>
                              {a.batch && <span className="text-gray-400">b:{a.batch}</span>}
                              {a.exp && <span className="text-gray-400">exp {fmtDate(a.exp)}</span>}
                              <span className="font-medium tabular-nums">×{fmtQty(a.qty)}</span>
                            </span>
                          ))}
                        </div>}
                    {sug.shortfall > 0 && <div className="text-xs text-amber-600 mt-1.5">⚠ Only {fmtQty(rem - sug.shortfall)} available — short by {fmtQty(sug.shortfall)}.</div>}
                  </div>
                )}
              </div>
            )
          })}
          {lines.length === 0 && <div className="bg-white rounded-xl border p-8 text-center text-gray-400 text-sm">This order has no lines.</div>}
        </div>
      </div>
    </div>
  )
}
