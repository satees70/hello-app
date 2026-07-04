'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'
import { VEHICLE_TYPES, lorryTypeLabel } from '@/lib/lorryTypes'
import MultiFilter from '@/components/MultiFilter'

// Go-live cutoff: delivery orders before this were transferred outside the system,
// so they don't need lorry/driver assignment here. (4 Jul 2026 00:00 Malaysia.)
const TRANSPORT_SINCE = '2026-07-03T16:00:00Z'

interface DOrder {
  id: string; do_number: string | null; factory_code: string; created_at: string; created_by_name: string | null
  vehicle: string | null; lorry_requested_at: string | null
  driver_name: string | null; driver_requested_at: string | null
  dispatch_order_lines?: { item_code: string; quantity: number }[]
  material_returns?: { item_code: string; quantity: number }[]
}

export default function TransportPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'dispatch')
  const [orders, setOrders] = useState<DOrder[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [lorries, setLorries] = useState<{ id: string; name: string; parked_at: string | null; lorry_type: string | null }[]>([])
  const [crew, setCrew] = useState<string[]>([])
  const [lorryReqs, setLorryReqs] = useState<{ id: string; factory_code: string; kind: string; lorry_type: string; note: string | null; destination: string | null; requested_by_name: string | null; requested_at: string }[]>([])
  const [grNeedDriver, setGrNeedDriver] = useState<{ id: string; do_number: string | null; factory_code: string; vehicle: string | null }[]>([])
  const [search, setSearch] = useState('')
  const [facF, setFacF] = useState<Set<string>>(new Set())
  const [pendingOnly, setPendingOnly] = useState(true)
  const [showParking, setShowParking] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { if (profile) load() }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  async function load() {
    const [{ data: f }, { data: res }, { data: o }, { data: lr }] = await Promise.all([
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('delivery_resources').select('id, kind, name, parked_at, lorry_type').eq('active', true).order('name'),
      supabase.from('dispatch_orders')
        .select('id, do_number, factory_code, created_at, created_by_name, vehicle, lorry_requested_at, driver_name, driver_requested_at, dispatch_order_lines(item_code, quantity), material_returns(item_code, quantity)')
        .gte('created_at', TRANSPORT_SINCE).order('created_at', { ascending: false }).limit(100),
      supabase.from('lorry_requests').select('id, factory_code, kind, lorry_type, note, destination, requested_by_name, requested_at').eq('status', 'open').order('requested_at', { ascending: false }),
    ])
    setFactories(f || [])
    setLorries((res || []).filter(r => r.kind === 'lorry').map(r => ({ id: r.id, name: r.name, parked_at: r.parked_at, lorry_type: r.lorry_type })))
    setCrew([...new Set((res || []).filter(r => r.kind !== 'lorry').map(r => r.name))].sort())
    setOrders((o as DOrder[]) || [])
    setLorryReqs(lr || [])
    // Incoming (Goods Received) lorries assigned but still without a driver — assign one here.
    const { data: gnd } = await supabase.from('delivery_orders')
      .select('id, do_number, factory_code, vehicle')
      .not('vehicle', 'is', null).is('driver_name', null).is('transport_received_at', null)
      .gte('created_at', TRANSPORT_SINCE).order('created_at', { ascending: false })
    setGrNeedDriver(gnd || [])
  }
  async function assignGrDriver(id: string, driver: string) {
    if (!driver) return
    setBusy('gr' + id); setError('')
    const { error: e } = await supabase.rpc('assign_gr_transport', { p_doc_id: id, p_kind: 'driver', p_value: driver })
    setBusy('')
    if (e) { setError(e.message); return }
    load()
  }
  async function fulfillLorry(id: string, lorry: string) {
    setBusy('lr' + id); setError('')
    const { error: e } = await supabase.rpc('fulfill_lorry_request', { p_id: id, p_lorry: lorry || null })
    setBusy('')
    if (e) { setError(e.message); return }
    load()
  }
  async function setParked(id: string, factory: string) {
    setBusy('park' + id); setError('')
    const { error: e } = await supabase.from('delivery_resources').update({ parked_at: factory || null }).eq('id', id)
    setBusy('')
    if (e) { setError(e.message); return }
    setLorries(prev => prev.map(l => l.id === id ? { ...l, parked_at: factory || null } : l))
  }
  async function setLorrySize(id: string, size: string) {
    const { error: e } = await supabase.from('delivery_resources').update({ lorry_type: size || null }).eq('id', id)
    if (e) { setError(e.message); return }
    setLorries(prev => prev.map(l => l.id === id ? { ...l, lorry_type: size || null } : l))
  }

  const factoryName = (c: string | null) => factories.find(x => x.code === c)?.name || c || '—'
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  // Transport is warehouse logistics — anyone who can VIEW a factory's delivery
  // orders can assign/request/fulfil transport there (they needn't be able to
  // create DOs). Per-factory view-only no longer blocks assigning.
  const canEditFac = (fac: string) => can(profile, 'dispatch', 'view', fac)
  const itemCount = (o: DOrder) => (o.dispatch_order_lines?.length || 0) + (o.material_returns?.length || 0)

  async function assign(o: DOrder, kind: 'lorry' | 'driver', value: string) {
    if (!canEditFac(o.factory_code)) { setError('You have view-only access at this factory.'); return }
    setBusy(o.id + kind); setError('')
    const { error: e } = await supabase.rpc('assign_do_transport', { p_do_id: o.id, p_kind: kind, p_value: value || null })
    setBusy('')
    if (e) { setError(e.message); return }
    load()
  }
  async function request(o: DOrder, kind: 'lorry' | 'driver') {
    if (!canEditFac(o.factory_code)) { setError('You have view-only access at this factory.'); return }
    setBusy(o.id + kind + 'req'); setError('')
    const { error: e } = await supabase.rpc('request_do_transport', { p_do_id: o.id, p_kind: kind })
    setBusy('')
    if (e) { setError(e.message); return }
    load()
  }

  const q = search.trim().toLowerCase()
  const shown = useMemo(() => orders.filter(o => {
    if (pendingOnly && o.vehicle && o.driver_name) return false
    if (facF.size && !facF.has(factoryName(o.factory_code))) return false
    if (q && !`${o.do_number} ${o.vehicle} ${o.driver_name}`.toLowerCase().includes(q)) return false
    return true
  }), [orders, pendingOnly, facF, q]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center text-red-500">{profileError}</div>
  if (!profile) return null
  const isHO = profile.factory_code === 'HEAD_OFFICE'
  const needLorry = orders.filter(o => !o.vehicle).length
  const needDriver = orders.filter(o => !o.driver_name).length

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Lorry Internal Transfer</h1>
        <p className="text-gray-500 text-sm mb-4">Assign a lorry and a driver to each delivery order. A lorry parked on-site can be assigned straight away; if none is available, request one from the warehouse. Assignments show up in the driver app.</p>

        {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search DO, lorry or driver…" className="border rounded-lg px-3 py-2 w-full sm:w-72" />
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} />Needs a lorry or driver</label>
          {isHO && <div className="w-48"><span className="text-xs text-gray-500">Factory</span><MultiFilter values={[...new Set(orders.map(o => factoryName(o.factory_code)))].sort()} selected={facF} onChange={setFacF} /></div>}
          <span className="text-amber-700 text-xs">🚚 {needLorry} need a lorry · 👤 {needDriver} need a driver</span>
          <button onClick={() => setShowParking(v => !v)} className="text-xs text-blue-600 hover:underline">🅿 Lorry parking</button>
        </div>

        {lorryReqs.length > 0 && (
          <div className="mb-4 bg-white rounded-xl shadow-sm border border-amber-300 p-4">
            <h2 className="font-medium mb-2">📞 Transport requests waiting</h2>
            <p className="text-xs text-gray-500 mb-2">Production called for these before a DO. For a lorry, pick which one you sent — it gets parked at that site. For a driver, mark it arranged.</p>
            <ul className="space-y-2">
              {lorryReqs.map(r => {
                const editable = canEditFac(r.factory_code)
                const isDriver = r.kind === 'driver'
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm border-b last:border-0 pb-2 last:pb-0">
                    {isDriver
                      ? <span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 rounded-full px-2.5 py-0.5 text-xs font-medium">👤 driver</span>
                      : <span className="inline-flex items-center gap-1 bg-amber-50 text-amber-800 rounded-full px-2.5 py-0.5 text-xs font-medium">🚚 {lorryTypeLabel(r.lorry_type)}</span>}
                    <span className="text-gray-700 font-medium">{factoryName(r.factory_code)}</span>
                    {r.destination && <span className="text-gray-600 text-xs">→ {r.destination}</span>}
                    {r.note && <span className="text-gray-500 text-xs">· {r.note}</span>}
                    <span className="text-gray-400 text-xs">· {r.requested_by_name || '—'}, {fmt(r.requested_at)}</span>
                    <div className="flex items-center gap-2 ml-auto">
                      {isDriver ? (
                        <select value="" onChange={e => fulfillLorry(r.id, e.target.value)} disabled={!editable || busy === 'lr' + r.id} className="border rounded px-2 py-1 text-xs">
                          <option value="">Assign driver…</option>
                          {crew.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <>
                          <select value="" onChange={e => fulfillLorry(r.id, e.target.value)} disabled={!editable || busy === 'lr' + r.id} className="border rounded px-2 py-1 text-xs">
                            <option value="">Sent lorry…</option>
                            {lorries.map(l => <option key={l.id} value={l.name}>{l.name}{l.lorry_type ? ` · ${lorryTypeLabel(l.lorry_type)}` : ''}{l.parked_at ? ` · at ${factoryName(l.parked_at)}` : ''}</option>)}
                          </select>
                          <button onClick={() => fulfillLorry(r.id, '')} disabled={!editable || busy === 'lr' + r.id} className="text-xs text-gray-500 hover:underline">Done (no lorry)</button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {grNeedDriver.length > 0 && (
          <div className="mb-4 bg-white rounded-xl shadow-sm border border-indigo-300 p-4">
            <h2 className="font-medium mb-2">👤 Incoming lorries needing a driver</h2>
            <p className="text-xs text-gray-500 mb-2">These warehouse lorries are loaded/assigned but have no driver yet. Assign one when available.</p>
            <ul className="space-y-2">
              {grNeedDriver.map(g => (
                <li key={g.id} className="flex flex-wrap items-center gap-2 text-sm border-b last:border-0 pb-2 last:pb-0">
                  <span className="inline-flex items-center gap-1 bg-teal-50 text-teal-800 rounded-full px-2.5 py-0.5 text-xs font-medium">🚚 {g.vehicle}</span>
                  <span className="font-mono text-gray-600">{g.do_number || '—'}</span>
                  <span className="text-gray-500">→ {factoryName(g.factory_code)}</span>
                  <select value="" onChange={e => assignGrDriver(g.id, e.target.value)} disabled={busy === 'gr' + g.id} className="border rounded px-2 py-1 text-xs ml-auto">
                    <option value="">Assign driver…</option>
                    {crew.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showParking && (
          <div className="mb-4 bg-white rounded-xl shadow-sm border p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-medium">🅿 Where is each lorry parked?</h2>
              <span className="text-xs text-gray-400">Set this when a driver drops a lorry off. On-site lorries show up first when assigning.</span>
            </div>
            {lorries.length === 0 ? <p className="text-sm text-gray-400">No lorries in the list yet — add them under Delivery Schedule › Manage lorries / crew.</p> : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {lorries.map(l => (
                  <div key={l.id} className="flex items-center gap-2 border rounded-lg px-3 py-2">
                    <span className="font-medium text-sm flex-1 truncate">🚚 {l.name}</span>
                    <select value={l.lorry_type || ''} onChange={e => setLorrySize(l.id, e.target.value)} className="border rounded px-1.5 py-1 text-xs" title="Lorry type">
                      <option value="">type?</option>
                      {VEHICLE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <select value={l.parked_at || ''} onChange={e => setParked(l.id, e.target.value)} disabled={busy === 'park' + l.id} className="border rounded px-2 py-1 text-xs">
                      <option value="">— on the road —</option>
                      {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['DO No.', 'Factory', 'Items', 'Lorry', 'Driver', 'Created', ''].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">Nothing to show.</td></tr>}
              {shown.map(o => {
                const editable = canEditFac(o.factory_code)
                return (
                  <tr key={o.id} className="border-b last:border-0 align-top">
                    <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{o.do_number || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{factoryName(o.factory_code)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">{itemCount(o)} item(s)</td>

                    {/* Lorry */}
                    <td className="px-3 py-2">
                      {o.vehicle ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 bg-teal-50 text-teal-800 rounded-full px-2.5 py-1 text-xs font-medium">🚚 {o.vehicle}</span>
                          {editable && <button onClick={() => assign(o, 'lorry', '')} disabled={busy === o.id + 'lorry'} className="text-xs text-gray-400 hover:text-red-600">change</button>}
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {(() => {
                            const onSite = lorries.filter(l => l.parked_at === o.factory_code)
                            const others = lorries.filter(l => l.parked_at !== o.factory_code)
                            return (
                              <select value="" onChange={e => assign(o, 'lorry', e.target.value)} disabled={!editable || busy === o.id + 'lorry'} className="border rounded px-2 py-1 text-xs w-44">
                                <option value="">{onSite.length ? `Assign on-site lorry (${onSite.length})…` : 'Assign lorry…'}</option>
                                {onSite.length > 0 && <optgroup label={`🅿 Parked here (${onSite.length})`}>{onSite.map(l => <option key={l.id} value={l.name}>{l.name}{l.lorry_type ? ` · ${lorryTypeLabel(l.lorry_type)}` : ''}</option>)}</optgroup>}
                                {others.length > 0 && <optgroup label="Other lorries">{others.map(l => <option key={l.id} value={l.name}>{l.name}{l.lorry_type ? ` · ${lorryTypeLabel(l.lorry_type)}` : ''}{l.parked_at ? ` · at ${factoryName(l.parked_at)}` : ''}</option>)}</optgroup>}
                              </select>
                            )
                          })()}
                          <div className="flex items-center gap-2">
                            <button onClick={() => request(o, 'lorry')} disabled={!editable || busy === o.id + 'lorryreq'} className="text-xs text-blue-600 hover:underline disabled:opacity-50">{o.lorry_requested_at ? 'Re-request' : '📞 Request lorry'}</button>
                            {o.lorry_requested_at && <span className="text-[11px] text-amber-600">requested {fmt(o.lorry_requested_at)}</span>}
                          </div>
                        </div>
                      )}
                    </td>

                    {/* Driver */}
                    <td className="px-3 py-2">
                      {o.driver_name ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 rounded-full px-2.5 py-1 text-xs font-medium">👤 {o.driver_name}</span>
                          {editable && <button onClick={() => assign(o, 'driver', '')} disabled={busy === o.id + 'driver'} className="text-xs text-gray-400 hover:text-red-600">change</button>}
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <select value="" onChange={e => assign(o, 'driver', e.target.value)} disabled={!editable || busy === o.id + 'driver'} className="border rounded px-2 py-1 text-xs w-40">
                            <option value="">Assign driver…</option>
                            {crew.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <div className="flex items-center gap-2">
                            <button onClick={() => request(o, 'driver')} disabled={!editable || busy === o.id + 'driverreq'} className="text-xs text-blue-600 hover:underline disabled:opacity-50">Re-request</button>
                            {o.driver_requested_at && <span className="text-[11px] text-amber-600">requested {fmt(o.driver_requested_at)}</span>}
                          </div>
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(o.created_at)}{o.created_by_name && <span className="block text-[11px]">by {o.created_by_name}</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{o.vehicle && o.driver_name && <span className="text-green-600 text-xs">✓ ready</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
