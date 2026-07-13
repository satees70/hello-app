'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface Item { code: string; description: string; unit: string }
interface Loc { id: string; code: string; location_type: string; active: boolean; pick_sequence: number | null }
interface StockLite { item_code: string; location_id: string; batch_no: string }
interface Move {
  id: string; item_code: string; description: string | null; to_location_code: string | null
  batch_no: string; quantity: number; moved_by_name: string | null; created_at: string
}

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const seqKey = (l: Loc) => `${(l.pick_sequence ?? 999999).toString().padStart(6, '0')}_${l.code}`

const EMPTY = { itemCode: '', description: '', uom: '', qty: '', batch: '', exp_date: '', reference: '', bin: '' }

export default function WmsPutawayPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [items, setItems] = useState<Item[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [stock, setStock] = useState<StockLite[]>([])
  const [recent, setRecent] = useState<Move[]>([])
  const [form, setForm] = useState(EMPTY)
  const [binTouched, setBinTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const [it, lo, st, mv] = await Promise.all([
      fetchAll<Item>('items', 'code, description, unit', 'code'),
      fetchAll<Loc>('wms_locations', 'id, code, location_type, active, pick_sequence', 'code'),
      fetchAll<StockLite>('wms_stock', 'item_code, location_id, batch_no'),
      supabase.from('wms_stock_moves').select('id, item_code, description, to_location_code, batch_no, quantity, moved_by_name, created_at')
        .eq('move_type', 'putaway').order('created_at', { ascending: false }).limit(40),
    ])
    setItems(it); setLocs(lo); setStock(st); setRecent((mv.data as Move[]) || [])
  }

  const locByCode = useMemo(() => new Map(locs.map(l => [l.code.toUpperCase(), l])), [locs])
  const occupied = useMemo(() => new Set(stock.map(s => s.location_id)), [stock])

  // Suggest a bin: (1) an SL bin already holding this item, (2) an empty SL bin,
  // (3) an empty XS overflow bin — each in walking order.
  const suggestion = useMemo(() => {
    if (!form.itemCode) return null
    const active = locs.filter(l => l.active)
    const sl = active.filter(l => l.location_type === 'SL').sort((a, b) => seqKey(a).localeCompare(seqKey(b)))
    const xs = active.filter(l => l.location_type === 'XS').sort((a, b) => seqKey(a).localeCompare(seqKey(b)))
    const itemLocIds = new Set(stock.filter(s => s.item_code === form.itemCode).map(s => s.location_id))
    const holdingSL = sl.find(l => itemLocIds.has(l.id))
    if (holdingSL) return { code: holdingSL.code, why: 'already holds this item' }
    const emptySL = sl.find(l => !occupied.has(l.id))
    if (emptySL) return { code: emptySL.code, why: 'empty pick bin' }
    const emptyXS = xs.find(l => !occupied.has(l.id))
    if (emptyXS) return { code: emptyXS.code, why: 'overflow (excess)' }
    return null
  }, [form.itemCode, locs, stock, occupied])

  const binValue = binTouched ? form.bin : (suggestion?.code || form.bin)

  function pickItem(it: Item) {
    setForm(f => ({ ...f, itemCode: it.code, description: it.description, uom: it.unit }))
    setBinTouched(false); setOk(''); setErr('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    const code = binValue.trim().toUpperCase()
    const loc = locByCode.get(code)
    const qty = Number(form.qty)
    if (!form.itemCode) { setErr('Pick an item.'); return }
    if (!loc) { setErr(`Bin "${code}" is not in the Location Map.`); return }
    if (!(qty > 0)) { setErr('Enter a quantity greater than zero.'); return }
    setBusy(true); setErr(''); setOk('')
    const { error } = await supabase.rpc('wms_putaway', {
      p_item_code: form.itemCode, p_location_id: loc.id, p_qty: qty,
      p_batch: form.batch.trim(), p_exp_date: form.exp_date || null, p_reference: form.reference.trim() || null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setOk(`Put ${fmtQty(qty)} ${form.uom || ''} of ${form.itemCode} into ${code}.`)
    setForm(f => ({ ...EMPTY, reference: f.reference }))   // keep reference for a run of putaways
    setBinTouched(false)
    load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Putaway</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">Store incoming goods — the system suggests the best bin, you confirm.</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access, so you can’t book putaways.</p>}

        <form onSubmit={submit} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Item</label>
            <ItemPicker items={items} value={form.itemCode ? `${form.itemCode} — ${form.description}` : ''} onPick={pickItem} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Quantity</label>
              <input value={form.qty} onChange={e => setForm({ ...form, qty: e.target.value.replace(/[^0-9.]/g, '') })}
                className="w-full border rounded-lg px-3 py-2 text-sm" inputMode="decimal" placeholder="0" required />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Batch <span className="text-gray-400 font-normal">(optional)</span></label>
              <input value={form.batch} onChange={e => setForm({ ...form, batch: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="260606" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Expiry <span className="text-gray-400 font-normal">(optional)</span></label>
              <input type="date" value={form.exp_date} onChange={e => setForm({ ...form, exp_date: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Bin</label>
              <input list="wms-bins" value={binValue}
                onChange={e => { setBinTouched(true); setForm({ ...form, bin: e.target.value.toUpperCase() }) }}
                className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="A105" required />
              <datalist id="wms-bins">{locs.filter(l => l.active).slice(0, 2000).map(l => <option key={l.id} value={l.code} />)}</datalist>
              {suggestion && !binTouched && <p className="text-xs text-emerald-700 mt-1">Suggested: <b>{suggestion.code}</b> — {suggestion.why}. Type to choose another.</p>}
              {!suggestion && form.itemCode && <p className="text-xs text-amber-600 mt-1">No free bin suggested — enter one manually.</p>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Reference <span className="text-gray-400 font-normal">(GRN / DO no, optional)</span></label>
              <input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })}
                className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="DO-260613/0596" />
            </div>
          </div>
          {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{err}</p>}
          {ok && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-2 rounded">✓ {ok}</p>}
          <button type="submit" disabled={busy || !canEdit}
            className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
            {busy ? 'Putting away…' : 'Confirm putaway'}
          </button>
        </form>

        <h2 className="text-sm font-semibold text-gray-600 mb-2">Recent putaways</h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Item', 'Bin', 'Batch', 'Qty', 'By', 'When'].map(h => <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {recent.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No putaways yet.</td></tr>}
              {recent.map(m => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5"><span className="font-mono font-medium">{m.item_code}</span> <span className="text-gray-400 text-xs">{m.description}</span></td>
                  <td className="px-4 py-2.5 font-mono">{m.to_location_code}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.batch_no || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 font-medium tabular-nums">{fmtQty(m.quantity)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{m.moved_by_name}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
