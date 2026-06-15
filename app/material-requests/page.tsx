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
  released_at: string | null
  production_batches: { batch_no: string; item_code: string } | null
  material_request_items: MRItem[]
}

const FILTERS = ['Open', 'Partially Received', 'Fulfilled', 'All', 'Combined picking'] as const
type Filter = typeof FILTERS[number]

// Statuses that still need picking — pooled into the combined list
const ACTIVE = ['Open', 'Partially Received']

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
  const [combinedEdits, setCombinedEdits] = useState<Record<string, number>>({}) // factory|item_code -> total received being typed
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase
      .from('material_requests')
      .select('*, production_batches!batch_id(batch_no, item_code), material_request_items(*)')
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

  // Combined receiving: warehouse enters ONE total received for a material; we split it
  // back across the underlying request lines (oldest request first) and recompute each.
  async function receiveCombined(key: string, total: number, items: { id: string; requested_qty: number; received_qty: number }[]) {
    setBusy(key); setError(''); setSuccess('')
    let remaining = total
    for (const it of items) {
      const alloc = Math.max(0, Math.min(remaining, it.requested_qty))
      remaining -= alloc
      if (alloc !== it.received_qty) {
        const { error: rpcErr } = await supabase.rpc('receive_material_item', { p_item_id: it.id, p_received: alloc })
        if (rpcErr) { setError(rpcErr.message); setBusy(''); return }
      }
    }
    setSuccess('Combined receipt saved — split across the underlying requests.')
    setBusy('')
    setCombinedEdits(prev => { const n = { ...prev }; delete n[key]; return n })
    load()
  }

  // Release the waiting (unreleased) requests of a factory to the warehouse as one pick run,
  // stamping them with the same released_at so they group together and stop growing.
  async function release(factory: string) {
    const key = `release|${factory}`
    setBusy(key); setError(''); setSuccess('')
    const { error: relErr } = await supabase.from('material_requests')
      .update({ released_at: new Date().toISOString() })
      .is('released_at', null).eq('factory_code', factory)
    if (relErr) { setError(relErr.message); setBusy(''); return }
    setSuccess('Released to the warehouse as a new pick run.')
    setBusy('')
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' || filter === 'Combined picking' ? requests : requests.filter(r => r.status === filter)
  const counts: Record<string, number> = { Open: 0, 'Partially Received': 0, Fulfilled: 0 }
  requests.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })

  // Pool active requests by material, summing quantities. Underlying request lines stay
  // intact. Unreleased requests sit in a per-factory "waiting" pool until released; once
  // released they form a frozen pick run (grouped by factory + released_at) the warehouse picks.
  interface CombMat { code: string; description: string; unit: string; requested: number; received: number; items: { id: string; requested_qty: number; received_qty: number }[] }
  type MatMap = Record<string, CombMat>
  const addItem = (mats: MatMap, it: MRItem) => {
    const g = (mats[it.item_code] = mats[it.item_code] || { code: it.item_code, description: it.description, unit: it.unit, requested: 0, received: 0, items: [] })
    g.requested += Number(it.requested_qty)
    g.received += Number(it.received_qty)
    g.items.push({ id: it.id, requested_qty: Number(it.requested_qty), received_qty: Number(it.received_qty) })
  }
  const waiting: Record<string, MatMap> = {}                                  // factory -> materials not yet released
  const runs: Record<string, { factory: string; released_at: string; mats: MatMap }> = {} // factory|released_at -> run
  requests.filter(r => ACTIVE.includes(r.status)).forEach(r => {
    const target = r.released_at
      ? (runs[`${r.factory_code}|${r.released_at}`] = runs[`${r.factory_code}|${r.released_at}`] || { factory: r.factory_code, released_at: r.released_at, mats: {} }).mats
      : (waiting[r.factory_code] = waiting[r.factory_code] || {})
    r.material_request_items?.forEach(it => addItem(target, it))
  })
  // Oldest request first for allocation: requests arrive newest-first, so reverse the pooled lines
  const allMaps = [...Object.values(waiting), ...Object.values(runs).map(run => run.mats)]
  allMaps.forEach(mats => Object.values(mats).forEach(g => g.items.reverse()))
  const waitingFactories = Object.keys(waiting).sort()
  const runList = Object.values(runs).sort((a, b) => b.released_at.localeCompare(a.released_at) || a.factory.localeCompare(b.factory))
  const hasCombined = waitingFactories.length > 0 || runList.length > 0

  // One material table; editable=true adds the Received/Remaining columns + receiving (released runs only)
  const renderMatTable = (mats: MatMap, prefix: string, editable: boolean) => {
    const list = Object.values(mats).sort((a, b) => a.code.localeCompare(b.code))
    const heads = ['Material', 'Description', 'Unit', 'To pick', ...(editable ? ['Received', 'Remaining', ''] : [])]
    return (
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>{heads.map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
          </thead>
          <tbody>
            {list.map(g => {
              const key = `${prefix}|${g.code}`
              const remaining = Math.max(0, g.requested - g.received)
              const done = g.received >= g.requested
              return (
                <tr key={key} className={`border-b last:border-0 ${editable && done ? 'bg-green-50/40' : ''}`}>
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{g.code}</td>
                  <td className="px-3 py-2 text-gray-600">{g.description}</td>
                  <td className="px-3 py-2 text-gray-500">{g.unit}</td>
                  <td className="px-3 py-2 text-right font-semibold text-blue-700">{g.requested}</td>
                  {editable && <>
                    <td className="px-3 py-2">
                      <input type="number" step="any"
                        value={combinedEdits[key] ?? g.received}
                        onChange={e => setCombinedEdits(prev => ({ ...prev, [key]: e.target.value === '' ? 0 : Number(e.target.value) }))}
                        className="w-24 border rounded px-2 py-1 text-right" />
                    </td>
                    <td className={`px-3 py-2 text-right font-semibold ${remaining > 0 ? 'text-red-600' : 'text-green-600'}`}>{remaining}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button onClick={() => receiveCombined(key, combinedEdits[key] ?? g.received, g.items)} disabled={busy === key}
                        className="text-blue-600 hover:underline text-xs disabled:opacity-50">Save</button>
                    </td>
                  </>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

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

        {filter === 'Combined picking' ? (
          !hasCombined ? (
            <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
              Nothing to pick — no open requests.
              <br />Raise material requests from batches on the Production board.
            </div>
          ) : (
            <div className="space-y-8">
              {waitingFactories.length > 0 && (
                <div>
                  <h2 className="font-semibold text-gray-800 mb-1">⏳ Waiting to release</h2>
                  <p className="text-gray-500 text-sm mb-3">
                    New requests collect here. When ready, <strong>Release to warehouse</strong> to send a fixed pick run —
                    anything raised afterwards waits for the next release, so the warehouse always has a clear cut-off.
                  </p>
                  <div className="space-y-4">
                    {waitingFactories.map(fac => (
                      <div key={fac} className="bg-white rounded-xl shadow-sm border p-5">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="font-semibold">{isHO ? factoryName(fac) : fac}</span>
                          <span className="text-sm text-gray-400">· {Object.keys(waiting[fac]).length} material(s) waiting</span>
                          <button onClick={() => release(fac)} disabled={busy === `release|${fac}`}
                            className="ml-auto bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">
                            {busy === `release|${fac}` ? 'Releasing…' : 'Release to warehouse →'}
                          </button>
                        </div>
                        {renderMatTable(waiting[fac], `wait|${fac}`, false)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {runList.length > 0 && (
                <div>
                  <h2 className="font-semibold text-gray-800 mb-1">📦 Released pick runs</h2>
                  <p className="text-gray-500 text-sm mb-3">
                    Pick each run's totals in one trip. Type the <strong>total received</strong> for a material —
                    it is split back across the original requests automatically.
                  </p>
                  <div className="space-y-4">
                    {runList.map(run => {
                      const rkey = `${run.factory}|${run.released_at}`
                      return (
                        <div key={rkey} className="bg-white rounded-xl shadow-sm border p-5">
                          <div className="flex flex-wrap items-center gap-3 mb-3">
                            <span className="font-semibold">{isHO ? factoryName(run.factory) : run.factory}</span>
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">Pick run</span>
                            <span className="text-sm text-gray-400">released {new Date(run.released_at).toLocaleString()}</span>
                          </div>
                          {renderMatTable(run.mats, rkey, true)}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        ) : shown.length === 0 ? (
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
