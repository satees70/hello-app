'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import ItemPicker from '@/components/ItemPicker'

type Item = { code: string; description: string; unit: string }
type RepackLine = Item & { qty: number }
interface RepackOrder {
  id: string; repack_no: string; factory_code: string; note: string | null; status: string
  created_at: string; created_by_name: string | null; reviewed_by_name: string | null
  items: { item_code: string; description: string | null; qty: number | null; unit: string | null }[]
}

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700', Approved: 'bg-green-100 text-green-700', Rejected: 'bg-gray-200 text-gray-600',
}

export default function RepackingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'sales')

  const [items, setItems] = useState<Item[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [orders, setOrders] = useState<RepackOrder[]>([])

  const [fac, setFac] = useState('')
  const [customer, setCustomer] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [pickItem, setPickItem] = useState<Item | null>(null)
  const [qty, setQty] = useState('')
  const [lines, setLines] = useState<RepackLine[]>([])

  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'Pending' | 'Approved' | 'Rejected'>('all')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const myFacs = new Set(isHO ? [] : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : [])))
  const facOpts = factories.map(f => f.code)
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const canApprove = (o: RepackOrder) => o.status === 'Pending' && (isHO || myFacs.has(o.factory_code))

  useEffect(() => { if (profile) load() }, [profile])
  useEffect(() => { if (!fac && facOpts.length) setFac(facOpts[0]) }, [facOpts, fac])

  async function load() {
    const [{ data: it }, { data: f }, { data: ro }] = await Promise.all([
      supabase.from('items').select('code, description, unit').order('code'),
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('repack_orders').select('id, repack_no, factory_code, note, status, created_at, created_by_name, reviewed_by_name').order('created_at', { ascending: false }),
    ])
    setItems(it || [])
    setFactories(f || [])
    const ros = ro || []
    const ids = ros.map(d => d.id)
    let itemsByRo: Record<string, RepackOrder['items']> = {}
    if (ids.length) {
      const { data: ri } = await supabase.from('repack_order_items').select('repack_id, item_code, description, qty, unit').in('repack_id', ids)
      ;(ri || []).forEach(l => { (itemsByRo[l.repack_id] = itemsByRo[l.repack_id] || []).push(l) })
    }
    setOrders(ros.map(d => ({ ...d, items: itemsByRo[d.id] || [] })))
  }

  function addLine() {
    if (!pickItem) { setError('Pick an item to repack.'); return }
    const q = Number(qty)
    if (!(q > 0)) { setError('Enter a quantity greater than zero.'); return }
    setError('')
    setLines(prev => [...prev, { ...pickItem, qty: q }])
    setPickItem(null); setQty('')
  }
  function removeLine(i: number) { setLines(prev => prev.filter((_, x) => x !== i)) }

  async function submit() {
    if (!fac) { setError('Pick a factory to repack at.'); return }
    const pending = pickItem && Number(qty) > 0 ? [{ ...pickItem, qty: Number(qty) }] : []
    const all = [...lines, ...pending]
    if (all.length === 0) { setError('Add at least one item with a quantity.'); return }
    const payload = all.map(l => ({ code: l.code, description: l.description, unit: l.unit, qty: l.qty }))
    setBusy('create'); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('create_repack_order', {
      p_factory: fac, p_customer: customer.trim() || null, p_delivery_date: deliveryDate || null, p_items: payload,
    })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Repack order created — waiting for ${factoryName(fac)} to approve.`)
    setLines([]); setPickItem(null); setQty(''); setCustomer(''); setDeliveryDate('')
    load()
  }

  async function approve(o: RepackOrder) {
    setBusy(o.id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_repack_order', { p_id: o.id })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Approved — ${o.items.length} batch(es) created at ${factoryName(o.factory_code)} for production.`)
    load()
  }
  async function reject(o: RepackOrder) {
    if (!confirm('Reject this repack order?')) return
    setBusy(o.id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_repack_order', { p_id: o.id })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess('Repack order rejected.')
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const previewLines = [...lines, ...(pickItem && Number(qty) > 0 ? [{ ...pickItem, qty: Number(qty) }] : [])]
  const shown = orders.filter(o => statusFilter === 'all' || o.status === statusFilter)

  return (
    <>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <h1 className="text-2xl font-bold mb-1">Repacking</h1>
        <p className="text-gray-500 mb-5 text-sm">
          Key in the items and quantities to repack (no document to upload). Once created, the chosen factory
          approves it — then it goes to production (schedule → request materials → CCP → Delivery Order).
        </p>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {success && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{success}</div>}

        {/* New repack order */}
        <div className="border rounded-2xl p-4 sm:p-5 bg-white shadow-sm mb-8">
          <h2 className="font-semibold mb-3">New repack order</h2>
          <div className="grid sm:grid-cols-3 gap-3 mb-4">
            <label className="block">
              <span className="text-xs text-gray-500">Factory (where to repack &amp; who approves)</span>
              <select value={fac} onChange={e => setFac(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                {facOpts.length === 0 && <option value="">No factory</option>}
                {facOpts.map(c => <option key={c} value={c}>{factoryName(c)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">For / note (optional)</span>
              <input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="e.g. stock, customer name"
                className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Needed by (optional)</span>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </label>
          </div>

          <div className="grid sm:grid-cols-[1fr_140px_auto] gap-3 items-end mb-3">
            <label className="block">
              <span className="text-xs text-gray-500">Item to repack</span>
              <div className="mt-1"><ItemPicker items={items} value={pickItem?.code || ''} onPick={setPickItem} /></div>
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">Qty {pickItem ? `(${pickItem.unit})` : ''}</span>
              <input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </label>
            <button type="button" onClick={addLine} className="px-4 py-2 rounded-lg border bg-gray-50 hover:bg-gray-100 text-sm font-medium">
              Add item
            </button>
          </div>

          {previewLines.length > 0 && (
            <div className="border rounded-lg overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-left">
                  <tr><th className="px-3 py-2">Item</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Qty</th><th></th></tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2 font-mono">{l.code}</td>
                      <td className="px-3 py-2 text-gray-600">{l.description}</td>
                      <td className="px-3 py-2 text-right">{l.qty} {l.unit}</td>
                      <td className="px-3 py-2 text-right"><button onClick={() => removeLine(i)} className="text-red-600 hover:underline text-xs">Remove</button></td>
                    </tr>
                  ))}
                  {pickItem && Number(qty) > 0 && (
                    <tr className="border-t bg-blue-50/40">
                      <td className="px-3 py-2 font-mono">{pickItem.code}</td>
                      <td className="px-3 py-2 text-gray-600">{pickItem.description}</td>
                      <td className="px-3 py-2 text-right">{Number(qty)} {pickItem.unit}</td>
                      <td className="px-3 py-2 text-right text-xs text-gray-400">not added yet</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <button type="button" onClick={submit} disabled={busy === 'create' || facOpts.length === 0}
            className="px-5 py-2.5 rounded-lg bg-blue-700 text-white text-sm font-semibold hover:bg-blue-800 disabled:opacity-50">
            {busy === 'create' ? 'Creating…' : 'Create repack order'}
          </button>
        </div>

        {/* Existing repack orders */}
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold">Repack orders</h2>
          <label className="flex items-center gap-2 text-sm text-gray-500">
            Status
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
              className="border rounded-lg px-3 py-1.5 text-sm text-gray-700">
              <option value="all">All</option>
              <option value="Pending">Pending approval</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
            </select>
          </label>
        </div>
        {orders.length === 0 ? <p className="text-gray-400 text-sm">No repack orders yet.</p>
          : shown.length === 0 ? <p className="text-gray-400 text-sm">No orders match this status.</p> : (
          <div className="space-y-3">
            {shown.map(o => (
              <div key={o.id} className="border rounded-xl p-4 bg-white shadow-sm">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <span className="font-semibold">Repack {o.repack_no}</span>
                    <span className="text-gray-400 text-sm ml-2">{factoryName(o.factory_code)} · {new Date(o.created_at).toLocaleDateString()}{o.created_by_name ? ` · by ${o.created_by_name}` : ''}{o.note ? ` · ${o.note}` : ''}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded-full ${STATUS_STYLE[o.status] || 'bg-gray-100 text-gray-600'}`}>{o.status === 'Pending' ? 'Pending approval' : o.status}{o.reviewed_by_name && o.status !== 'Pending' ? ` · ${o.reviewed_by_name}` : ''}</span>
                    {canApprove(o) && <>
                      <button onClick={() => approve(o)} disabled={busy === o.id} className="text-xs px-3 py-1 rounded-lg bg-green-700 text-white hover:bg-green-800 disabled:opacity-50">{busy === o.id ? '…' : 'Approve'}</button>
                      <button onClick={() => reject(o)} disabled={busy === o.id} className="text-xs px-3 py-1 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">Reject</button>
                    </>}
                  </div>
                </div>
                <div className="mt-2 text-sm text-gray-600">
                  {o.items.map((l, i) => (
                    <span key={i} className="inline-block mr-3"><span className="font-mono">{l.item_code}</span> × {l.qty}</span>
                  ))}
                </div>
                {o.status === 'Pending' && !canApprove(o) && <div className="text-[11px] text-gray-400 mt-1">Waiting for {factoryName(o.factory_code)} to approve.</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
