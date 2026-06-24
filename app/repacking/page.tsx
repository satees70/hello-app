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
  id: string; file_name: string; factory_code: string; status: string; created_at: string
  lines: { item_code: string; description: string; quantity: number }[]
  confirmed: boolean
}

export default function RepackingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'sales')

  const [items, setItems] = useState<Item[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [orders, setOrders] = useState<RepackOrder[]>([])

  // New repack order being keyed in
  const [fac, setFac] = useState('')
  const [customer, setCustomer] = useState('')
  const [deliveryDate, setDeliveryDate] = useState('')
  const [pickItem, setPickItem] = useState<Item | null>(null)
  const [qty, setQty] = useState('')
  const [lines, setLines] = useState<RepackLine[]>([])

  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'sent' | 'pending'>('all')

  // List every factory/location to pick from — the create RPC is the authority
  // on what this user may actually repack at.
  const facOpts = factories.map(f => f.code)
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c

  useEffect(() => { if (profile) load() }, [profile])
  useEffect(() => { if (!fac && facOpts.length) setFac(facOpts[0]) }, [facOpts, fac])

  async function load() {
    const [{ data: it }, { data: f }, { data: imp }] = await Promise.all([
      supabase.from('items').select('code, description, unit').order('code'),
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('sales_imports').select('id, file_name, factory_code, status, created_at').eq('is_repack', true).order('created_at', { ascending: false }),
    ])
    setItems(it || [])
    setFactories(f || [])
    const imps = imp || []
    const ids = imps.map(d => d.id)
    let linesByImp: Record<string, { item_code: string; description: string; quantity: number }[]> = {}
    let confSet = new Set<string>()
    if (ids.length) {
      const [{ data: sl }, { data: confs }] = await Promise.all([
        supabase.from('sales_order_lines').select('import_id, item_code, description, quantity').in('import_id', ids),
        supabase.from('document_confirmations').select('import_id, factory_code').in('import_id', ids),
      ])
      ;(sl || []).forEach(l => { (linesByImp[l.import_id] = linesByImp[l.import_id] || []).push(l) })
      ;(confs || []).forEach(c => confSet.add(`${c.import_id}|${c.factory_code}`))
    }
    setOrders(imps.map(d => ({
      ...d,
      lines: linesByImp[d.id] || [],
      confirmed: confSet.has(`${d.id}|${d.factory_code}`),
    })))
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
    // include a half-typed line if it's valid
    const pending = pickItem && Number(qty) > 0 ? [{ ...pickItem, qty: Number(qty) }] : []
    const all = [...lines, ...pending]
    if (all.length === 0) { setError('Add at least one item with a quantity.'); return }
    const payload = all.map(l => ({ code: l.code, description: l.description, unit: l.unit, qty: l.qty }))
    setBusy('create'); setError(''); setSuccess('')
    const { data: importId, error: e } = await supabase.rpc('create_repack_order', {
      p_factory: fac, p_customer: customer.trim() || null, p_delivery_date: deliveryDate || null, p_items: payload,
    })
    if (e) { setError(e.message); setBusy(''); return }
    // Push straight to production planning — same step as confirming a sales order.
    const { error: ce } = await supabase.rpc('confirm_document_factory', { p_import_id: importId, p_factory: fac })
    setBusy('')
    if (ce) {
      setSuccess(`Repack order created at ${factoryName(fac)}, but it could not be sent to production automatically (${ce.message}). Use "Send to production" below.`)
    } else {
      setSuccess(`Repack order created and sent to production at ${factoryName(fac)}. Production can now schedule it on the Order Board.`)
    }
    setLines([]); setPickItem(null); setQty(''); setCustomer(''); setDeliveryDate('')
    load()
  }

  async function sendToProduction(o: RepackOrder) {
    setBusy(o.id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('confirm_document_factory', { p_import_id: o.id, p_factory: o.factory_code })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(`Sent to production at ${factoryName(o.factory_code)}.`)
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const previewLines = [...lines, ...(pickItem && Number(qty) > 0 ? [{ ...pickItem, qty: Number(qty) }] : [])]

  return (
    <>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <h1 className="text-2xl font-bold mb-1">Repacking</h1>
        <p className="text-gray-500 mb-5 text-sm">
          Key in the items and quantities to repack. No document to upload — this is for warehouse repacks.
          It goes to production the same way a sales order does (schedule → request materials → CCP → Delivery Order).
        </p>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {success && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{success}</div>}

        {/* New repack order */}
        <div className="border rounded-2xl p-4 sm:p-5 bg-white shadow-sm mb-8">
          <h2 className="font-semibold mb-3">New repack order</h2>
          <div className="grid sm:grid-cols-3 gap-3 mb-4">
            <label className="block">
              <span className="text-xs text-gray-500">Factory (where to repack)</span>
              <select value={fac} onChange={e => setFac(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                {facOpts.length === 0 && <option value="">No allowed factory</option>}
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
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => removeLine(i)} className="text-red-600 hover:underline text-xs">Remove</button>
                      </td>
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
            {busy === 'create' ? 'Creating…' : 'Create & send to production'}
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
              <option value="sent">Sent to production</option>
              <option value="pending">Not sent yet</option>
            </select>
          </label>
        </div>
        {(() => {
          const shown = orders.filter(o => statusFilter === 'all' || (statusFilter === 'sent' ? o.confirmed : !o.confirmed))
          if (orders.length === 0) return <p className="text-gray-400 text-sm">No repack orders yet.</p>
          if (shown.length === 0) return <p className="text-gray-400 text-sm">No orders match this status.</p>
          return (
        <div className="space-y-3">
          {shown.map(o => (
            <div key={o.id} className="border rounded-xl p-4 bg-white shadow-sm">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <span className="font-semibold">{o.file_name}</span>
                  <span className="text-gray-400 text-sm ml-2">{factoryName(o.factory_code)} · {new Date(o.created_at).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center gap-2">
                  {o.confirmed
                    ? <span className="text-xs px-2 py-1 rounded-full bg-green-100 text-green-700">Sent to production</span>
                    : <>
                        <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-700">Not sent yet</span>
                        <button onClick={() => sendToProduction(o)} disabled={busy === o.id}
                          className="text-xs px-3 py-1 rounded-lg bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50">
                          {busy === o.id ? 'Sending…' : 'Send to production'}
                        </button>
                      </>}
                </div>
              </div>
              <div className="mt-2 text-sm text-gray-600">
                {o.lines.map((l, i) => (
                  <span key={i} className="inline-block mr-3">
                    <span className="font-mono">{l.item_code}</span> × {l.quantity}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
          )
        })()}
      </div>
    </>
  )
}
