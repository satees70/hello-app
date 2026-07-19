'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'

// Reusable "Flag an issue" for a document line in the manufacturing app — same format as the
// warehouse flag (tick Item / Quantity / Batch wrong + note), but it posts to the document's
// discussion thread and notifies Head Office (the discussions trigger handles the notification).
export interface DocFlagLine { item_code: string; description?: string | null; quantity?: number | null; batch_no?: string | null }
const fmtQty = (n: number | null | undefined) => n == null ? '?' : Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 4 })

export default function DocFlag({ line, channel, topic, factoryCode, authorId, authorName, buttonClassName }: {
  line: DocFlagLine; channel: string; topic: string; factoryCode?: string | null; authorId?: string; authorName?: string | null; buttonClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ item: false, qty: false, batch: false, note: '' })

  function openM() { setForm({ item: false, qty: false, batch: false, note: '' }); setErr(''); setOpen(true) }
  async function submit() {
    const picked = [
      form.item && 'ITEM NAME',
      form.qty && `QTY (now ×${fmtQty(line.quantity)})`,
      form.batch && `BATCH (now ${line.batch_no || '—'})`,
    ].filter(Boolean) as string[]
    if (!picked.length) { setErr('Tick what looks wrong — item, quantity or batch.'); return }
    setBusy(true); setErr('')
    const body = `⚠ Issue on ${line.item_code}${line.description ? ` (${line.description})` : ''} — ${picked.join(', ')} not tally.${form.note.trim() ? ` ${form.note.trim()}` : ''}`
    const { error } = await supabase.from('discussions').insert({
      channel, topic, author_id: authorId, author_name: authorName || null, body,
      mention_factories: ['HEAD_OFFICE', ...(factoryCode && factoryCode !== 'HEAD_OFFICE' ? [factoryCode] : [])],
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setOpen(false); setSent(true)
  }

  if (sent) return <span className="text-rose-600 text-xs whitespace-nowrap">⚑ Flagged</span>
  return (
    <>
      <button onClick={openM} className={buttonClassName || 'text-xs text-rose-600 hover:underline whitespace-nowrap font-medium'}>⚑ Flag issue</button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h2 className="font-semibold text-lg">Flag an issue</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-3"><span className="font-mono">{line.item_code}</span> · {line.description || '—'}{line.quantity != null ? ` · ×${fmtQty(line.quantity)}` : ''}{line.batch_no ? ` · b:${line.batch_no}` : ''}</p>
            <p className="text-sm text-gray-600 mb-3">Tick what looks wrong and add a note — Head Office is notified to check it.</p>
            {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-2 rounded mb-3">{err}</p>}
            <div className="space-y-2.5">
              {([['item', 'Item name / code is wrong'], ['qty', `Quantity is wrong (now ×${fmtQty(line.quantity)})`], ['batch', `Batch number is wrong (now ${line.batch_no || '—'})`]] as const).map(([k, label]) => (
                <label key={k} className={`flex items-center gap-2 text-sm font-medium border rounded-lg p-3 ${form[k] ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                  <input type="checkbox" checked={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.checked }))} /> {label}
                </label>
              ))}
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
