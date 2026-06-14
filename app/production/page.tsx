'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface BatchItem { id: string; customer_name: string; quantity: number }
interface Batch {
  id: string
  batch_no: string
  item_code: string
  description: string
  delivery_date: string
  factory_code: string
  total_quantity: number
  status: string
  production_batch_items: BatchItem[]
}

const STATUSES = ['Planned', 'In Progress', 'Completed'] as const
const FILTERS = ['All', ...STATUSES] as const
type Filter = typeof FILTERS[number]

const STATUS_STYLE: Record<string, string> = {
  Planned: 'bg-blue-100 text-blue-700',
  'In Progress': 'bg-amber-100 text-amber-700',
  Completed: 'bg-green-100 text-green-700',
}
const STATUS_BORDER: Record<string, string> = {
  Planned: 'border-l-blue-400',
  'In Progress': 'border-l-amber-400',
  Completed: 'border-l-green-400',
}

export default function ProductionPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<Filter>('All')
  const [updating, setUpdating] = useState('')
  const [error, setError] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { loadBatches(); loadFactories() } }, [profile])

  async function loadBatches() {
    const { data } = await supabase
      .from('production_batches')
      .select('*, production_batch_items(id, customer_name, quantity)')
      .order('created_at', { ascending: false })
    setBatches((data as Batch[]) || [])
  }

  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }

  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'

  async function setStatus(b: Batch, status: string) {
    setUpdating(b.id); setError('')
    const { error: updErr } = await supabase.from('production_batches').update({ status }).eq('id', b.id)
    if (updErr) { setError(updErr.message); setUpdating(''); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, status } : x)))
    setUpdating('')
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' ? batches : batches.filter(b => b.status === filter)
  const counts: Record<string, number> = { Planned: 0, 'In Progress': 0, Completed: 0 }
  batches.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1 })

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Production Board</h1>
        <p className="text-gray-500 text-sm mb-5">
          Production batches generated from confirmed sales orders.
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>

        <div className="flex gap-2 mb-5">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No production batches{filter !== 'All' ? ` with status "${filter}"` : ''} yet.
            <br />Confirm a sales order document to generate production demand.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {shown.map(b => (
              <div key={b.id} className={`bg-white rounded-xl shadow-sm border border-l-4 ${STATUS_BORDER[b.status] || 'border-l-gray-300'} p-5`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono font-semibold text-sm">{b.batch_no}</span>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[b.status] || 'bg-gray-100 text-gray-700'}`}>{b.status}</span>
                </div>

                <div className="mb-3">
                  <div className="font-semibold">{b.item_code}</div>
                  <div className="text-gray-500 text-sm">{b.description}</div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-sm mb-3">
                  <div>
                    <div className="text-gray-400 text-xs">Total qty</div>
                    <div className="font-semibold text-lg">{b.total_quantity}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs">Delivery</div>
                    <div className="font-medium">{b.delivery_date || '—'}</div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs">Factory</div>
                    <div className="font-medium">{isHO ? factoryName(b.factory_code) : (b.factory_code || '—')}</div>
                  </div>
                </div>

                <div className="border-t pt-3 mb-3">
                  <div className="text-gray-400 text-xs mb-1">Per customer</div>
                  <ul className="space-y-1">
                    {b.production_batch_items?.map(it => (
                      <li key={it.id} className="flex justify-between text-sm">
                        <span className="text-gray-700 truncate pr-2">{it.customer_name}</span>
                        <span className="font-medium whitespace-nowrap">{it.quantity}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <label className="text-gray-400 text-xs block mb-1">Status</label>
                  <select value={b.status} disabled={updating === b.id}
                    onChange={e => setStatus(b, e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
