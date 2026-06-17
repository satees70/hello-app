'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Lot {
  id: string
  item_code: string
  description: string | null
  factory_code: string
  batch_no: string | null
  exp_date: string | null
  qty_received: number
  qty_remaining: number
  received_at: string
  unplanned: boolean
  request_item_id: string | null
}

export default function IncomingPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [lots, setLots] = useState<Lot[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [search, setSearch] = useState('')
  const [factoryFilter, setFactoryFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('') // '', 'order', 'unplanned'

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase.from('stock_lots').select('*').order('received_at', { ascending: false }).limit(1000)
    setLots((data as Lot[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const fmt = (d: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const num = (n: number) => Number(Number(n).toPrecision(12))

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const q = search.trim().toLowerCase()
  let shown = lots
  if (q) shown = shown.filter(l => `${l.item_code} ${l.description || ''} ${l.batch_no || ''}`.toLowerCase().includes(q))
  if (isHO && factoryFilter) shown = shown.filter(l => l.factory_code === factoryFilter)
  if (sourceFilter === 'unplanned') shown = shown.filter(l => l.unplanned)
  if (sourceFilter === 'order') shown = shown.filter(l => !l.unplanned)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Goods Received</h1>
        <p className="text-gray-500 text-sm mb-5">
          Every batch of materials received into stock, newest first.
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>

        <div className="flex flex-wrap gap-2 items-center mb-5 text-sm">
          <input placeholder="Search by item, description or batch…" value={search} onChange={e => setSearch(e.target.value)}
            className="w-full sm:w-80 border rounded-lg px-3 py-2 bg-white" />
          {isHO && (
            <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
              <option value="">All factories</option>
              {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
            </select>
          )}
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
            <option value="">All receipts</option>
            <option value="order">Against an order</option>
            <option value="unplanned">Unplanned</option>
          </select>
        </div>

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No goods received yet.
            <br />Receive materials from the Material Requests page (or upload a Delivery Order).
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>{['Received', ...(isHO ? ['Factory'] : []), 'Item', 'Description', 'Batch', 'Expiry', 'Qty', 'Source'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
              </thead>
              <tbody>
                {shown.map(l => (
                  <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{new Date(l.received_at).toLocaleString()}</td>
                    {isHO && <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{factoryName(l.factory_code)}</td>}
                    <td className="px-4 py-3 font-mono font-medium whitespace-nowrap">{l.item_code}</td>
                    <td className="px-4 py-3 text-gray-600">{l.description}</td>
                    <td className="px-4 py-3 font-mono">{l.batch_no || '—'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{fmt(l.exp_date)}</td>
                    <td className="px-4 py-3 text-right font-semibold whitespace-nowrap">{num(l.qty_received)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {l.unplanned
                        ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">Unplanned</span>
                        : <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Against order</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
