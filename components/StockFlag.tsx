'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'

// Reusable "Flag an issue" for a stock line — the same format used on Putaway, so staff can flag a
// wrong item / quantity / batch on any stock document. Sends a stock-flag correction to the office
// (via flag_stock_issue → appears in WMS Approvals). Show `flagged` to render the "already flagged"
// state and call `onFlagged` after a successful flag.
export interface FlagRow { id: string; item_code: string; description?: string | null; quantity: number; batch_no?: string | null }
const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 4 })

export default function StockFlag({ row, flagged, onFlagged, buttonClassName }: {
  row: FlagRow; flagged?: boolean; onFlagged?: (id: string) => void; buttonClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ item: false, qty: false, batch: false, correctItem: '', correctQty: '', correctBatch: '', note: '' })

  function openM() { setForm({ item: false, qty: false, batch: false, correctItem: '', correctQty: '', correctBatch: row.batch_no || '', note: '' }); setErr(''); setOpen(true) }
  async function submit() {
    const fields = [form.item && 'item', form.qty && 'qty', form.batch && 'batch'].filter(Boolean) as string[]
    if (!fields.length) { setErr('Tick what looks wrong — item, quantity or batch.'); return }
    setBusy(true); setErr('')
    const { error } = await supabase.rpc('flag_stock_issue', {
      p_stock_id: row.id, p_fields: fields.join(','),
      p_correct_item: form.item ? (form.correctItem.trim() || null) : null,
      p_correct_qty: form.qty && form.correctQty.trim() !== '' ? Number(form.correctQty) : null,
      p_correct_batch: form.batch ? (form.correctBatch.trim() || null) : null,
      p_reason: form.note.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(/flag_stock_issue|wms_correction_requests|flag_fields/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-stock-flag.sql in the Supabase SQL editor.' : error.message); return }
    setOpen(false); onFlagged?.(row.id)
  }

  if (flagged) return <span className="text-rose-600 text-xs whitespace-nowrap">⚑ Flagged</span>
  return (
    <>
      <button onClick={openM} className={buttonClassName || 'text-xs border border-rose-300 text-rose-700 rounded px-2 py-1 hover:bg-rose-50 whitespace-nowrap font-medium'}>⚑ Flag issue</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h2 className="font-semibold text-lg">Flag an issue</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-3"><span className="font-mono">{row.item_code}</span> · {row.description || '—'} · ×{fmtQty(row.quantity)}{row.batch_no ? ` · b:${row.batch_no}` : ''}</p>
            <p className="text-sm text-gray-600 mb-3">Tick what looks wrong. Add the correct value if you know it — the office is notified to revise it.</p>
            {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-2 rounded mb-3">{err}</p>}
            <div className="space-y-3">
              <div className={`border rounded-lg p-3 ${form.item ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={form.item} onChange={e => setForm(f => ({ ...f, item: e.target.checked }))} /> Item name / code is wrong</label>
                {form.item && <input value={form.correctItem} onChange={e => setForm(f => ({ ...f, correctItem: e.target.value }))} placeholder="What should it be? (optional)" className="w-full border rounded-lg px-3 py-2 text-sm mt-2" />}
              </div>
              <div className={`border rounded-lg p-3 ${form.qty ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.checked }))} /> Quantity is wrong <span className="text-gray-400 font-normal">(now ×{fmtQty(row.quantity)})</span></label>
                {form.qty && <input value={form.correctQty} onChange={e => setForm(f => ({ ...f, correctQty: e.target.value.replace(/[^0-9.]/g, '') }))} inputMode="decimal" placeholder="Correct quantity (optional)" className="w-full border rounded-lg px-3 py-2 text-sm mt-2" />}
              </div>
              <div className={`border rounded-lg p-3 ${form.batch ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={form.batch} onChange={e => setForm(f => ({ ...f, batch: e.target.checked }))} /> Batch number is wrong <span className="text-gray-400 font-normal">(now {row.batch_no || '—'})</span></label>
                {form.batch && <input value={form.correctBatch} onChange={e => setForm(f => ({ ...f, correctBatch: e.target.value }))} placeholder="Correct batch (optional — fixed on approval)" className="w-full border rounded-lg px-3 py-2 text-sm font-mono mt-2" />}
              </div>
              <textarea value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} rows={2} placeholder="Note for the office (optional)" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg border text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={submit} disabled={busy} className="bg-rose-600 text-white px-4 py-2 rounded-lg hover:bg-rose-700 disabled:opacity-50 text-sm font-medium">{busy ? 'Sending…' : '⚑ Send flag to office'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
