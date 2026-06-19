'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'

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
  run_mode: string | null
  delivery_date: string | null
  production_batch_items: PBItem[]
}
interface PackLine { factory_code: string; name: string; active: boolean }

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
  const [packLines, setPackLines] = useState<PackLine[]>([])
  const [mrStatus, setMrStatus] = useState<Record<string, string>>({}) // material_request_id -> status
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })() // local date (not UTC)
  const [date, setDate] = useState(today)
  const [factoryFilter, setFactoryFilter] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [packEdit, setPackEdit] = useState<Record<string, { line: string; date: string; mode: string }>>({})
  const [savingId, setSavingId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'packing', 'edit')

  useEffect(() => { if (profile) { load(); loadFactories() } }, [profile])

  async function load() {
    const { data } = await supabase.from('production_batches')
      .select('id, batch_no, item_code, description, factory_code, total_quantity, produced_qty, material_request_id, pack_line, pack_date, run_mode, delivery_date, production_batch_items(customer_name, quantity)')
      .order('delivery_date')
    setBatches((data as Batch[]) || [])
    const { data: mr } = await supabase.from('material_requests').select('id, status')
    const m: Record<string, string> = {}
    ;(mr || []).forEach(r => { m[r.id] = r.status })
    setMrStatus(m)
    const { data: pl } = await supabase.from('packing_lines').select('factory_code, name, active').order('name')
    setPackLines((pl as PackLine[]) || [])
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
  // Materials are "available" to schedule once any have been received
  // (fully OR partially). A request that's still fully Open stays in waiting.
  const materialsReady = (b: Batch) => !!b.material_request_id && ['Fulfilled', 'Partially Received'].includes(mrStatus[b.material_request_id])
  const partial = (b: Batch) => !!b.material_request_id && mrStatus[b.material_request_id] === 'Partially Received'
  const waitReason = (b: Batch) => b.material_request_id ? 'Waiting for materials' : 'Materials not requested yet'

  async function savePack(b: Batch) {
    const e = packEdit[b.id] ?? { line: b.pack_line || '', date: b.pack_date || '', mode: b.run_mode || 'auto' }
    if (!e.line || !e.date) { setError('Pick a pack line and a pack date first.'); return }
    setSavingId(b.id); setError(''); setSuccess('')
    const { error: upErr } = await supabase.from('production_batches').update({ pack_line: e.line, pack_date: e.date, run_mode: e.mode || 'auto' }).eq('id', b.id)
    if (upErr) { setError(upErr.message); setSavingId(''); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, pack_line: e.line, pack_date: e.date, run_mode: e.mode || 'auto' } : x)))
    setSavingId(''); setSuccess(`${b.batch_no} scheduled to ${e.line} on ${e.date.split('-').reverse().join('/')}.`)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const fmtDate = (d: string) => d.split('-').reverse().join('/')
  const facFilter = (b: Batch) => !(isHO && factoryFilter) || b.factory_code === factoryFilter

  // Unscheduled, still-to-produce batches split by whether materials are in
  const unscheduled = batches.filter(b => !b.pack_date && status(b) !== 'Completed' && facFilter(b))
  const readyToPack = unscheduled.filter(materialsReady)
  const waiting = unscheduled.filter(b => !materialsReady(b))

  // The day schedule (existing) — scheduled batches on the chosen date
  let shown = batches.filter(b => b.pack_date === date && facFilter(b))
  if (hideDone) shown = shown.filter(b => status(b) !== 'Completed')
  const byFactory: Record<string, Record<string, Batch[]>> = {}
  shown.forEach(b => {
    const f = (byFactory[b.factory_code] = byFactory[b.factory_code] || {})
    const line = b.pack_line || '(no line set)'
    ;(f[line] = f[line] || []).push(b)
  })
  const facs = Object.keys(byFactory).sort()

  function PackForm({ b }: { b: Batch }) {
    const cur = packEdit[b.id]?.line ?? b.pack_line ?? ''
    const opts = packLines.filter(p => p.factory_code === b.factory_code && (p.active || p.name === cur)).map(p => p.name)
    const setField = (patch: Partial<{ line: string; date: string; mode: string }>) =>
      setPackEdit(p => ({ ...p, [b.id]: { line: p[b.id]?.line ?? b.pack_line ?? '', date: p[b.id]?.date ?? b.pack_date ?? today, mode: p[b.id]?.mode ?? b.run_mode ?? 'auto', ...patch } }))
    return (
      <div className="flex flex-wrap items-end gap-2 justify-end">
        <select value={cur} onChange={e => setField({ line: e.target.value })} className="border rounded px-2 py-1 text-xs bg-white min-w-[110px]">
          <option value="">— Line —</option>
          {opts.map(n => <option key={n} value={n}>{n}</option>)}
          {opts.length === 0 && <option value="" disabled>Add in Setup → Packing Lines</option>}
        </select>
        <input type="date" value={packEdit[b.id]?.date ?? b.pack_date ?? today} onChange={e => setField({ date: e.target.value })} className="border rounded px-2 py-1 text-xs" />
        <select value={packEdit[b.id]?.mode ?? b.run_mode ?? 'auto'} onChange={e => setField({ mode: e.target.value })} className="border rounded px-2 py-1 text-xs bg-white">
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
        <button onClick={() => savePack(b)} disabled={savingId === b.id} className="bg-teal-600 text-white px-3 py-1 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-xs font-medium">{savingId === b.id ? 'Saving…' : 'Schedule'}</button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Packing Schedule</h1>
        <p className="text-gray-500 text-sm mb-5">Schedule a batch to a pack line &amp; date once its materials are received, then open the Packing &amp; Finished Goods Inspection Record to record production.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {isHO && (
          <div className="flex flex-wrap gap-2 items-center mb-5 text-sm">
            <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-3 py-2 bg-white">
              <option value="">All factories</option>
              {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
            </select>
          </div>
        )}

        {/* Ready to pack — materials received, not yet scheduled */}
        <h2 className="font-semibold text-gray-800 mb-2">✅ Ready to pack <span className="text-gray-400 font-normal text-sm">· {readyToPack.length} waiting to schedule</span></h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{[...(isHO ? ['Factory'] : []), 'Batch', 'Item', 'Qty', 'Delivery', canEdit ? 'Schedule to' : 'Status'].map(h => (
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {readyToPack.length === 0 && <tr><td colSpan={isHO ? 6 : 5} className="text-center py-6 text-gray-400">No batches with materials ready. They appear here once their Material Request is fully received.</td></tr>}
              {readyToPack.map(b => (
                <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                  {isHO && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(b.factory_code)}</td>}
                  <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}{partial(b) && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 align-middle">partial</span>}</td>
                  <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span></td>
                  <td className="px-3 py-2 text-right font-semibold">{b.total_quantity}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? fmtDate(b.delivery_date) : '—'}</td>
                  <td className="px-3 py-2">{canEdit ? <PackForm b={b} /> : <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${partial(b) ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{partial(b) ? 'Partial materials' : 'Materials ready'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Waiting for materials — cannot be scheduled yet */}
        <h2 className="font-semibold text-gray-800 mb-2">⏳ Waiting for materials <span className="text-gray-400 font-normal text-sm">· {waiting.length}</span></h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mb-8">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{[...(isHO ? ['Factory'] : []), 'Batch', 'Item', 'Qty', 'Delivery', 'Why not yet'].map(h => (
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {waiting.length === 0 && <tr><td colSpan={isHO ? 6 : 5} className="text-center py-6 text-gray-400">Nothing waiting — every planned batch has its materials.</td></tr>}
              {waiting.map(b => (
                <tr key={b.id} className="border-b last:border-0 hover:bg-gray-50">
                  {isHO && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(b.factory_code)}</td>}
                  <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                  <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span></td>
                  <td className="px-3 py-2 text-right font-semibold">{b.total_quantity}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{b.delivery_date ? fmtDate(b.delivery_date) : '—'}</td>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{waitReason(b)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Scheduled — what each line packs on the chosen day */}
        <h2 className="font-semibold text-gray-800 mb-2">📅 Scheduled to pack</h2>
        <div className="flex flex-wrap gap-2 items-center mb-4 text-sm">
          <span className="text-gray-500">Pack date:</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="border rounded-lg px-3 py-2 bg-white" />
          <button onClick={() => setDate(today)} className="text-blue-600 hover:underline">Today</button>
          <label className="flex items-center gap-2 cursor-pointer ml-2"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} className="h-4 w-4" /><span className="text-gray-700">Hide completed</span></label>
        </div>

        {facs.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            Nothing scheduled to pack on {fmtDate(date)}.
            <br />Schedule a batch from “Ready to pack” above.
          </div>
        ) : (
          <div className="space-y-6">
            {facs.map(fc => (
              <div key={fc}>
                {isHO && <h3 className="font-semibold text-gray-700 mb-2">🏭 {factoryName(fc)}</h3>}
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
