'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

// Supplier returns / rejects: send a bad delivery back to the supplier (wrong item, short,
// damaged, failed QC) with a record. Returning removes the goods from warehouse stock.
interface Stock { id: string; item_code: string; description: string | null; location_code: string; batch_no: string; exp_date: string | null; quantity: number; uom: string | null }
interface Ret { id: string; item_code: string | null; description: string | null; batch: string | null; qty: number; reason: string | null; note: string | null; supplier_name: string | null; from_location_code: string | null; source: string; created_by_name: string | null; created_at: string }

const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const REASONS: { k: string; label: string }[] = [
  { k: 'wrong_item', label: 'Wrong item' }, { k: 'short_shipped', label: 'Short shipped' },
  { k: 'damaged', label: 'Damaged' }, { k: 'quality', label: 'Quality / failed QC' }, { k: 'other', label: 'Other' },
]
const reasonLabel = (k: string | null) => REASONS.find(r => r.k === k)?.label || k || '—'

export default function SupplierReturnsPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [stock, setStock] = useState<Stock[]>([])
  const [log, setLog] = useState<Ret[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [modal, setModal] = useState<Stock | null>(null)
  const [reason, setReason] = useState('wrong_item'); const [supplier, setSupplier] = useState(''); const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const [{ data: st }, { data: lg }] = await Promise.all([
      supabase.from('wms_stock').select('id, item_code, description, location_code, batch_no, exp_date, quantity, uom').gt('quantity', 0).order('updated_at', { ascending: false }).limit(500),
      supabase.from('wms_supplier_returns').select('id, item_code, description, batch, qty, reason, note, supplier_name, from_location_code, source, created_by_name, created_at').order('created_at', { ascending: false }).limit(200),
    ])
    setStock((st as Stock[]) || [])
    setLog((lg as Ret[]) || [])
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  function open(s: Stock) { setModal(s); setReason('wrong_item'); setSupplier(''); setNote(''); setErr(''); setMsg('') }
  async function submit() {
    if (!modal) return
    setBusy(modal.id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_return_to_supplier', { p_stock_id: modal.id, p_reason: reason, p_supplier: supplier.trim() || null, p_note: note.trim() || null })
    setBusy('')
    if (error) { setErr(/wms_return_to_supplier|wms_supplier_returns/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-supplier-returns.sql in the Supabase SQL editor.' : error.message); return }
    const it = modal.item_code
    setModal(null); setMsg(`Returned ${it} to supplier — removed from stock.`); load()
  }

  const rq = q.trim().toLowerCase()
  const shown = useMemo(() => rq ? stock.filter(s => `${s.item_code} ${s.description || ''} ${s.batch_no} ${s.location_code}`.toLowerCase().includes(rq)) : stock.slice(0, 40), [stock, rq])

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">↩ Supplier Returns</h1>
          <Link href="/wms" className="text-sm text-emerald-700 hover:underline">← Warehouse home</Link>
        </div>
        <p className="text-gray-500 text-sm mb-4">Send a bad delivery back to the supplier (wrong item, short, damaged, failed QC). Returning removes the goods from stock and keeps a record. Damaged / QC-failed stock can also be returned by Head Office from Approvals.</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        {/* Raise a return */}
        <div className="bg-white rounded-xl border shadow-sm mb-6">
          <div className="px-4 py-2.5 border-b font-semibold text-sm">Return goods to a supplier</div>
          <div className="p-3">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 find the stock to return — item, batch, bin…" className="border rounded-lg px-3 py-2 text-sm w-full sm:w-96 mb-2" />
            {shown.length === 0 ? <p className="px-1 py-4 text-gray-400 text-sm">No matching stock.</p> : (
              <div className="divide-y border rounded-lg">
                {shown.map(s => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="font-mono font-medium">{s.item_code}</span>{s.description ? <span className="text-gray-500"> — {s.description}</span> : ''}
                      <span className="block text-xs text-gray-400">× {fmtQty(s.quantity)}{s.uom ? ' ' + s.uom : ''} · {s.location_code}{s.batch_no ? ` · batch ${s.batch_no}` : ''}</span>
                    </div>
                    {canEdit && <button onClick={() => open(s)} disabled={busy === s.id} className="text-xs border border-rose-400 text-rose-700 rounded px-3 py-1.5 hover:bg-rose-50 disabled:opacity-50 font-medium shrink-0">↩ Return</button>}
                  </div>
                ))}
              </div>
            )}
            {!rq && stock.length > 40 && <p className="text-xs text-gray-400 mt-1.5">Showing 40 — search to find a specific item.</p>}
          </div>
        </div>

        {/* Returns log */}
        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <div className="px-4 py-2.5 border-b font-semibold text-sm">Returns log <span className="text-gray-400 font-normal">· {log.length}</span></div>
          {log.length === 0 ? <p className="px-4 py-6 text-gray-400 text-sm text-center">No returns yet.</p> : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['When', 'Item', 'Qty', 'Batch', 'Reason', 'Supplier', 'By'].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {log.map(r => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtWhen(r.created_at)}</td>
                    <td className="px-3 py-2"><span className="font-mono">{r.item_code}</span>{r.description ? <span className="text-gray-400 text-xs"> — {r.description}</span> : ''}</td>
                    <td className="px-3 py-2 tabular-nums">{fmtQty(r.qty)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.batch || '—'}</td>
                    <td className="px-3 py-2 text-xs">{reasonLabel(r.reason)}{r.source === 'damage' ? ' · from DAMAGED' : ''}{r.note ? ` · ${r.note}` : ''}</td>
                    <td className="px-3 py-2 text-xs">{r.supplier_name || '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{r.created_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setModal(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-1">↩ Return to supplier</h2>
            <p className="text-gray-500 text-sm mb-4">
              <span className="font-mono">{modal.item_code}</span>{modal.description ? ` — ${modal.description}` : ''}
              <span className="block text-xs mt-0.5">× {fmtQty(modal.quantity)}{modal.uom ? ' ' + modal.uom : ''} · {modal.location_code}{modal.batch_no ? ` · batch ${modal.batch_no}` : ''} — this removes it from stock.</span>
            </p>
            <label className="block text-xs text-gray-500 mb-1">Reason</label>
            <select value={reason} onChange={e => setReason(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mb-3">
              {REASONS.map(r => <option key={r.k} value={r.k}>{r.label}</option>)}
            </select>
            <label className="block text-xs text-gray-500 mb-1">Supplier <span className="text-gray-400">(optional)</span></label>
            <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="supplier name" className="w-full border rounded-lg px-3 py-2 text-sm mb-3" />
            <label className="block text-xs text-gray-500 mb-1">Note <span className="text-gray-400">(optional)</span></label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="e.g. wrong grade sent · DO/invoice no." className="w-full border rounded-lg px-3 py-2 text-sm mb-4" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setModal(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 font-medium text-sm">Cancel</button>
              <button onClick={submit} disabled={busy === modal.id} className="bg-rose-600 text-white px-5 py-2 rounded-lg hover:bg-rose-700 disabled:opacity-50 font-medium text-sm">Return &amp; remove from stock</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
