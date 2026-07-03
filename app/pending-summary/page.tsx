'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { fetchTomorrowDeliverySOs } from '@/lib/delivery'
import MultiFilter from '@/components/MultiFilter'

interface Line {
  id: string; so_number: string | null; item_code: string | null; description: string | null
  quantity: number | null; outstanding_qty: number | null; delivered_qty: number | null
  factory_code: string | null; is_grinding: boolean | null
}
type BatchLite = { item_code: string; factory_code: string; material_request_id: string | null; pack_date: string | null; produced_qty: number | null; total_quantity: number; dispatched_at: string | null }
// Same production lifecycle mapping used on the Sales Orders page.
function lineStatusOf(b: BatchLite, mrStatus: Record<string, string>): string {
  if (b.dispatched_at) return 'Delivered to warehouse'
  const prod = Number(b.produced_qty || 0), tot = Number(b.total_quantity || 0)
  if (prod > 0 && prod >= tot) return 'Production completed'
  if (prod > 0) return 'Production started'
  if (!b.material_request_id) return 'Pending Material Request'
  const ms = mrStatus[b.material_request_id]
  if (ms === 'Fulfilled') return b.pack_date ? 'Pending Schedule' : 'Material Received Fully'
  if (ms === 'Partially Received') return 'Material Received Partial'
  return 'Pending Material Request'
}
const STATUS_STYLE: Record<string, string> = {
  'Not started': 'bg-gray-100 text-gray-600',
  'Pending Material Request': 'bg-amber-100 text-amber-700',
  'Material Received Partial': 'bg-yellow-100 text-yellow-700',
  'Material Received Fully': 'bg-lime-100 text-lime-700',
  'Pending Schedule': 'bg-purple-100 text-purple-700',
  'Production started': 'bg-blue-100 text-blue-700',
  'Production completed': 'bg-teal-100 text-teal-700',
}
// Statuses that mean the line is finished — excluded from the pending list.
const DONE = new Set(['Delivered to warehouse', 'Production completed'])

