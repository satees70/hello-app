'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface Item { code: string; description: string; unit: string }
interface Loc { id: string; code: string; location_type: string; active: boolean }
interface Stock { id: string; location_id: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number }
interface Move { id: string; item_code: string; from_location_code: string | null; to_location_code: string | null; batch_no: string; quantity: number; reference: string | null; moved_by_name: string | null; created_at: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function WmsTransfersPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [mode, setMode] = useState<'transfer' | 'replenish'>('transfer')
  const [items, setItems] = useState<Item[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [recent, setRecent] = useState<Move[]>([])

  const [itemCode, setItemCode] = useState(''); const [itemDesc, setItemDesc] = useState('')
  const [itemStock, setItemStock] = useState<Stock[]>([])
  const [fromId, setFromId] = useState('')
  const [toBin, setToBin] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [ok, setOk] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [it, lo, mv] = await Promise.all([
      fetchAll<Item>('items', 'code, description, unit', 'code'),
      fetchAll<Loc>('wms_locations', 'id, code, location_type, active', 'code'),
      supabase.from('wms_stock_moves').select('id, item_code, from_location_code, to_location_code, batch_no, quantity, reference, moved_by_name, created_at')
        .eq('move_type', 'transfer').order('created_at', { ascending: false }).limit(30),
    ])
    setItems(it); setLocs(lo); setRecent((mv.data as Move[]) || [])
  }

  const locByCode = useMemo(() => new Map(locs.map(l => [l.code.toUpperCase(), l])), [locs])
  const typeById = useMemo(() => new Map(locs.map(l => [l.id, l.location_type])), [locs])

  const loadItemStock = useCallback(async (code: string) => {
    const { data } = await supabase.from('wms_stock').select('id, location_id, location_code, batch_no, exp_date, quantity')
      .eq('item_code', code).gt('quantity', 0)
    setItemStock((data as Stock[]) || [])
  }, [])

  function pickItem(it: Item) {
    setItemCode(it.code); setItemDesc(it.description); setFromId(''); setToBin(''); setQty(''); setErr(''); setOk('')
    loadItemStock(it.code)
  }

  const slRows = itemStock.filter(s => typeById.get(s.location_id) === 'SL')
  const xsRows = itemStock.filter(s => typeById.get(s.location_id) === 'XS')
  const xsTotal = clean(xsRows.reduce((s, r) => s + r.quantity, 0))
  const fromRow = itemStock.find(s => s.id === fromId)

