'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Lot {
  id: string
  item_id: string
  item_code: string
  description: string | null
  factory_code: string
  batch_no: string | null
  exp_date: string | null
  qty_received: number
  qty_remaining: number
  received_at: string
  unplanned: boolean
}

export default function StockPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [lots, setLots] = useState<Lot[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [search, setSearch] = useState('')
  const [factoryFilter, setFactoryFilter] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase.from('stock_lots').select('*')
      .gt('qty_remaining', 0)
      .order('exp_date', { ascending: true, nullsFirst: false })
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

  const today = new Date().toISOString().slice(0, 10)
  const q = search.trim().toLowerCase()
  let shown = lots
  if (q) shown = shown.filter(l => `${l.item_code} ${l.description || ''}`.toLowerCase().includes(q))
  if (isHO && factoryFilter) shown = shown.filter(l => l.factory_code === factoryFilter)

  // factory -> item_code -> lots
  const byFactory: Record<string, Record<string, Lot[]>> = {}
  shown.forEach(l => {
    const f = (byFactory[l.factory_code] = byFactory[l.factory_code] || {})
    ;(f[l.item_code] = f[l.item_code] || []).push(l)
  })
  const facs = Object.keys(byFactory).sort()

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Stock on hand</h1>
        <p className="text-gray-500 text-sm mb-5">
          Current stock per item, broken down by received batch and expiry date (earliest expiry first).
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>

        <div className="flex flex-wrap gap-2 items-center mb-5 text-sm">
          <input placeholder="Search by code or description…" value={search} onChange={e => setSearch(e.target.value)}
            className="w-full sm:w-80 border rounded-lg px-3 py-2 bg-white" />
          {isHO && (
            <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
              <option value="">All factories</option>
              {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
            </select>
          )}
        </div>

        {facs.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No stock recorded yet.
            <br />Stock appears here once the warehouse records received materials.
          </div>
        ) : (
          <div className="space-y-6">
            {facs.map(fc => {
              const items = byFactory[fc]
              const codes = Object.keys(items).sort()
              return (
                <div key={fc}>
                  {isHO && <h2 className="font-semibold text-gray-700 mb-2">🏭 {factoryName(fc)}</h2>}
                  <div className="space-y-4">
                    {codes.map(code => {
                      const rows = [...items[code]].sort((a, b) => (a.exp_date || '9999').localeCompare(b.exp_date || '9999'))
                      const total = rows.reduce((s, r) => s + Number(r.qty_remaining), 0)
                      const desc = rows[0].description || ''
                      return (
                        <div key={code} className="bg-white rounded-xl shadow-sm border p-4">
                          <div className="flex flex-wrap items-baseline gap-2 mb-2">
                            <span className="font-mono font-semibold">{code}</span>
                            <span className="text-gray-500 text-sm">{desc}</span>
                            <span className="ml-auto text-sm">On hand: <strong className="text-blue-700">{num(total)}</strong></span>
                          </div>
                          <div className="overflow-x-auto border rounded-lg">
                            <table className="w-full text-sm">
                              <thead className="bg-gray-50 border-b">
                                <tr>{['Batch no', 'Expiry', 'Remaining', 'Received', 'Received on'].map(h => (
                                  <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                              </thead>
                              <tbody>
                                {rows.map(r => {
                                  const expired = r.exp_date && r.exp_date < today
                                  return (
                                    <tr key={r.id} className={`border-b last:border-0 ${expired ? 'bg-red-50' : ''}`}>
                                      <td className="px-3 py-2 font-mono">{r.batch_no || '—'}{r.unplanned && <span className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-medium bg-indigo-100 text-indigo-700">unplanned</span>}</td>
                                      <td className={`px-3 py-2 ${expired ? 'text-red-600 font-medium' : ''}`}>{fmt(r.exp_date)}{expired ? ' (expired)' : ''}</td>
                                      <td className="px-3 py-2 text-right font-semibold">{num(r.qty_remaining)}</td>
                                      <td className="px-3 py-2 text-right text-gray-500">{num(r.qty_received)}</td>
                                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{new Date(r.received_at).toLocaleDateString()}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
