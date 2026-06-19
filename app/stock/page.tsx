'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
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
  useRequireView(profile, 'stock')
  const [lots, setLots] = useState<Lot[]>([])
  const [pcsPerRoll, setPcsPerRoll] = useState<Record<string, number>>({})
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [search, setSearch] = useState('')
  const [factoryFilter, setFactoryFilter] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories(); loadRolls() } }, [profile])
  async function loadRolls() {
    const { data } = await supabase.from('items').select('code, pcs_per_roll').not('pcs_per_roll', 'is', null)
    const m: Record<string, number> = {}; (data || []).forEach(r => { if (r.pcs_per_roll) m[r.code] = Number(r.pcs_per_roll) }); setPcsPerRoll(m)
  }

  async function load() {
    const { data } = await supabase.from('stock_lots').select('*')
      .gt('qty_remaining', 0)
      .order('exp_date', { ascending: true, nullsFirst: false })
      .order('received_at', { ascending: true }) // no expiry → oldest received (batch) first
    setLots((data as Lot[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const fmt = (d: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const num = (n: number) => Number(Number(n).toPrecision(12))
  // Batch numbers usually encode a date: YYMMDD (e.g. 260606 = 6 Jun 2026) or YYMM (e.g. 2602 = Feb 2026).
  // Read it (from the first 4–6 digit run) so stock can age by batch date and show it.
  const batchInfo = (batch: string | null): { date: string | null; label: string } => {
    const m = (batch || '').match(/\d{4,6}/)
    if (!m) return { date: null, label: '' }
    const d = m[0], yy = d.slice(0, 2), mm = d.slice(2, 4)
    if (+mm < 1 || +mm > 12) return { date: null, label: '' }
    if (d.length >= 6) { const dd = d.slice(4, 6); if (+dd >= 1 && +dd <= 31) return { date: `20${yy}-${mm}-${dd}`, label: `${dd}/${mm}/20${yy}` } }
    return { date: `20${yy}-${mm}-01`, label: `${mm}/20${yy}` }
  }
  // Order key: expiry if any, else the batch date, else the received date — so it's FEFO or oldest-batch-first
  const lotOrder = (l: Lot) => l.exp_date || batchInfo(l.batch_no).date || l.received_at.slice(0, 10)

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })() // local date (not UTC)
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
          Current stock per item, broken down by received batch — used earliest-expiry first, or oldest batch first when there's no expiry (raw materials).
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
                      const rows = [...items[code]].sort((a, b) => lotOrder(a).localeCompare(lotOrder(b)))
                      const total = rows.reduce((s, r) => s + Number(r.qty_remaining), 0)
                      const desc = rows[0].description || ''
                      return (
                        <div key={code} className="bg-white rounded-xl shadow-sm border p-4">
                          <div className="flex flex-wrap items-baseline gap-2 mb-2">
                            <span className="font-mono font-semibold">{code}</span>
                            <span className="text-gray-500 text-sm">{desc}</span>
                            <span className="ml-auto text-sm">On hand: <strong className="text-blue-700">{num(total)}</strong>{pcsPerRoll[code] ? <span className="text-gray-500"> pc (≈ {num(Math.round((total / pcsPerRoll[code]) * 100) / 100)} rolls)</span> : null}</span>
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
                                      <td className="px-3 py-2 font-mono">{r.batch_no || '—'}{batchInfo(r.batch_no).label && <span className="ml-2 text-[11px] text-gray-400 font-sans">({batchInfo(r.batch_no).label})</span>}{r.unplanned && <span className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-medium bg-indigo-100 text-indigo-700 font-sans">unplanned</span>}</td>
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
