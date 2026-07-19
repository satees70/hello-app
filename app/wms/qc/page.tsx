'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

// Incoming QC: hold received goods for a quality check, then pass (release to stock) or fail
// (send to DAMAGED for Head Office to write off / return to the supplier).
interface Stock { id: string; item_code: string; description: string | null; location_code: string; batch_no: string; exp_date: string | null; quantity: number; uom: string | null; updated_at: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function WmsQcPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [stock, setStock] = useState<Stock[]>([])
  const [qcReq, setQcReq] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState('')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase.from('wms_stock')
      .select('id, item_code, description, location_code, batch_no, exp_date, quantity, uom, updated_at')
      .in('location_code', ['GOODS-IN', 'QC-HOLD']).gt('quantity', 0).order('updated_at', { ascending: false })
    setStock((data as Stock[]) || [])
    const { data: s } = await supabase.from('wms_item_settings').select('item_code, qc_required').eq('qc_required', true)
    setQcReq(new Set(((s as { item_code: string }[]) || []).map(x => x.item_code)))
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  const run = async (id: string, rpc: string, params: Record<string, unknown>, ok: string) => {
    setBusy(id); setErr(''); setMsg('')
    const { error } = await supabase.rpc(rpc, params)
    setBusy('')
    if (error) { setErr(/wms_qc_|QC-HOLD/.test(error.message) && /does not exist|schema cache|could not find|missing/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-qc-hold.sql in the Supabase SQL editor.' : error.message); return }
    setMsg(ok); load()
  }
  const hold = (s: Stock) => run(s.id, 'wms_qc_hold', { p_stock_id: s.id }, `${s.item_code} put on QC hold.`)
  const pass = (s: Stock) => run(s.id, 'wms_qc_pass', { p_stock_id: s.id }, `${s.item_code} passed QC — released to stock.`)
  const fail = (s: Stock) => {
    const reason = window.prompt(`Fail QC for ${s.item_code} (×${fmtQty(s.quantity)})?\n\nIt moves to DAMAGED and Head Office decides (write off / return to supplier).\n\nReason:`, '')
    if (reason === null) return
    run(s.id, 'wms_qc_fail', { p_stock_id: s.id, p_reason: reason || null }, `${s.item_code} failed QC — sent to DAMAGED for Head Office.`)
  }
  async function toggleReq(itemCode: string, itemDesc: string | null, on: boolean) {
    setErr('')
    const { error } = await supabase.from('wms_item_settings').upsert({ item_code: itemCode, qc_required: on }, { onConflict: 'item_code' })
    if (error) { setErr(error.message); return }
    setQcReq(s => { const n = new Set(s); on ? n.add(itemCode) : n.delete(itemCode); return n })
    void itemDesc
  }

  const rq = q.trim().toLowerCase()
  const match = (s: Stock) => !rq || `${s.item_code} ${s.description || ''} ${s.batch_no}`.toLowerCase().includes(rq)
  const held = useMemo(() => stock.filter(s => s.location_code === 'QC-HOLD' && match(s)), [stock, rq])
  const goodsIn = useMemo(() => stock.filter(s => s.location_code === 'GOODS-IN' && match(s)), [stock, rq])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">🔬 Quality Check</h1>
          <Link href="/wms" className="text-sm text-emerald-700 hover:underline">← Warehouse home</Link>
        </div>
        <p className="text-gray-500 text-sm mb-4">Hold received goods for a quality check, then pass (release to stock) or fail (send to DAMAGED). Items flagged <b>QC required</b> should always be held before use.</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 item, description, batch…" className="border rounded-lg px-3 py-2 text-sm w-full sm:w-80 mb-5" />

        {/* On QC hold */}
        <div className="bg-white rounded-xl border shadow-sm mb-6">
          <div className="px-4 py-2.5 border-b font-semibold text-sm bg-amber-50/60">On QC hold <span className="text-gray-400 font-normal">· {held.length}</span></div>
          {held.length === 0 ? <p className="px-4 py-6 text-gray-400 text-sm text-center">Nothing on hold.</p> : (
            <div className="divide-y">
              {held.map(s => (
                <div key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono font-medium">{s.item_code}</span>{s.description ? <span className="text-gray-500"> — {s.description}</span> : ''}
                    <span className="block text-xs text-gray-400">× {fmtQty(s.quantity)}{s.uom ? ' ' + s.uom : ''}{s.batch_no ? ` · batch ${s.batch_no}` : ''} · held {fmtWhen(s.updated_at)}</span>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={() => pass(s)} disabled={busy === s.id} className="bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">✓ Pass</button>
                      <button onClick={() => fail(s)} disabled={busy === s.id} className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-50">✗ Fail</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Received, in GOODS-IN — can be held for QC */}
        <div className="bg-white rounded-xl border shadow-sm">
          <div className="px-4 py-2.5 border-b font-semibold text-sm">Received (GOODS-IN) <span className="text-gray-400 font-normal">· {goodsIn.length}</span></div>
          {goodsIn.length === 0 ? <p className="px-4 py-6 text-gray-400 text-sm text-center">Nothing in GOODS-IN.</p> : (
            <div className="divide-y">
              {goodsIn.map(s => {
                const req = qcReq.has(s.item_code)
                return (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono font-medium">{s.item_code}</span>{s.description ? <span className="text-gray-500"> — {s.description}</span> : ''}
                      {req && <span className="ml-2 inline-block rounded-full bg-amber-100 text-amber-700 text-[10px] font-medium px-2 py-0.5 align-middle">⚠ QC required</span>}
                      <span className="block text-xs text-gray-400">× {fmtQty(s.quantity)}{s.uom ? ' ' + s.uom : ''}{s.batch_no ? ` · batch ${s.batch_no}` : ''}</span>
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-3 shrink-0">
                        <label className="flex items-center gap-1 text-[11px] text-gray-500" title="Always require a QC check for this item">
                          <input type="checkbox" checked={req} onChange={e => toggleReq(s.item_code, s.description, e.target.checked)} /> QC required
                        </label>
                        <button onClick={() => hold(s)} disabled={busy === s.id} className={`px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 ${req ? 'bg-amber-600 text-white hover:bg-amber-700' : 'border border-amber-500 text-amber-700 hover:bg-amber-50'}`}>🔬 Hold for QC</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