  async function doTransfer() {
    if (!canEdit) return
    const to = locByCode.get(toBin.trim().toUpperCase())
    const n = Number(qty)
    if (!fromRow) { setErr('Choose the source bin/batch.'); return }
    if (!to) { setErr(`Destination bin "${toBin}" is not in the Location Map.`); return }
    if (!(n > 0)) { setErr('Enter a quantity greater than zero.'); return }
    setBusy(true); setErr(''); setOk('')
    const { data, error } = await supabase.rpc('wms_transfer', {
      p_item_code: itemCode, p_from_location_id: fromRow.location_id, p_from_batch: fromRow.batch_no,
      p_to_location_id: to.id, p_qty: n, p_reference: null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    const r = data as { moved: number }
    setOk(`Moved ${fmtQty(r.moved)} of ${itemCode} from ${fromRow.location_code} to ${to.code}.`)
    setQty(''); loadItemStock(itemCode); load()
  }

  async function doReplenish() {
    if (!canEdit) return
    const to = locByCode.get(toBin.trim().toUpperCase())
    const n = Number(qty)
    if (!itemCode) { setErr('Pick an item.'); return }
    if (!to) { setErr(`Pick bin "${toBin}" is not in the Location Map.`); return }
    if (!(n > 0)) { setErr('Enter a quantity greater than zero.'); return }
    setBusy(true); setErr(''); setOk('')
    const { data, error } = await supabase.rpc('wms_replenish', {
      p_item_code: itemCode, p_to_location_id: to.id, p_qty: n, p_reference: null,
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    const r = data as { moved: number; shortfall: number }
    setOk(r.shortfall > 0
      ? `Moved ${fmtQty(r.moved)} into ${to.code} — short by ${fmtQty(r.shortfall)} (not enough in XS overflow).`
      : `Moved ${fmtQty(r.moved)} of ${itemCode} into pick bin ${to.code}.`)
    setQty(''); loadItemStock(itemCode); load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Transfers</h1>
        <p className="text-gray-500 text-sm mt-1 mb-5">Move stock between bins, or top up a pick bin from its excess (XS) overflow.</p>

        <div className="inline-flex rounded-lg border bg-white p-1 mb-5 text-sm">
          {(['transfer', 'replenish'] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setErr(''); setOk('') }}
              className={`px-4 py-1.5 rounded-md font-medium ${mode === m ? 'bg-emerald-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              {m === 'transfer' ? 'Move between bins' : 'Replenish pick bin'}
            </button>
          ))}
        </div>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access, so you can’t move stock.</p>}

        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Item</label>
            <ItemPicker items={items} value={itemCode ? `${itemCode} — ${itemDesc}` : ''} onPick={pickItem} />
          </div>

          {itemCode && itemStock.length === 0 && <p className="text-sm text-amber-600">No stock of this item in any bin yet.</p>}

          {mode === 'transfer' && itemStock.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-1">
                <label className="block text-sm font-medium mb-1">From bin / batch</label>
                <select value={fromId} onChange={e => { setFromId(e.target.value); const r = itemStock.find(s => s.id === e.target.value); setQty(r ? String(clean(r.quantity)) : '') }}
                  className="w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">Choose…</option>
                  {itemStock.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.location_code} [{typeById.get(s.location_id)}]{s.batch_no ? ` · b:${s.batch_no}` : ''}{s.exp_date ? ` · exp ${fmtDate(s.exp_date)}` : ''} — {fmtQty(s.quantity)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">To bin</label>
                <input list="wms-tbins" value={toBin} onChange={e => setToBin(e.target.value.toUpperCase())}
                  className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="A106" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Quantity</label>
                <input value={qty} onChange={e => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                  className="w-full border rounded-lg px-3 py-2 text-sm text-right tabular-nums" inputMode="decimal" placeholder="0" />
              </div>
            </div>
          )}

          {mode === 'replenish' && itemCode && (
            <>
              <div className="text-xs text-gray-500 bg-gray-50 border rounded-lg p-3">
                Pick bins (SL): {slRows.length ? slRows.map(s => `${s.location_code} ${fmtQty(s.quantity)}`).join(' · ') : 'none'}
                <br />Available in overflow (XS): <b>{fmtQty(xsTotal)}</b>{xsRows.length ? ` across ${xsRows.length} bin(s)` : ''}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Into pick bin (SL)</label>
                  <input list="wms-slbins" value={toBin} onChange={e => setToBin(e.target.value.toUpperCase())}
                    className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="A105" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Quantity to top up</label>
                  <input value={qty} onChange={e => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
                    className="w-full border rounded-lg px-3 py-2 text-sm text-right tabular-nums" inputMode="decimal" placeholder="0" />
                </div>
              </div>
            </>
          )}

          <datalist id="wms-tbins">{locs.filter(l => l.active).slice(0, 2000).map(l => <option key={l.id} value={l.code} />)}</datalist>
          <datalist id="wms-slbins">{locs.filter(l => l.active && l.location_type === 'SL').slice(0, 2000).map(l => <option key={l.id} value={l.code} />)}</datalist>

          {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{err}</p>}
          {ok && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-2 rounded">✓ {ok}</p>}

          <button onClick={mode === 'transfer' ? doTransfer : doReplenish} disabled={busy || !canEdit || !itemCode}
            className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
            {busy ? 'Moving…' : mode === 'transfer' ? 'Move stock' : 'Replenish pick bin'}
          </button>
        </div>

        <h2 className="text-sm font-semibold text-gray-600 mb-2">Recent transfers</h2>
        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Item', 'From', 'To', 'Batch', 'Qty', 'By', 'When'].map(h => <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {recent.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">No transfers yet.</td></tr>}
              {recent.map(m => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-mono font-medium">{m.item_code}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.from_location_code}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.to_location_code}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.batch_no || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 font-medium tabular-nums">{fmtQty(m.quantity)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{m.moved_by_name}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(m.created_at)}{m.reference === 'replenish' ? ' · replenish' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per transfer */}
        <div className="sm:hidden space-y-2">
          {recent.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No transfers yet.</div>}
          {recent.map(m => (
            <div key={m.id} className="bg-white rounded-xl border shadow-sm p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono font-semibold text-sm">{m.item_code}</div>
                <div className="font-medium tabular-nums shrink-0">{fmtQty(m.quantity)}</div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-gray-600">
                <span className="font-mono">{m.from_location_code} → {m.to_location_code}</span>
                <span>Batch: <span className="font-mono">{m.batch_no || '—'}</span></span>
              </div>
              <div className="mt-1 text-xs text-gray-500">{m.moved_by_name} · {fmtTime(m.created_at)}{m.reference === 'replenish' ? ' · replenish' : ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
