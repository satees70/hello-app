'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'

interface PBItem { customer_name: string; quantity: number }
interface Batch {
  id: string
  batch_no: string
  item_code: string
  description: string
  factory_code: string
  total_quantity: number
  produced_qty: number
  material_request_id: string | null
  pack_line: string | null
  pack_date: string | null
  delivery_date: string | null
  production_batch_items: PBItem[]
}

const STATUS_STYLE: Record<string, string> = {
  Planned: 'bg-blue-100 text-blue-700',
  Requested: 'bg-indigo-100 text-indigo-700',
  'In Progress': 'bg-amber-100 text-amber-700',
  Completed: 'bg-green-100 text-green-700',
}

export default function PackingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'packing')
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })() // local date (not UTC)
  const [date, setDate] = useState(today)
  const [factoryFilter, setFactoryFilter] = useState('')
  const [hideDone, setHideDone] = useState(false)

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, material_request_id, pack_line, pack_date, delivery_date, production_batch_items(customer_name, quantity)')
      .not('pack_date', 'is', null)
      .order('pack_date')
    setBatches((data as Batch[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c || '—'
  const status = (b: Batch) => {
    const p = Number(b.produced_qty || 0)
    if (p >= b.total_quantity && b.total_quantity > 0) return 'Completed'
    if (p > 0) return 'In Progress'
    if (b.material_request_id) return 'Requested'
    return 'Planned'
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  let shown = batches.filter(b => b.pack_date === date)
  if (isHO && factoryFilter) shown = shown.filter(b => b.factory_code === factoryFilter)
  if (hideDone) shown = shown.filter(b => status(b) !== 'Completed')

  // group by factory (HO) then by line
  const byFactory: Record<string, Record<string, Batch[]>> = {}
  shown.forEach(b => {
    const f = (byFactory[b.factory_code] = byFactory[b.factory_code] || {})
    const line = b.pack_line || '(no line set)'
    ;(f[line] = f[line] || []).push(b)
  })
  const facs = Object.keys(byFactory).sort()
  const fmtDate = (d: string) => d.split('-').reverse().join('/')

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Packing Schedule</h1>
        <p className="text-gray-500 text-sm mb-5">What each line packs on the selected day. Open the Packing &amp; Finished Goods Inspection Record to start &amp; record production.</p>

        <div className="flex flex-wrap gap-2 items-center mb-5 text-sm">
          <span className="text-gray-500">Pack date:</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
          <button onClick={() => setDate(today)} className="text-blue-600 hover:underline">Today</button>
          {isHO && (
            <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white ml-2">
              <option value="">All factories</option>
              {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
            </select>
          )}
          <label className="flex items-center gap-2 cursor-pointer ml-2"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} className="h-4 w-4" /><span className="text-gray-700">Hide completed</span></label>
        </div>

        {facs.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            Nothing planned to pack on {fmtDate(date)}.
            <br />Plan a pack line &amp; date on the Order Board first.
          </div>
        ) : (
          <div className="space-y-6">
            {facs.map(fc => (
              <div key={fc}>
                {isHO && <h2 className="font-semibold text-gray-700 mb-2">🏭 {factoryName(fc)}</h2>}
                <div className="space-y-4">
                  {Object.keys(byFactory[fc]).sort().map(line => (
                    <div key={line} className="bg-white rounded-xl shadow-sm border p-4">
                      <div className="font-semibold mb-2">📅 {fmtDate(date)} · <span className="text-teal-700">{line}</span> <span className="text-gray-400 font-normal text-sm">· {byFactory[fc][line].length} item(s)</span></div>
                      <div className="overflow-x-auto border rounded-lg">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b">
                            <tr>{['Batch', 'Item', 'To pack', 'Produced', 'Backorder', 'Status', ''].map(h => (
                              <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                          </thead>
                          <tbody>
                            {byFactory[fc][line].map(b => {
                              const backorder = Math.max(0, b.total_quantity - (b.produced_qty || 0))
                              return (
                                <tr key={b.id} className="border-b last:border-0">
                                  <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                                  <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span></td>
                                  <td className="px-3 py-2 text-right font-semibold">{b.total_quantity}</td>
                                  <td className="px-3 py-2 text-right text-green-700">{b.produced_qty || 0}</td>
                                  <td className={`px-3 py-2 text-right font-semibold ${backorder > 0 ? 'text-red-600' : 'text-green-600'}`}>{backorder}</td>
                                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[status(b)] || 'bg-gray-100 text-gray-700'}`}>{status(b)}</span></td>
                                  <td className="px-3 py-2 whitespace-nowrap text-right">
                                    <a href={`/inspection?batch=${b.id}`} className="border border-green-600 text-green-700 px-3 py-1 rounded-lg hover:bg-green-50 text-xs font-medium">📋 Packing &amp; Finished Goods Inspection Record</a>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
