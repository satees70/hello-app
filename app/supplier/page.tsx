'use client'
import { Fragment, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import ItemPicker from '@/components/ItemPicker'
import { fetchTomorrowDeliverySOs } from '@/lib/delivery'

interface Line {
  id: string; customer_name: string; so_number: string; item_code: string; description: string
  quantity: number; outstanding_qty: number; delivery_date: string; location_code: string; factory_code: string
}
interface POItem { id: string; supplier_order_id: string; item_code: string; description: string | null; qty: number }
interface PO { id: string; supplier_name: string; note: string | null; status: string; created_by_name: string | null; created_at: string; received_at: string | null; supplier_order_items: POItem[] }

export default function SupplierPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'sales')
  const router = useRouter()
  const [lines, setLines] = useState<Line[]>([])
  const [orders, setOrders] = useState<PO[]>([])
  const [q, setQ] = useState('')
  const [pendingOnly, setPendingOnly] = useState(true)
  const [tomorrowOnly, setTomorrowOnly] = useState(false)
  const [tomorrowSOs, setTomorrowSOs] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (code: string) => setOpen(p => { const n = new Set(p); n.has(code) ? n.delete(code) : n.add(code); return n })
  // Place-order basket
  const [sel, setSel] = useState<Set<string>>(new Set())       // item codes selected to order
  const [orderQty, setOrderQty] = useState<Record<string, string>>({})
  const [manualDesc, setManualDesc] = useState<Record<string, string>>({})   // descriptions for items added by hand
  const [itemsMaster, setItemsMaster] = useState<{ code: string; description: string; unit: string }[]>([])
  const [addItem, setAddItem] = useState<{ code: string; description: string; unit: string } | null>(null)
  const [addQty, setAddQty] = useState('')
  const [supplierName, setSupplierName] = useState('')
  const [note, setNote] = useState('')
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [tab, setTab] = useState<'toorder' | 'placed'>('toorder')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [rows, { data: pos }, master] = await Promise.all([
      fetchAll<Line>('sales_order_lines',
        'id, customer_name, so_number, item_code, description, quantity, outstanding_qty, delivery_date, location_code, factory_code',
        qb => qb.or('location_code.eq.SUPPLIER,factory_code.eq.SUPPLIER')),
      supabase.from('supplier_orders').select('*, supplier_order_items(*)').order('created_at', { ascending: false }),
      fetchAll<{ code: string; description: string; unit: string }>('items', 'code, description, unit'),
    ])
    setLines(rows)
    setOrders((pos as PO[]) || [])
    setItemsMaster(master)
    setTomorrowSOs(await fetchTomorrowDeliverySOs())
  }
  function addManualItem() {
    if (!addItem) { setError('Pick an item to add.'); return }
    const qy = Number(addQty)
    if (!(qy > 0)) { setError('Enter a quantity for the item.'); return }
    setError('')
    setSel(p => new Set(p).add(addItem.code))
    setOrderQty(o => ({ ...o, [addItem.code]: String(qy) }))
    setManualDesc(m => ({ ...m, [addItem.code]: addItem.description }))
    setAddItem(null); setAddQty('')
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const n = (x: number) => Number(Number(x || 0).toFixed(3))
  const fmtDate = (d: string | null) => d ? d.split('-').reverse().join('/') : '—'
  const term = q.trim().toLowerCase()

  // Quantities already on an OPEN supplier order, per item
  const openOrdered: Record<string, number> = {}
  orders.filter(o => o.status === 'Open').forEach(o => o.supplier_order_items?.forEach(it => { openOrdered[it.item_code] = (openOrdered[it.item_code] || 0) + Number(it.qty || 0) }))

  const visible = lines.filter(l =>
    (!term || (l.item_code || '').toLowerCase().includes(term) || (l.description || '').toLowerCase().includes(term)))
  const groups: Record<string, { code: string; description: string; qty: number; outstanding: number; lines: Line[]; next: string | null }> = {}
  visible.forEach(l => {
    const g = (groups[l.item_code] = groups[l.item_code] || { code: l.item_code, description: l.description, qty: 0, outstanding: 0, lines: [], next: null })
    g.qty += Number(l.quantity || 0); g.outstanding += Number(l.outstanding_qty || 0); g.lines.push(l)
    if (l.delivery_date && (!g.next || l.delivery_date < g.next)) g.next = l.delivery_date
  })
  const toOrderOf = (code: string, outstanding: number) => Math.max(0, outstanding - (openOrdered[code] || 0))
  let list = Object.values(groups)
  if (pendingOnly) list = list.filter(g => toOrderOf(g.code, g.outstanding) > 0)
  const isTomorrowGroup = (g: { lines: Line[] }) => g.lines.some(l => l.so_number && tomorrowSOs.has(l.so_number))
  const tomorrowCount = list.filter(isTomorrowGroup).length
  if (tomorrowOnly) list = list.filter(isTomorrowGroup)
  list.sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999') || toOrderOf(b.code, b.outstanding) - toOrderOf(a.code, a.outstanding))

  const toggleSel = (code: string, suggested: number) => setSel(p => {
    const s = new Set(p)
    if (s.has(code)) s.delete(code)
    else { s.add(code); setOrderQty(o => ({ ...o, [code]: o[code] ?? String(suggested) })) }
    return s
  })
  const selectAll = () => { const s = new Set<string>(); const qo: Record<string, string> = { ...orderQty }; list.forEach(g => { const t = toOrderOf(g.code, g.outstanding); s.add(g.code); qo[g.code] = qo[g.code] ?? String(t) }); setSel(s); setOrderQty(qo) }

  async function placeOrder() {
    if (!profile) return
    if (!supplierName.trim()) { setError('Type the supplier name.'); return }
    const items = [...sel].map(code => ({ code, qty: Number(orderQty[code] || 0), description: groups[code]?.description || manualDesc[code] || lines.find(l => l.item_code === code)?.description || '' }))
      .filter(i => i.qty > 0)
    if (items.length === 0) { setError('Select at least one item with a quantity.'); return }
    setPlacing(true); setError(''); setSuccess('')
    const { data: po, error: e1 } = await supabase.from('supplier_orders')
      .insert({ supplier_name: supplierName.trim(), note: note.trim() || null, created_by: profile.id, created_by_name: profile.full_name || null })
      .select('id').single()
    if (e1 || !po) { setError(e1?.message || 'Could not create order'); setPlacing(false); return }
    const { error: e2 } = await supabase.from('supplier_order_items').insert(items.map(i => ({ supplier_order_id: po.id, item_code: i.code, description: i.description, qty: i.qty })))
    setPlacing(false)
    if (e2) { setError(e2.message); return }
    setSuccess(`Order placed with ${supplierName.trim()} (${items.length} item${items.length > 1 ? 's' : ''}).`)
    setSel(new Set()); setOrderQty({}); setSupplierName(''); setNote(''); load()
  }
  async function markReceived(o: PO) {
    if (!confirm(`Mark order to ${o.supplier_name} as received?`)) return
    await supabase.from('supplier_orders').update({ status: 'Received', received_at: new Date().toISOString() }).eq('id', o.id)
    load()
  }
  async function deleteOrder(o: PO) {
    if (!confirm(`Delete the order to ${o.supplier_name}? This cannot be undone.`)) return
    await supabase.from('supplier_orders').delete().eq('id', o.id)
    load()
  }

  const selItems = [...sel].map(c => ({ code: c, qty: Number(orderQty[c] || 0) })).filter(i => i.qty > 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Supplier orders</h1>
        <p className="text-gray-500 text-sm mb-4">Items on sales orders routed to <strong>SUPPLIER</strong>. Tick items, type a supplier and place one consolidated order.</p>

        <div className="flex gap-2 mb-5">
          <button onClick={() => setTab('toorder')} className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${tab === 'toorder' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>To order</button>
          <button onClick={() => setTab('placed')} className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${tab === 'placed' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Placed orders{orders.filter(o => o.status === 'Open').length ? ` (${orders.filter(o => o.status === 'Open').length})` : ''}</button>
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {tab === 'toorder' && <>
          {/* Place-order basket */}
          {selItems.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border p-4 mb-4">
              <h2 className="font-semibold mb-2">Place order · {selItems.length} item(s)</h2>
              <div className="flex flex-wrap items-end gap-3 mb-3">
                <div className="flex flex-col gap-1 flex-1 min-w-[14rem]"><span className="text-xs font-medium text-gray-600">Supplier name</span>
                  <input value={supplierName} onChange={e => setSupplierName(e.target.value)} placeholder="Type the supplier…" className="border rounded-lg px-3 py-2 text-sm" /></div>
                <div className="flex flex-col gap-1 flex-1 min-w-[14rem]"><span className="text-xs font-medium text-gray-600">Note (optional)</span>
                  <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. needed by Friday" className="border rounded-lg px-3 py-2 text-sm" /></div>
              </div>
              <div className="border rounded-lg overflow-hidden mb-3">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b"><tr>{['Item', 'Description', 'Order qty', ''].map(h => <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600">{h}</th>)}</tr></thead>
                  <tbody>
                    {[...sel].map(code => (
                      <tr key={code} className="border-b last:border-0">
                        <td className="px-3 py-1.5 font-mono font-medium whitespace-nowrap">{code}{!groups[code] && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 align-middle">manual</span>}</td>
                        <td className="px-3 py-1.5 text-gray-600">{groups[code]?.description || manualDesc[code]}</td>
                        <td className="px-3 py-1.5"><input type="number" step="any" value={orderQty[code] ?? ''} onChange={e => setOrderQty(o => ({ ...o, [code]: e.target.value }))} className="border rounded px-2 py-1 text-sm w-28 text-right" /></td>
                        <td className="px-3 py-1.5 text-right"><button onClick={() => toggleSel(code, 0)} className="text-red-500 hover:underline text-xs">remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={placeOrder} disabled={placing} className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium">{placing ? 'Placing…' : `Place order (${selItems.length})`}</button>
                <button onClick={() => { setSel(new Set()); setOrderQty({}) }} className="text-gray-500 hover:underline text-xs">Clear selection</button>
              </div>
            </div>
          )}

          {/* Add any item by hand (e.g. a low-stock item to top up) */}
          <div className="bg-white rounded-xl shadow-sm border p-3 mb-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1 flex-1 min-w-[16rem]"><span className="text-xs font-medium text-gray-600">Add an item to order (not from a sales order)</span>
                <ItemPicker items={itemsMaster} value={addItem ? `${addItem.code} — ${addItem.description}` : ''} onPick={it => setAddItem(it)} placeholder="Type an item code or name…" /></div>
              <div className="flex flex-col gap-1 w-28"><span className="text-xs font-medium text-gray-600">Qty{addItem ? ` (${addItem.unit})` : ''}</span>
                <input type="number" step="any" value={addQty} onChange={e => setAddQty(e.target.value)} className="border rounded-lg px-3 py-2 text-sm text-right" /></div>
              <button onClick={addManualItem} className="border border-blue-600 text-blue-600 px-4 py-2 rounded-lg hover:bg-blue-50 text-sm font-medium">+ Add to order</button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item code or description…" className="w-full sm:w-72 border rounded-lg px-3 py-2 text-sm" />
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} className="h-4 w-4" /> Still to order</label>
            <button onClick={() => setTomorrowOnly(v => !v)} className={`text-xs px-3 py-1.5 rounded-full font-medium border ${tomorrowOnly ? 'bg-yellow-300 border-yellow-400 text-yellow-900' : 'bg-white border-gray-300 text-gray-600 hover:bg-yellow-50'}`}>🚚 Tomorrow{tomorrowCount ? ` (${tomorrowCount})` : ''}</button>
            <button onClick={selectAll} className="text-blue-600 hover:underline text-xs">Select all shown</button>
            <span className="text-gray-400 text-xs">{list.length} item(s)</span>
          </div>

          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>{['', 'Item', 'Description', 'Outstanding', 'On order', 'To order', 'Next delivery', ''].map(h => (
                  <th key={h} className="text-left px-4 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
              </thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-gray-400">Nothing for the supplier{pendingOnly ? ' to order' : ''}.</td></tr>}
                {list.map(g => { const toOrder = toOrderOf(g.code, g.outstanding); return (
                  <Fragment key={g.code}>
                    <tr className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-4 py-2"><input type="checkbox" checked={sel.has(g.code)} onChange={() => toggleSel(g.code, toOrder)} className="h-4 w-4" /></td>
                      <td className="px-4 py-2 font-mono font-medium whitespace-nowrap cursor-pointer" onClick={() => toggle(g.code)}>{open.has(g.code) ? '▾' : '▸'} {g.code}</td>
                      <td className="px-4 py-2 text-gray-600">{g.description}</td>
                      <td className="px-4 py-2 text-right">{n(g.outstanding)}</td>
                      <td className="px-4 py-2 text-right text-gray-500">{openOrdered[g.code] ? n(openOrdered[g.code]) : '—'}</td>
                      <td className="px-4 py-2 text-right font-semibold text-amber-700">{n(toOrder)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">{fmtDate(g.next)}</td>
                      <td className="px-4 py-2 text-blue-600 text-xs cursor-pointer" onClick={() => toggle(g.code)}>{open.has(g.code) ? 'Hide' : 'Orders'}</td>
                    </tr>
                    {open.has(g.code) && (
                      <tr className="bg-gray-50/60"><td colSpan={8} className="px-4 py-2">
                        <table className="w-full text-xs">
                          <thead><tr className="text-gray-500">{['Customer', 'SO No', 'Qty', 'Outstanding', 'Delivery', 'Location'].map(h => <th key={h} className="text-left px-2 py-1 font-medium">{h}</th>)}</tr></thead>
                          <tbody>
                            {g.lines.sort((a, b) => (a.delivery_date || '').localeCompare(b.delivery_date || '')).map(l => (
                              <tr key={l.id} className="border-t">
                                <td className="px-2 py-1">{l.customer_name}</td>
                                <td className="px-2 py-1">{l.so_number ? <button onClick={() => router.push(`/discussion?so=${encodeURIComponent(l.so_number)}`)} className="text-blue-600 hover:underline font-mono">{l.so_number}</button> : '—'}</td>
                                <td className="px-2 py-1 text-right">{n(l.quantity)}</td>
                                <td className="px-2 py-1 text-right font-medium text-amber-700">{n(l.outstanding_qty)}</td>
                                <td className="px-2 py-1 whitespace-nowrap">{fmtDate(l.delivery_date)}</td>
                                <td className="px-2 py-1">{l.location_code}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </Fragment>
                ) })}
              </tbody>
            </table>
          </div>
        </>}

        {tab === 'placed' && (
          <div className="space-y-3">
            {orders.length === 0 && <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">No orders placed yet.</div>}
            {orders.map(o => (
              <div key={o.id} className={`bg-white rounded-xl shadow-sm border p-4 ${o.status === 'Received' ? 'opacity-70' : ''}`}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div>
                    <span className="font-semibold">{o.supplier_name}</span>
                    <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${o.status === 'Received' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{o.status}</span>
                    <span className="block text-xs text-gray-400">{new Date(o.created_at).toLocaleString()}{o.created_by_name ? ` · ${o.created_by_name}` : ''}{o.note ? ` · ${o.note}` : ''}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    {o.status === 'Open' && <button onClick={() => markReceived(o)} className="bg-green-600 text-white px-3 py-1 rounded-lg hover:bg-green-700 text-xs font-medium">Mark received</button>}
                    <button onClick={() => deleteOrder(o)} className="text-red-500 hover:underline text-xs">Delete</button>
                  </div>
                </div>
                <table className="w-full text-sm border rounded-lg overflow-hidden">
                  <thead className="bg-gray-50 border-b"><tr>{['Item', 'Description', 'Qty'].map(h => <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600">{h}</th>)}</tr></thead>
                  <tbody>
                    {o.supplier_order_items?.map(it => (
                      <tr key={it.id} className="border-b last:border-0">
                        <td className="px-3 py-1.5 font-mono font-medium whitespace-nowrap">{it.item_code}</td>
                        <td className="px-3 py-1.5 text-gray-600">{it.description}</td>
                        <td className="px-3 py-1.5 text-right">{n(it.qty)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
