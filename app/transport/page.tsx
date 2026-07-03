'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'
import MultiFilter from '@/components/MultiFilter'

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
  const [lorries, setLorries] = useState<string[]>([])
  const [crew, setCrew] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [facF, setFacF] = useState<Set<string>>(new Set())
  const [pendingOnly, setPendingOnly] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { if (profile) load() }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  async function load() {
    const [{ data: f }, { data: res }, { data: o }] = await Promise.all([
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('delivery_resources').select('kind, name').eq('active', true).order('name'),
      supabase.from('dispatch_orders')
        .select('id, do_number, factory_code, created_at, created_by_name, vehicle, lorry_requested_at, driver_name, driver_requested_at, dispatch_order_lines(item_code, quantity), material_returns(item_code, quantity)')
        .order('created_at', { ascending: false }).limit(100),
    ])
    setFactories(f || [])
    setLorries((res || []).filter(r => r.kind === 'lorry').map(r => r.name))
    setCrew([...new Set((res || []).filter(r => r.kind !== 'lorry').map(r => r.name))].sort())
    setOrders((o as DOrder[]) || [])
  }

  const factoryName = (c: string | null) => factories.find(x => x.code === c)?.name || c || '—'
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
  const canEditFac = (fac: string) => can(profile, 'dispatch', 'edit', fac)
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
        <h1 className="text-2xl font-bold mb-1">Transport</h1>
        <p className="text-gray-500 text-sm mb-4">Assign a lorry and a driver to each delivery order. A lorry parked on-site can be assigned straight away; if none is available, request one from the warehouse. Assignments show up in the driver app.</p>

        {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search DO, lorry or driver…" className="border rounded-lg px-3 py-2 w-full sm:w-72" />
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} />Needs a lorry or driver</label>
          {isHO && <div className="w-48"><span className="text-xs text-gray-500">Factory</span><MultiFilter values={[...new Set(orders.map(o => factoryName(o.factory_code)))].sort()} selected={facF} onChange={setFacF} /></div>}
          <span className="text-amber-700 text-xs">🚚 {needLorry} need a lorry · 👤 {needDriver} need a driver</span>
        </div>

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
                          <select value="" onChange={e => assign(o, 'lorry', e.target.value)} disabled={!editable || busy === o.id + 'lorry'} className="border rounded px-2 py-1 text-xs w-40">
                            <option value="">Assign on-site lorry…</option>
                            {lorries.map(l => <option key={l} value={l}>{l}</option>)}
                          </select>
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