export default function PendingSummaryPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'sales')
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [statusMap, setStatusMap] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [facF, setFacF] = useState<Set<string>>(new Set())
  const [statF, setStatF] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [tomorrowSOs, setTomorrowSOs] = useState<Set<string>>(new Set())
  const [tomorrowOnly, setTomorrowOnly] = useState(false)
  const [busy, setBusy] = useState(true)

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    setBusy(true)
    setTomorrowSOs(await fetchTomorrowDeliverySOs())
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    const all = await fetchAll<Line>('sales_order_lines', 'id, so_number, item_code, description, quantity, outstanding_qty, delivered_qty, factory_code, is_grinding')
    setLines(all)
    // Production status per line (factory|item|SO), traced through batches → material requests.
    const sos = [...new Set(all.map(l => l.so_number).filter(Boolean))] as string[]
    const biRows: { so_number: string; production_batches: BatchLite | null }[] = []
    for (let i = 0; i < sos.length; i += 150) {
      const { data } = await supabase.from('production_batch_items')
        .select('so_number, production_batches!batch_id(item_code, factory_code, material_request_id, pack_date, produced_qty, total_quantity, dispatched_at)')
        .in('so_number', sos.slice(i, i + 150))
      biRows.push(...((data || []) as unknown as { so_number: string; production_batches: BatchLite | null }[]))
    }
    const mrIds = [...new Set(biRows.map(r => r.production_batches?.material_request_id).filter(Boolean) as string[])]
    const mrStatus: Record<string, string> = {}
    for (let i = 0; i < mrIds.length; i += 150) {
      const { data: mrs } = await supabase.from('material_requests').select('id, status').in('id', mrIds.slice(i, i + 150))
      ;(mrs || []).forEach(m => { mrStatus[m.id] = m.status })
    }
    const map: Record<string, string> = {}
    biRows.forEach(r => { const b = r.production_batches; if (b) map[`${b.factory_code}|${b.item_code}|${r.so_number}`] = lineStatusOf(b, mrStatus) })
    setStatusMap(map)
    setBusy(false)
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center text-red-500">{profileError}</div>
  if (!profile) return null

  const isHO = profile.factory_code === 'HEAD_OFFICE'
  const myCodes = profile.factory_codes && profile.factory_codes.length ? profile.factory_codes : [profile.factory_code]
  const factoryName = (c: string | null) => factories.find(f => f.code === c)?.name || c || 'Unmapped'
  const lineStatus = (l: Line) => statusMap[`${l.factory_code}|${l.item_code}|${l.so_number}`] || 'Not started'
  // Pending = not delivered to warehouse, not fully produced, and not fully delivered out.
  const pending = lines.filter(l => {
    if (!isHO && !(l.factory_code && myCodes.includes(l.factory_code))) return false
    const st = lineStatus(l)
    if (DONE.has(st)) return false
    const qty = Number(l.quantity || 0), del = Number(l.delivered_qty || 0)
    if (qty > 0 && del >= qty) return false
    return true
  })
  const q = search.trim().toLowerCase()
  const visible = pending.filter(l => {
    if (tomorrowOnly && !(l.so_number && tomorrowSOs.has(l.so_number))) return false
    if (facF.size && !facF.has(factoryName(l.factory_code))) return false
    if (statF.size && !statF.has(lineStatus(l))) return false
    if (q && !(`${l.so_number} ${l.item_code} ${l.description}`.toLowerCase().includes(q))) return false
    return true
  })
  const tomorrowCount = pending.filter(l => l.so_number && tomorrowSOs.has(l.so_number)).length
  const facs = [...new Set(visible.map(l => factoryName(l.factory_code)))].sort()
  const toggle = (f: string) => setCollapsed(p => { const n = new Set(p); n.has(f) ? n.delete(f) : n.add(f); return n })
  const qtyOf = (l: Line) => Number(l.outstanding_qty ?? l.quantity ?? 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Pending Summary</h1>
        <p className="text-gray-500 text-sm mb-5">All sales-order lines still to be produced/delivered, grouped by factory.</p>

        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search SO, item code or name…" className="border rounded-lg px-3 py-2 w-full sm:w-72" />
          <div className="w-44"><span className="text-xs text-gray-500">Factory</span><MultiFilter values={[...new Set(pending.map(l => factoryName(l.factory_code)))].sort()} selected={facF} onChange={setFacF} /></div>
          <div className="w-52"><span className="text-xs text-gray-500">Status</span><MultiFilter values={[...new Set(pending.map(lineStatus))].sort()} selected={statF} onChange={setStatF} /></div>
          <button onClick={() => setTomorrowOnly(v => !v)} className={`text-xs px-3 py-1.5 rounded-full font-medium border self-end ${tomorrowOnly ? 'bg-yellow-300 border-yellow-400 text-yellow-900' : 'bg-white border-gray-300 text-gray-600 hover:bg-yellow-50'}`}>🚚 Tomorrow{tomorrowCount ? ` (${tomorrowCount})` : ''}</button>
          <span className="text-gray-400 text-xs self-end">{visible.length} pending line(s)</span>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[36rem]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['SO No', 'Item', 'Qty', 'Status'].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {busy && <tr><td colSpan={4} className="text-center py-8 text-gray-400">Loading…</td></tr>}
              {!busy && visible.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-gray-400">Nothing pending 🎉</td></tr>}
              {!busy && facs.map(fc => {
                const grp = visible.filter(l => factoryName(l.factory_code) === fc)
                const open = !collapsed.has(fc)
                return (
                  <Fragment key={fc}>
                    <tr className="bg-gray-50 border-b cursor-pointer hover:bg-gray-100" onClick={() => toggle(fc)}>
                      <td colSpan={4} className="px-3 py-1.5 font-semibold text-gray-700"><span className="text-gray-400 mr-1">{open ? '▾' : '▸'}</span>🏭 {fc} <span className="text-gray-400 font-normal">· {grp.length}</span></td>
                    </tr>
                    {open && grp.map(l => (
                      <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50 align-top">
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{l.so_number || '—'}{l.is_grinding && <span className="ml-1 text-purple-600" title="Grinding">🌀</span>}</td>
                        <td className="px-3 py-2"><span className="font-mono font-medium">{l.item_code}</span><span className="block text-gray-500 text-xs">{l.description}</span></td>
                        <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{qtyOf(l)}</td>
                        <td className="px-3 py-2 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[lineStatus(l)] || 'bg-gray-100 text-gray-600'}`}>{lineStatus(l)}</span></td>
                      </tr>
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
