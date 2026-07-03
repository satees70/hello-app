'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import MultiFilter from '@/components/MultiFilter'

interface IRec {
  id: string; factory_code: string | null; created_at: string; production_batch_id: string | null
  data: Record<string, unknown> | null
  production_batches: { batch_no: string | null; item_code: string | null; description: string | null } | null
}

export default function InspectionRecordsPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'inspection')
  const [recs, setRecs] = useState<IRec[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [search, setSearch] = useState('')
  const [facF, setFacF] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(true)

  useEffect(() => { if (profile) load() }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  async function load() {
    setBusy(true)
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    const { data } = await supabase.from('inspection_records')
      .select('id, factory_code, created_at, production_batch_id, data, production_batches!production_batch_id(batch_no, item_code, description)')
      .order('created_at', { ascending: false }).limit(1000)
    setRecs((data as unknown as IRec[]) || [])
    setBusy(false)
  }

  const factoryName = (c: string | null) => factories.find(x => x.code === c)?.name || c || '—'
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  const S = (r: IRec, k: string) => { const v = r.data?.[k]; return v == null ? '' : String(v) }
  const itemCode = (r: IRec) => r.production_batches?.item_code || S(r, 'code') || S(r, 'product') || '—'
  const itemDesc = (r: IRec) => r.production_batches?.description || ''
  const batchNo = (r: IRec) => r.production_batches?.batch_no || '—'

  const q = search.trim().toLowerCase()
  const shown = useMemo(() => recs.filter(r => {
    if (facF.size && !facF.has(factoryName(r.factory_code))) return false
    if (q && !(`${batchNo(r)} ${itemCode(r)} ${itemDesc(r)} ${S(r, 'done_by')} ${S(r, 'no')}`.toLowerCase().includes(q))) return false
    return true
  }), [recs, facF, q]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center text-red-500">{profileError}</div>
  if (!profile) return null
  const isHO = profile.factory_code === 'HEAD_OFFICE'

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Finished Goods Inspection Records</h1>
        <p className="text-gray-500 text-sm mb-5">All Packing &amp; Finished Goods Inspection Records. Click a batch to open its full record.</p>

        <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search batch, item, doc no or done-by…" className="border rounded-lg px-3 py-2 w-full sm:w-80" />
          {isHO && <div className="w-48"><span className="text-xs text-gray-500">Factory</span><MultiFilter values={[...new Set(recs.map(r => factoryName(r.factory_code)))].sort()} selected={facF} onChange={setFacF} /></div>}
          <span className="text-gray-400 text-xs self-end">{shown.length} record(s)</span>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[36rem]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['Doc No', 'Batch', 'Item', 'Qty', 'Done by', 'Factory', 'When', ''].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {busy && <tr><td colSpan={8} className="text-center py-8 text-gray-400">Loading…</td></tr>}
              {!busy && shown.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-gray-400">No inspection records found.</td></tr>}
              {!busy && shown.map(r => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{S(r, 'no') || '—'}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{batchNo(r)}</td>
                  <td className="px-3 py-2"><span className="font-mono font-medium">{itemCode(r)}</span>{itemDesc(r) && <span className="block text-gray-500 text-xs">{itemDesc(r)}</span>}</td>
                  <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{S(r, 'recorded_qty') || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{S(r, 'done_by') || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{factoryName(r.factory_code)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(r.created_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.production_batch_id && <a href={`/inspection?batch=${r.production_batch_id}`} className="text-blue-600 hover:underline">Open →</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
