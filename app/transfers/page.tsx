'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import ItemPicker from '@/components/ItemPicker'

interface TItem { item_code: string; description: string | null; unit: string | null; qty: number | null; batch_no: string | null; exp_date: string | null }
interface Transfer {
  id: string; from_factory: string; to_factory: string; reason: string | null; status: string
  created_by_name: string | null; created_at: string
  sent_by_name: string | null; sent_at: string | null
  received_by_name: string | null; received_at: string | null
  items: TItem[]
}

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700', Sent: 'bg-blue-100 text-blue-700', Received: 'bg-green-100 text-green-700',
}

export default function TransfersPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'material_requests')
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<'all' | 'Pending' | 'Sent' | 'Received'>('all')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // New-transfer form
  const [itemsMaster, setItemsMaster] = useState<{ code: string; description: string; unit: string }[]>([])
  const [fromF, setFromF] = useState('')
  const [toF, setToF] = useState('')
  const [reason, setReason] = useState('')
  const [cart, setCart] = useState<{ code: string; description: string; unit: string; qty: number; batchNo: string | null; expDate: string | null; lotId: string }[]>([])
  const [pickItem, setPickItem] = useState<{ code: string; description: string; unit: string } | null>(null)
  const [pickQty, setPickQty] = useState('')
  const [pickLotId, setPickLotId] = useState('')
  const [lotsByCodeFac, setLotsByCodeFac] = useState<Record<string, { id: string; batch_no: string | null; exp_date: string | null; qty_remaining: number }[]>>({})

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const myFacs = new Set(isHO ? [] : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : [])))
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const canSend = (t: Transfer) => t.status === 'Pending' && (isHO || myFacs.has(t.from_factory))
  const canReceive = (t: Transfer) => t.status === 'Sent' && (isHO || myFacs.has(t.to_factory))

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const [{ data: t }, { data: f }] = await Promise.all([
      supabase.from('material_transfers').select('*').order('created_at', { ascending: false }),
      supabase.from('factories').select('code, name').order('code'),
    ])
    setFactories(f || [])
    const ids = (t || []).map(x => x.id)
    let itemsByT: Record<string, TItem[]> = {}
    if (ids.length) {
      const { data: its } = await supabase.from('material_transfer_items').select('transfer_id, item_code, description, unit, qty, batch_no, exp_date').in('transfer_id', ids)
      ;(its || []).forEach(it => { (itemsByT[it.transfer_id] = itemsByT[it.transfer_id] || []).push(it) })
    }
    setTransfers((t || []).map(x => ({ ...x, items: itemsByT[x.id] || [] })))
    if (itemsMaster.length === 0) setItemsMaster(await fetchAll<{ code: string; description: string; unit: string }>('items', 'code, description, unit', qb => qb.order('code')))
    // Stock lots per item-code per factory (so a transfer carries a specific batch + expiry).
    const lm: Record<string, { id: string; batch_no: string | null; exp_date: string | null; qty_remaining: number }[]> = {}
    const lots = await fetchAll<{ id: string; item_code: string; factory_code: string; batch_no: string | null; exp_date: string | null; qty_remaining: number }>('stock_lots', 'id, item_code, factory_code, batch_no, exp_date, qty_remaining', qb => qb.gt('qty_remaining', 0))
    lots.forEach(r => { const k = `${r.item_code}|${r.factory_code}`; (lm[k] = lm[k] || []).push({ id: r.id, batch_no: r.batch_no, exp_date: r.exp_date, qty_remaining: Number(r.qty_remaining || 0) }) })
    setLotsByCodeFac(lm)
  }
  const lotsFor = (code: string, fac: string) => lotsByCodeFac[`${code}|${fac}`] || []
  const fmtD = (d: string | null) => d ? d.split('-').reverse().join('/') : 'no expiry'
  function addCartItem() {
    if (!pickItem) { setError('Pick an item.'); return }
    if (!fromF) { setError('Pick the From factory first.'); return }
    const lot = lotsFor(pickItem.code, fromF).find(l => l.id === pickLotId)
    if (!lot) { setError('Pick the batch to transfer.'); return }
    const q = Number(pickQty)
    if (!(q > 0)) { setError('Enter a quantity.'); return }
    if (q > lot.qty_remaining) { setError(`Batch ${lot.batch_no || '(no batch)'} has only ${lot.qty_remaining} ${pickItem.unit || ''} left.`); return }
    setError('')
    setCart(c => [...c, { code: pickItem.code, description: pickItem.description, unit: pickItem.unit, qty: q, batchNo: lot.batch_no, expDate: lot.exp_date, lotId: lot.id }])
    setPickItem(null); setPickQty(''); setPickLotId('')
  }
  async function createTransfer() {
    if (!fromF || !toF) { setError('Pick the from and to factory.'); return }
    if (fromF === toF) { setError('From and To must be different.'); return }
    if (cart.length === 0) { setError('Add at least one item.'); return }
    const over = cart.find(c => { const lot = lotsFor(c.code, fromF).find(l => l.id === c.lotId); return !lot || c.qty > lot.qty_remaining })
    if (over) { setError(`Batch ${over.batchNo || '(no batch)'} of ${over.code} doesn't have enough at ${factoryName(fromF)} — reduce the quantity.`); return }
    setBusy('new'); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('create_material_transfer', { p_from: fromF, p_to: toF, p_reason: reason || null, p_items: cart.map(c => ({ code: c.code, qty: c.qty, batch_no: c.batchNo, exp_date: c.expDate, lot_id: c.lotId })) })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Transfer created — ${factoryName(fromF)} → ${factoryName(toF)}. Now confirm dispatch.`)
    setFromF(''); setToF(''); setReason(''); setCart([]); load()
  }

  async function act(rpc: 'confirm_transfer_send' | 'confirm_transfer_receive', id: string, msg: string) {
    setBusy(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc(rpc, { p_id: id })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(msg); load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = transfers.filter(t => filter === 'all' || t.status === filter)

  return (
    <>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h1 className="text-2xl font-bold">Material Transfers</h1>
          <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} className="border rounded-lg px-3 py-1.5 text-sm">
            <option value="all">All</option>
            <option value="Pending">Pending (to send)</option>
            <option value="Sent">Sent (to receive)</option>
            <option value="Received">Received</option>
          </select>
        </div>
        <p className="text-gray-500 mb-5 text-sm">Materials moving between factories. The sending factory confirms dispatch, then the receiving factory confirms receipt — stock moves on each step.</p>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {success && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{success}</div>}

        {/* New transfer */}
        <div className="border rounded-2xl p-4 sm:p-5 bg-white shadow-sm mb-8">
          <h2 className="font-semibold mb-3">New transfer</h2>
          <div className="grid sm:grid-cols-2 gap-3 mb-3">
            <label className="block"><span className="text-xs text-gray-500">From factory (stock leaves here)</span>
              <select value={fromF} onChange={e => setFromF(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">Choose…</option>
                {factories.filter(f => isHO || myFacs.has(f.code)).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
              </select></label>
            <label className="block"><span className="text-xs text-gray-500">To factory (stock arrives here)</span>
              <select value={toF} onChange={e => setToF(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">Choose…</option>
                {factories.filter(f => f.code !== fromF).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
              </select></label>
          </div>
          <div className="flex flex-wrap items-end gap-2 mb-3">
            <div className="flex-1 min-w-[200px]"><span className="text-xs text-gray-500">Item</span><ItemPicker items={itemsMaster} value={pickItem ? `${pickItem.code} — ${pickItem.description}` : ''} onPick={it => { setPickItem(it); setPickLotId(''); setPickQty('') }} /></div>
            <div className="min-w-[220px]"><span className="text-xs text-gray-500">Batch (at {fromF ? factoryName(fromF) : 'from factory'})</span>
              <select value={pickLotId} onChange={e => setPickLotId(e.target.value)} disabled={!pickItem || !fromF} className="w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:bg-gray-50">
                <option value="">{pickItem && fromF ? (lotsFor(pickItem.code, fromF).length ? 'Choose a batch…' : 'No stock at this factory') : 'Pick item & from factory'}</option>
                {pickItem && fromF && lotsFor(pickItem.code, fromF).map(l => <option key={l.id} value={l.id}>{l.batch_no || '(no batch)'} · exp {fmtD(l.exp_date)} · {l.qty_remaining} left</option>)}
              </select></div>
            <div className="w-24"><span className="text-xs text-gray-500">Qty</span><input type="number" step="any" min="0" value={pickQty} onChange={e => setPickQty(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
            <button onClick={addCartItem} className="px-4 py-2 rounded-lg border border-blue-600 text-blue-600 text-sm font-medium hover:bg-blue-50">+ Add item</button>
          </div>
          {cart.length > 0 && (
            <ul className="mb-3 space-y-1">
              {cart.map((c, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-sm border-b border-gray-100 py-1">
                  <span><span className="font-mono">{c.code}</span> <span className="text-gray-500">{c.description}</span> · {c.qty} {c.unit} · <span className="text-gray-500">batch {c.batchNo || '(none)'} · exp {fmtD(c.expDate)}</span></span>
                  <button onClick={() => setCart(x => x.filter((_, j) => j !== i))} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                </li>
              ))}
            </ul>
          )}
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" className="w-full border rounded-lg px-3 py-2 text-sm mb-3" />
          <button onClick={createTransfer} disabled={busy === 'new'} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">{busy === 'new' ? 'Creating…' : 'Create transfer'}</button>
          <p className="text-xs text-gray-400 mt-2">After creating, the sending factory confirms dispatch (stock leaves), then the receiving factory confirms receipt (stock arrives).</p>
        </div>

        {shown.length === 0 && <p className="text-gray-400 text-sm">No transfers.</p>}
        <div className="space-y-3">
          {shown.map(t => (
            <div key={t.id} className="border rounded-xl p-4 bg-white shadow-sm">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="font-semibold">
                  {factoryName(t.from_factory)} <span className="text-gray-400">→</span> {factoryName(t.to_factory)}
                  <span className="text-gray-400 text-sm font-normal ml-2">{new Date(t.created_at).toLocaleDateString()}{t.created_by_name ? ` · by ${t.created_by_name}` : ''}</span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${STATUS_STYLE[t.status] || 'bg-gray-100 text-gray-600'}`}>{t.status}</span>
              </div>
              {t.reason && <div className="text-xs text-gray-500 mt-0.5">{t.reason}</div>}
              <div className="mt-2 border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-left"><tr><th className="px-3 py-1.5">Material</th><th className="px-3 py-1.5">Description</th><th className="px-3 py-1.5">Batch</th><th className="px-3 py-1.5">Expiry</th><th className="px-3 py-1.5 text-right">Qty</th></tr></thead>
                  <tbody>
                    {t.items.map((it, i) => (
                      <tr key={i} className="border-t"><td className="px-3 py-1.5 font-mono">{it.item_code}</td><td className="px-3 py-1.5 text-gray-600">{it.description}</td><td className="px-3 py-1.5 font-mono">{it.batch_no || '—'}</td><td className="px-3 py-1.5">{fmtD(it.exp_date)}</td><td className="px-3 py-1.5 text-right">{it.qty} {it.unit}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex items-center justify-between flex-wrap gap-2">
                <div className="text-[11px] text-gray-500">
                  {t.sent_at && <span className="mr-3">Dispatched by {t.sent_by_name} · {new Date(t.sent_at).toLocaleString()}</span>}
                  {t.received_at && <span>Received by {t.received_by_name} · {new Date(t.received_at).toLocaleString()}</span>}
                </div>
                <div className="flex gap-2">
                  {canSend(t) && <button onClick={() => act('confirm_transfer_send', t.id, 'Dispatch confirmed — stock left ' + factoryName(t.from_factory) + '.')} disabled={busy === t.id} className="text-sm px-3 py-1.5 rounded-lg bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50">{busy === t.id ? '…' : 'Confirm dispatch'}</button>}
                  {canReceive(t) && <button onClick={() => act('confirm_transfer_receive', t.id, 'Receipt confirmed — stock added to ' + factoryName(t.to_factory) + '.')} disabled={busy === t.id} className="text-sm px-3 py-1.5 rounded-lg bg-green-700 text-white hover:bg-green-800 disabled:opacity-50">{busy === t.id ? '…' : 'Confirm receipt'}</button>}
                  {t.status === 'Pending' && !canSend(t) && <span className="text-xs text-gray-400">waiting for {factoryName(t.from_factory)} to dispatch</span>}
                  {t.status === 'Sent' && !canReceive(t) && <span className="text-xs text-gray-400">waiting for {factoryName(t.to_factory)} to receive</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
