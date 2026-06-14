'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface MRItem {
  id: string
  item_code: string
  description: string
  unit: string
  required_qty: number
  stock_qty: number
  shortfall_qty: number
  requested_qty: number
  received_qty: number
}
interface MaterialRequest {
  id: string
  request_no: string
  factory_code: string
  status: string
  created_at: string
  production_batches: { batch_no: string; item_code: string } | null
  material_request_items: MRItem[]
}

const FILTERS = ['Open', 'Partially Received', 'Fulfilled', 'All'] as const
type Filter = typeof FILTERS[number]

const STATUS_STYLE: Record<string, string> = {
  Open: 'bg-amber-100 text-amber-700',
  'Partially Received': 'bg-blue-100 text-blue-700',
  Fulfilled: 'bg-green-100 text-green-700',
}

export default function MaterialRequestsPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [requests, setRequests] = useState<MaterialRequest[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<Filter>('Open')
  const [edits, setEdits] = useState<Record<string, number>>({}) // item id -> received qty being typed
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase
      .from('material_requests')
      .select('*, production_batches(batch_no, item_code), material_request_items(*)')
      .order('created_at', { ascending: false })
    setRequests((data as MaterialRequest[]) || [])
  }
  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'

  async function receive(item: MRItem) {
    const val = edits[item.id] ?? item.received_qty
    setBusy(item.id); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('receive_material_item', { p_item_id: item.id, p_received: val })
    if (rpcErr) { setError(rpcErr.message); setBusy(''); return }
    setSuccess('Received quantity updated.')
    setBusy('')
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' ? requests : requests.filter(r => r.status === filter)
  const counts: Record<string, number> = { Open: 0, 'Partially Received': 0, Fulfilled: 0 }
  requests.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Material Requests</h1>
        <p className="text-gray-500 text-sm mb-5">
          Shortfall materials requested from the warehouse.
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>
        <p className="text-gray-400 text-xs mb-5 -mt-3">Open requests refresh automatically when the BOM or stock changes. Once you start recording received quantities, the request is frozen.</p>

        <div className="flex gap-2 mb-5">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No {filter !== 'All' ? filter.toLowerCase() : ''} material requests.
            <br />Raise one from a batch on the Production board.
          </div>
        ) : (
          <div className="space-y-5">
            {shown.map(r => (
              <div key={r.id} className="bg-white rounded-xl shadow-sm border p-5">
                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <span className="font-mono font-semibold">{r.request_no}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status}</span>
                  <span className="text-sm text-gray-500">
                    Batch <span className="font-mono">{r.production_batches?.batch_no}</span> · {r.production_batches?.item_code}
                  </span>
                  <span className="text-sm text-gray-500">· {isHO ? factoryName(r.factory_code) : r.factory_code}</span>
                  <span className="text-sm text-gray-400 ml-auto">{new Date(r.created_at).toLocaleString()}</span>
                </div>

                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>{['Material', 'Description', 'Unit', 'Required', 'Stock', 'Shortfall', 'Requested', 'Received', ''].map(h => (
                        <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                    </thead>
                    <tbody>
                      {r.material_request_items?.map(it => {
                        const done = it.received_qty >= it.requested_qty
                        return (
                          <tr key={it.id} className={`border-b last:border-0 ${done ? 'bg-green-50/40' : ''}`}>
                            <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{it.item_code}</td>
                            <td className="px-3 py-2 text-gray-600">{it.description}</td>
                            <td className="px-3 py-2 text-gray-500">{it.unit}</td>
                            <td className="px-3 py-2 text-right">{it.required_qty}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{it.stock_qty}</td>
                            <td className="px-3 py-2 text-right text-red-600">{it.shortfall_qty}</td>
                            <td className="px-3 py-2 text-right font-semibold text-blue-700">{it.requested_qty}</td>
                            <td className="px-3 py-2">
                              <input type="number" step="any"
                                value={edits[it.id] ?? it.received_qty}
                                onChange={e => setEdits(prev => ({ ...prev, [it.id]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                                className="w-24 border rounded px-2 py-1 text-right" />
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <button onClick={() => receive(it)} disabled={busy === it.id}
                                className="text-blue-600 hover:underline text-xs disabled:opacity-50">Save</button>
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
        )}
      </div>
    </div>
  )
}
