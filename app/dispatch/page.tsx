'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface Item { id: string; code: string; description: string; unit: string }
interface Batch {
  id: string; batch_no: string | null; item_code: string; description: string | null
  factory_code: string; total_quantity: number; produced_qty: number | null
  dispatched_at: string | null; delivery_date: string | null
}
interface DOrder {
  id: string; do_number: string | null; factory_code: string; status: string
  created_by_name: string | null; created_at: string
  dispatch_order_lines?: { item_code: string; description: string | null; quantity: number }[]
}
interface MReturn {
  id: string; factory_code: string; item_code: string; description: string | null
  quantity: number; reason: string | null; created_by_name: string | null; created_at: string
}

export default function DispatchPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'dispatch')
  const [items, setItems] = useState<Item[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [onHand, setOnHand] = useState<Record<string, number>>({})
  const [batches, setBatches] = useState<Batch[]>([])
  const [orders, setOrders] = useState<DOrder[]>([])
  const [returns, setReturns] = useState<MReturn[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleFac = (fc: string) => setCollapsed(p => { const n = new Set(p); n.has(fc) ? n.delete(fc) : n.add(fc); return n })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'dispatch', 'edit')

  // return form
  const [factory, setFactory] = useState('')
  const [code, setCode] = useState('')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    setItems(await fetchAll<Item>('items', 'id, code, description, unit', 'code'))
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    if (!isHO && profile) setFactory(profile.factory_code)
    else if (f && f.length && !factory) setFactory(f[0].code)
    const { data: st } = await supabase.from('item_stock').select('item_id, factory_code, quantity')
    const m: Record<string, number> = {}; (st || []).forEach(r => { m[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setOnHand(m)
    const { data: b } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, dispatched_at, delivery_date')
      .is('dispatched_at', null).gt('produced_qty', 0).order('delivery_date')
    setBatches((b as Batch[]) || [])
    const { data: o } = await supabase.from('dispatch_orders')
      .select('id, do_number, factory_code, status, created_by_name, created_at, dispatch_order_lines(item_code, description, quantity)')
      .order('created_at', { ascending: false }).limit(50)
    setOrders((o as DOrder[]) || [])
    const { data: r } = await supabase.from('material_returns').select('*').order('created_at', { ascending: false }).limit(50)
    setReturns((r as MReturn[]) || [])
  }

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'
  const status = (b: Batch) => (Number(b.produced_qty || 0) >= b.total_quantity && b.total_quantity > 0) ? 'Completed' : 'In Progress'
  const resolve = (c: string) => items.find(i => i.code.toLowerCase() === c.trim().toLowerCase())
  const item = resolve(code)
  const onHandQty = item ? (onHand[`${item.id}|${factory}`] ?? 0) : null

  const toggle = (id: string) => setPicked(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  async function createDO() {
    if (picked.size === 0) { setError('Tick at least one item to send.'); return }
    const facs = new Set(batches.filter(b => picked.has(b.id)).map(b => b.factory_code))
    if (facs.size > 1) { setError('Please send one factory at a time — the ticked items are from different factories.'); return }
    if (!confirm(`Create a delivery order for ${picked.size} item(s) and send to the warehouse?`)) return
    setBusy(true); setError(''); setSuccess('')
    const { data, error: e } = await supabase.rpc('create_dispatch_order', { p_batch_ids: Array.from(picked) })
    if (e) { setError(e.message); setBusy(false); return }
    setSuccess(`Delivery order ${data} created — ${picked.size} item(s) sent to warehouse.`)
    setPicked(new Set()); setBusy(false); load()
  }

  async function submitReturn(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setSuccess('')
    const it = resolve(code)
    if (!it) { setError('Pick a valid raw-material code from the list.'); return }
    const num = Number(qty)
    if (!(num > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (!reason.trim()) { setError('Please give a reason for the return.'); return }
    setSaving(true)
    const { error: rErr } = await supabase.rpc('return_material', { p_factory: factory, p_item_code: it.code, p_qty: num, p_reason: reason.trim() })
    if (rErr) { setError(rErr.message); setSaving(false); return }
    setSaving(false)
    setSuccess(`Returned ${num} ${it.unit} of ${it.code} — factory stock reduced.`)
    setCode(''); setQty(''); setReason(''); load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const myCodes = profile.factory_codes && profile.factory_codes.length ? profile.factory_codes : [profile.factory_code]
  const myFactories = isHO ? factories : factories.filter(f => myCodes.includes(f.code))
  const facList = [...new Set(batches.map(b => b.factory_code))]
  const multiFac = isHO || facList.length > 1

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Delivery Orders</h1>
        <p className="text-gray-500 text-sm mb-5">Send finished goods to the warehouse, or return raw materials.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {/* ---- Finished goods to deliver ---- */}
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">Finished goods ready to send</h2>
          {canEdit && <button onClick={createDO} disabled={busy || picked.size === 0} className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">Create delivery order{picked.size ? ` (${picked.size})` : ''}</button>}
        </div>

        {/* mobile cards */}
        <div className="md:hidden space-y-2 mb-8">
          {batches.length === 0 && <p className="text-gray-400 text-sm bg-white border rounded-xl p-6 text-center">Nothing produced yet to send.</p>}
          {batches.map(b => (
            <label key={b.id} className="flex gap-3 bg-white border rounded-xl p-3 shadow-sm">
              {canEdit && <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} className="mt-1 h-4 w-4" />}
              <div className="flex-1 text-sm">
                <div className="font-mono font-medium">{b.item_code}</div>
                <div className="text-gray-500">{b.description}</div>
                <div className="text-gray-500 mt-1">Qty: <strong>{b.produced_qty}</strong> · <span className={status(b) === 'Completed' ? 'text-green-700' : 'text-amber-600'}>{status(b)}</span></div>
                <div className="text-gray-400 text-xs mt-0.5">{b.batch_no || '—'}{multiFac ? ` · ${factoryName(b.factory_code)}` : ''}</div>
              </div>
            </label>
          ))}
        </div>

        {/* desktop table */}
        <div className="hidden md:block bg-white rounded-xl shadow-sm border overflow-auto max-h-[24rem] mb-8">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['', 'Item', 'Batch', 'Produced', 'Status', ...(multiFac ? ['Factory'] : []), 'Delivery date'].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">Nothing produced yet to send.</td></tr>}
              {facList.map(fc => (
                <Fragment key={fc}>
                  {multiFac && (
                    <tr className="bg-gray-50 border-b cursor-pointer hover:bg-gray-100" onClick={() => toggleFac(fc)}>
                      <td colSpan={7} className="px-3 py-1.5 font-semibold text-gray-700"><span className="text-gray-400 mr-1">{collapsed.has(fc) ? '▸' : '▾'}</span>🏭 {factoryName(fc)} <span className="text-gray-400 font-normal">· {batches.filter(b => b.factory_code === fc).length}</span></td>
                    </tr>
                  )}
                  {!collapsed.has(fc) && batches.filter(b => b.factory_code === fc).map(b => (
                    <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2">{canEdit && <input type="checkbox" checked={picked.has(b.id)} onChange={() => toggle(b.id)} className="h-4 w-4" />}</td>
                      <td className="px-3 py-2"><span className="font-mono font-medium">{b.item_code}</span><span className="block text-gray-400">{b.description}</span></td>
                      <td className="px-3 py-2 whitespace-nowrap">{b.batch_no || '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold">{b.produced_qty}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{status(b) === 'Completed' ? <span className="text-green-700 font-medium">Completed</span> : <span className="text-amber-600">In Progress</span>}</td>
                      {multiFac && <td className="px-3 py-2 whitespace-nowrap text-gray-600">{factoryName(b.factory_code)}</td>}
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? b.delivery_date.split('-').reverse().join('/') : '—'}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* ---- Raw material return ---- */}
        <h2 className="text-lg font-semibold mb-2">Return raw material</h2>
        <p className="text-gray-500 text-xs mb-3">Sending material back reduces factory stock immediately (oldest expiry first).</p>
        {canEdit && (
          <form onSubmit={submitReturn} className="bg-white border rounded-xl shadow-sm p-4 mb-8">
            <div className="flex flex-wrap gap-4 items-end">
              {myFactories.length > 1 ? (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory (location)</span>
                  <select value={factory} onChange={e => setFactory(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-white">
                    {myFactories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                  </select></div>
              ) : (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory (location)</span>
                  <div className="border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-700 min-w-[140px]">{factoryName(factory)}</div></div>
              )}
              <div className="flex flex-col gap-1 min-w-[200px] flex-1"><span className="text-xs font-medium text-gray-600">Material</span>
                <input list="ret-items" value={code} onChange={e => setCode(e.target.value)} placeholder="Type code…" className="border rounded px-2 py-1.5 text-sm" />
                <datalist id="ret-items">{items.map(i => <option key={i.id} value={i.code}>{i.description}</option>)}</datalist>
                {item ? <span className="text-xs text-gray-500">{item.description} · on hand: <strong>{onHandQty}</strong> {item.unit}</span> : code ? <span className="text-xs text-red-500">Unknown code</span> : null}
              </div>
              <div className="flex flex-col gap-1 w-28"><span className="text-xs font-medium text-gray-600">Quantity {item ? `(${item.unit})` : ''}</span>
                <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
              <div className="flex flex-col gap-1 min-w-[220px] flex-1"><span className="text-xs font-medium text-gray-600">Reason</span>
                <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is it being returned?" className="border rounded px-2 py-1.5 text-sm" /></div>
              <button disabled={saving} className="bg-orange-600 text-white px-5 py-2 rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : 'Return material'}</button>
            </div>
            {item && onHandQty !== null && Number(qty) > onHandQty && <p className="text-amber-600 text-xs mt-2">⚠ Returning more than on-hand ({onHandQty}). This will fail — there isn’t enough stock.</p>}
          </form>
        )}

        {/* ---- History ---- */}
        <h2 className="text-lg font-semibold mb-2">Recent delivery orders</h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[20rem] mb-8">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10"><tr>{['DO No.', ...(multiFac ? ['Factory'] : []), 'Items', 'By', 'When'].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">No delivery orders yet.</td></tr>}
              {orders.map(o => (
                <tr key={o.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{o.do_number}</td>
                  {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(o.factory_code)}</td>}
                  <td className="px-3 py-2 text-gray-600">{(o.dispatch_order_lines || []).map((l, i) => <span key={i} className="block"><span className="font-mono">{l.item_code}</span> × {l.quantity}</span>)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{o.created_by_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="text-lg font-semibold mb-2">Recent material returns</h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[20rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10"><tr>{[...(multiFac ? ['Factory'] : []), 'Material', 'Qty', 'Reason', 'By', 'When'].map((h, i) => <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {returns.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No returns yet.</td></tr>}
              {returns.map(r => (
                <tr key={r.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  {multiFac && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(r.factory_code)}</td>}
                  <td className="px-3 py-2"><span className="font-mono font-medium">{r.item_code}</span><span className="block text-gray-400">{r.description}</span></td>
                  <td className="px-3 py-2 text-right font-semibold">{r.quantity}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{r.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{r.created_by_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
