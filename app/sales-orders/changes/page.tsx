'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import MultiFilter from '@/components/MultiFilter'

interface ChangeRequest {
  id: string
  line_id: string
  import_id: string
  field: string
  old_value: string | null
  new_value: string
  reason: string | null
  request_type: string
  status: string
  requested_by_email: string | null
  requested_by_name: string | null
  requested_at: string
  reviewed_by_email: string | null
  reviewed_by_name: string | null
  reviewed_at: string | null
  factory_code: string
  sales_order_lines: { item_code: string; description: string } | null
  sales_imports: { file_name: string } | null
}

interface CorrectionRequest {
  id: string; label: string | null; reason: string | null; timer_key: string; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null; factory_code: string | null
}

interface DoChangeRequest {
  id: string; request_type: string; field: string | null; old_value: string | null; new_value: string | null
  line_label: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface SplitRequest {
  id: string; label: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null; factory_code: string | null
}

interface StockAdj {
  id: string; factory_code: string; item_code: string; description: string | null
  direction: string; quantity: number; batch_no: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

const FIELD_LABEL: Record<string, string> = {
  customer_name: 'Customer',
  item_code: 'Item Code',
  description: 'Description',
  quantity: 'Qty',
  outstanding_qty: 'Outstanding',
  delivery_date: 'Delivery Date',
  location_code: 'Location',
}

const STATUS_STYLES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
}

const FILTERS = ['Pending', 'Approved', 'Rejected', 'All'] as const
type Filter = typeof FILTERS[number]

export default function PendingChangesPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'changes')
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [corrections, setCorrections] = useState<CorrectionRequest[]>([])
  const [doChanges, setDoChanges] = useState<DoChangeRequest[]>([])
  const [filter, setFilter] = useState<Filter>('Pending')
  const [busyId, setBusyId] = useState('')
  const [selCr, setSelCr] = useState<Set<string>>(new Set())
  const [crFilters, setCrFilters] = useState<Record<string, Set<string>>>({})
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selCorr, setSelCorr] = useState<Set<string>>(new Set())
  const [corrFilters, setCorrFilters] = useState<Record<string, Set<string>>>({})
  const [selDo, setSelDo] = useState<Set<string>>(new Set())
  const [doFilters, setDoFilters] = useState<Record<string, Set<string>>>({})
  const [splits, setSplits] = useState<SplitRequest[]>([])
  const [selSplit, setSelSplit] = useState<Set<string>>(new Set())
  const [splitFilters, setSplitFilters] = useState<Record<string, Set<string>>>({})
  const [stockAdjs, setStockAdjs] = useState<StockAdj[]>([])
  const [selSA, setSelSA] = useState<Set<string>>(new Set())
  const [saFilters, setSaFilters] = useState<Record<string, Set<string>>>({})

  // Distinct values present in a list, for a filter dropdown
  const distinctOf = <T,>(arr: T[], get: (x: T) => string) => [...new Set(arr.map(get))].filter(Boolean).sort()
  // A row passes a column filter when nothing is selected, or its value is ticked
  const passes = (sel: Set<string> | undefined, val: string) => !sel || sel.size === 0 || sel.has(val)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => {
    if (!profile) return
    loadRequests(); loadCorrections(); loadDoChanges(); loadSplits(); loadStockAdjs()
    // Live refresh on any change-request activity, with a poll fallback
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) supabase.realtime.setAuth(data.session.access_token)
    })
    const channel = supabase
      .channel('changes-page-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'change_requests' }, () => loadRequests())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'correction_requests' }, () => loadCorrections())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'do_change_requests' }, () => loadDoChanges())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'split_requests' }, () => loadSplits())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_adjustments' }, () => loadStockAdjs())
      .subscribe()
    const timer = setInterval(() => { loadRequests(); loadCorrections(); loadDoChanges(); loadSplits(); loadStockAdjs() }, 20000)
    return () => { supabase.removeChannel(channel); clearInterval(timer) }
  }, [profile])

  async function loadRequests() {
    const { data } = await supabase
      .from('change_requests')
      .select('*, sales_order_lines(item_code, description), sales_imports(file_name)')
      .order('requested_at', { ascending: false })
    setRequests((data as ChangeRequest[]) || [])
  }
  async function loadCorrections() {
    const { data } = await supabase.from('correction_requests').select('*').order('created_at', { ascending: false })
    setCorrections((data as CorrectionRequest[]) || [])
  }
  async function approveCorr(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_correction', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Timer cancellation approved — the timer was cleared.'); setBusyId(''); loadCorrections()
  }
  async function rejectCorr(id: string) {
    if (!confirm('Reject this timer cancellation? The timer stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_correction', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Timer cancellation rejected.'); setBusyId(''); loadCorrections()
  }
  async function loadDoChanges() {
    const { data } = await supabase.from('do_change_requests').select('*').order('created_at', { ascending: false })
    setDoChanges((data as DoChangeRequest[]) || [])
  }
  async function approveDo(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_do_change', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Goods Received change approved.'); setBusyId(''); loadDoChanges()
  }
  async function rejectDo(id: string) {
    if (!confirm('Reject this Goods Received change?')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_do_change', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Goods Received change rejected.'); setBusyId(''); loadDoChanges()
  }

  async function loadSplits() {
    const { data } = await supabase.from('split_requests').select('*').order('created_at', { ascending: false })
    setSplits((data as SplitRequest[]) || [])
  }
  async function approveSplit(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_split', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Split approved — the order now has its own batch.'); setBusyId(''); loadSplits()
  }
  async function rejectSplit(id: string) {
    if (!confirm('Reject this split request? The batch stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_split', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Split request rejected.'); setBusyId(''); loadSplits()
  }

  async function loadStockAdjs() {
    const { data } = await supabase.from('stock_adjustments').select('*').order('created_at', { ascending: false })
    setStockAdjs((data as StockAdj[]) || [])
  }
  async function approveSA(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_stock_adjustment', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Stock adjustment approved — stock updated.'); setBusyId(''); loadStockAdjs()
  }
  async function rejectSA(id: string) {
    if (!confirm('Reject this stock adjustment? Stock will not change.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_stock_adjustment', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Stock adjustment rejected.'); setBusyId(''); loadStockAdjs()
  }

  async function approve(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('approve_change_request', { p_id: id })
    if (rpcErr) { setError(rpcErr.message); setBusyId(''); return }
    setSuccess('Change request approved — the line has been updated.')
    setBusyId('')
    loadRequests()
  }

  async function reject(id: string) {
    if (!confirm('Reject this change request? The line will stay as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('reject_change_request', { p_id: id })
    if (rpcErr) { setError(rpcErr.message); setBusyId(''); return }
    setSuccess('Change request rejected.')
    setBusyId('')
    loadRequests()
  }

  const toggleCr = (id: string) => setSelCr(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  async function bulkAct(rpc: string, ids: string[], verb: string) {
    if (ids.length === 0) return
    if (verb === 'reject' && !confirm(`Reject ${ids.length} change request(s)?`)) return
    setBulkBusy(true); setError(''); setSuccess('')
    let ok = 0, fail = 0
    for (const id of ids) { const { error } = await supabase.rpc(rpc, { p_id: id }); if (error) fail++; else ok++ }
    setBulkBusy(false); setSelCr(new Set())
    setSuccess(`${verb === 'approve' ? 'Approved' : 'Rejected'} ${ok} request(s)${fail ? ` · ${fail} failed (a document may be blocked by a duplicate)` : ''}.`)
    loadRequests()
  }

  function fmt(iso: string | null) { return iso ? new Date(iso).toLocaleString() : '—' }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' ? requests : requests.filter(r => r.status === filter)
  // Filterable columns on the change-requests table (dropdowns list the values present)
  const CR_COLS: { key: string; label: string; get: (r: ChangeRequest) => string }[] = [
    { key: 'doc', label: 'Document', get: r => r.sales_imports?.file_name || '—' },
    { key: 'line', label: 'Line', get: r => { const c = r.sales_order_lines?.item_code || (r.request_type === 'delete' ? (r.old_value || '') : ''); const d = r.sales_order_lines?.description || ''; return (c ? `${c}${d ? ' — ' + d : ''}` : '') || '—' } },
    { key: 'field', label: 'Field', get: r => r.request_type === 'delete' ? 'Whole line' : (FIELD_LABEL[r.field] || r.field) },
    { key: 'by', label: 'Requested by', get: r => r.requested_by_name || r.requested_by_email || '—' },
  ]
  const crDistinct = (key: string) => { const g = CR_COLS.find(c => c.key === key)!.get; return [...new Set(shown.map(g))].filter(Boolean).sort() }
  const shownF = shown.filter(r => CR_COLS.every(c => passes(crFilters[c.key], c.get(r))))
  const crPending = shownF.filter(r => r.status === 'Pending')
  const crAllSel = crPending.length > 0 && crPending.every(r => selCr.has(r.id))
  const toggleCrAll = () => setSelCr(crAllSel ? new Set() : new Set(crPending.map(r => r.id)))
  const selPendingIds = crPending.filter(r => selCr.has(r.id)).map(r => r.id)
  const shownCorrAll = filter === 'All' ? corrections : corrections.filter(c => c.status === filter)
  const shownCorr = shownCorrAll.filter(c => passes(corrFilters.label, c.label || c.timer_key) && passes(corrFilters.by, c.requested_by_name || '—'))
  const corrPending = shownCorr.filter(c => c.status === 'Pending')
  const corrAllSel = corrPending.length > 0 && corrPending.every(c => selCorr.has(c.id))
  const selCorrIds = corrPending.filter(c => selCorr.has(c.id)).map(c => c.id)
  const shownDoAll = filter === 'All' ? doChanges : doChanges.filter(c => c.status === filter)
  const shownDo = shownDoAll.filter(c => passes(doFilters.label, c.line_label || '—') && passes(doFilters.type, c.request_type) && passes(doFilters.by, c.requested_by_name || '—'))
  const doPending = shownDo.filter(c => c.status === 'Pending')
  const doAllSel = doPending.length > 0 && doPending.every(c => selDo.has(c.id))
  const selDoIds = doPending.filter(c => selDo.has(c.id)).map(c => c.id)
  const shownSplitAll = filter === 'All' ? splits : splits.filter(c => c.status === filter)
  const shownSplit = shownSplitAll.filter(c => passes(splitFilters.label, c.label || '—') && passes(splitFilters.by, c.requested_by_name || '—'))
  const splitPending = shownSplit.filter(c => c.status === 'Pending')
  const splitAllSel = splitPending.length > 0 && splitPending.every(c => selSplit.has(c.id))
  const selSplitIds = splitPending.filter(c => selSplit.has(c.id)).map(c => c.id)
  const saLabel = (a: StockAdj) => `${a.item_code}${a.description ? ' — ' + a.description : ''} · ${a.direction === 'in' ? 'IN' : 'OUT'} ${a.quantity}`
  const shownSAAll = filter === 'All' ? stockAdjs : stockAdjs.filter(a => a.status === filter)
  const shownSA = shownSAAll.filter(a => passes(saFilters.item, saLabel(a)) && passes(saFilters.by, a.requested_by_name || '—'))
  const saPending = shownSA.filter(a => a.status === 'Pending')
  const saAllSel = saPending.length > 0 && saPending.every(a => selSA.has(a.id))
  const selSAIds = saPending.filter(a => selSA.has(a.id)).map(a => a.id)
  const counts: Record<string, number> = { Pending: 0, Approved: 0, Rejected: 0 }
  requests.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Pending Changes</h1>
        <p className="text-gray-500 text-sm mb-5">
          {isHO ? 'Approve or reject change requests. Every decision is logged.' : 'Track the change requests you and your factory have raised.'}
        </p>

        <div className="flex gap-2 mb-4">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {isHO && selPendingIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selPendingIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_change_request', selPendingIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_change_request', selPendingIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelCr(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={crAllSel} onChange={toggleCrAll} className="h-4 w-4" /></th>}
                {['Document', 'Line', 'Field', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                {(['doc', 'line', 'field'] as const).map(k => (
                  <th key={k} className="px-2 py-1"><MultiFilter values={crDistinct(k)} selected={crFilters[k] || new Set()} onChange={s => setCrFilters(p => ({ ...p, [k]: s }))} /></th>
                ))}
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={crDistinct('by')} selected={crFilters['by'] || new Set()} onChange={s => setCrFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"></th>
                {isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownF.length === 0 && (<tr><td colSpan={10} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} change requests{Object.values(crFilters).some(s => s && s.size) ? ' match the filter' : ''}.</td></tr>)}
              {shownF.map(r => (
                <tr key={r.id} className={`border-b last:border-0 align-top ${selCr.has(r.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{r.status === 'Pending' ? <input type="checkbox" checked={selCr.has(r.id)} onChange={() => toggleCr(r.id)} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 min-w-[140px]">{r.sales_imports?.file_name || '—'}</td>
                  <td className="px-3 py-2 min-w-[160px]">
                    <span className="font-mono font-medium">{r.sales_order_lines?.item_code || (r.request_type === 'delete' ? r.old_value : '—')}</span>
                    <span className="block text-gray-400">{r.sales_order_lines?.description}</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.request_type === 'delete' ? 'Whole line' : (FIELD_LABEL[r.field] || r.field)}</td>
                  <td className="px-3 py-2 min-w-[160px]">
                    {r.request_type === 'delete'
                      ? <span className="text-red-600 font-medium">🗑 Delete line</span>
                      : <><span className="line-through text-gray-400">{r.old_value || '(empty)'}</span><span className="mx-1">→</span><span className="font-medium text-gray-800">{r.new_value}</span></>}
                  </td>
                  <td className="px-3 py-2 text-gray-600 min-w-[140px]">{r.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="block">{r.requested_by_name || r.requested_by_email}</span>
                    <span className="block text-gray-400">{fmt(r.requested_at)}</span>
                  </td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {r.status === 'Pending' ? '—' : (<><span className="block">{r.reviewed_by_name || r.reviewed_by_email}</span><span className="block text-gray-400">{fmt(r.reviewed_at)}</span></>)}
                  </td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approve(r.id)} disabled={busyId === r.id}
                            className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => reject(r.id)} disabled={busyId === r.id}
                            className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Timer cancellation requests */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Timer cancellations</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to clear a timer that was pressed by mistake.' : 'Track your requests to cancel a timer.'}</p>
        {isHO && selCorrIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selCorrIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_correction', selCorrIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_correction', selCorrIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelCorr(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={corrAllSel} onChange={() => setSelCorr(corrAllSel ? new Set() : new Set(corrPending.map(c => c.id)))} className="h-4 w-4" /></th>}
                {['Timer', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownCorrAll, c => c.label || c.timer_key)} selected={corrFilters.label || new Set()} onChange={s => setCorrFilters(p => ({ ...p, label: s }))} /></th>
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownCorrAll, c => c.requested_by_name || '—')} selected={corrFilters.by || new Set()} onChange={s => setCorrFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>{isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownCorr.length === 0 && (<tr><td colSpan={7} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} timer cancellations.</td></tr>)}
              {shownCorr.map(c => (
                <tr key={c.id} className={`border-b last:border-0 align-top ${selCorr.has(c.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{c.status === 'Pending' ? <input type="checkbox" checked={selCorr.has(c.id)} onChange={() => setSelCorr(p => { const n = new Set(p); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 min-w-[200px]">{c.label || c.timer_key}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[140px]">{c.reason || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{c.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(c.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[c.status] || 'bg-gray-100 text-gray-700'}`}>{c.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{c.status === 'Pending' ? '—' : (<><span className="block">{c.reviewed_by_name}</span><span className="block text-gray-400">{fmt(c.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {c.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveCorr(c.id)} disabled={busyId === c.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectCorr(c.id)} disabled={busyId === c.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Goods Received line changes */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Goods Received changes</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to apply edits, or delete a received line (this reverses its stock).' : 'Track your edit/delete requests on Goods Received lines.'}</p>
        {isHO && selDoIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selDoIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_do_change', selDoIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_do_change', selDoIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelDo(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={doAllSel} onChange={() => setSelDo(doAllSel ? new Set() : new Set(doPending.map(c => c.id)))} className="h-4 w-4" /></th>}
                {['Line', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownDoAll, c => c.line_label || '—')} selected={doFilters.label || new Set()} onChange={s => setDoFilters(p => ({ ...p, label: s }))} /></th>
                <th className="px-2 py-1"><MultiFilter values={['edit', 'delete']} selected={doFilters.type || new Set()} onChange={s => setDoFilters(p => ({ ...p, type: s }))} /></th>
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownDoAll, c => c.requested_by_name || '—')} selected={doFilters.by || new Set()} onChange={s => setDoFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>{isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownDo.length === 0 && (<tr><td colSpan={8} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} Goods Received changes.</td></tr>)}
              {shownDo.map(c => (
                <tr key={c.id} className={`border-b last:border-0 align-top ${selDo.has(c.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{c.status === 'Pending' ? <input type="checkbox" checked={selDo.has(c.id)} onChange={() => setSelDo(p => { const n = new Set(p); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 min-w-[160px]">{c.line_label || '—'}</td>
                  <td className="px-3 py-2 min-w-[160px]">
                    {c.request_type === 'delete'
                      ? <span className="text-red-600 font-medium">🗑 Delete line</span>
                      : <><span className="text-gray-500">{c.field}: </span><span className="line-through text-gray-400">{c.old_value || '(empty)'}</span><span className="mx-1">→</span><span className="font-medium text-gray-800">{c.new_value}</span></>}
                  </td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{c.reason || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{c.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(c.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[c.status] || 'bg-gray-100 text-gray-700'}`}>{c.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{c.status === 'Pending' ? '—' : (<><span className="block">{c.reviewed_by_name}</span><span className="block text-gray-400">{fmt(c.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {c.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveDo(c.id)} disabled={busyId === c.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectDo(c.id)} disabled={busyId === c.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Batch split requests */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Batch splits &amp; un-combine</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to pull an order into its own batch, or to run a grouped batch on its own. Nothing is deleted.' : 'Track your requests to split an order out, or to run a batch on its own.'}</p>
        {isHO && selSplitIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selSplitIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_split', selSplitIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_split', selSplitIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelSplit(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={splitAllSel} onChange={() => setSelSplit(splitAllSel ? new Set() : new Set(splitPending.map(c => c.id)))} className="h-4 w-4" /></th>}
                {['Order to split out', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownSplitAll, c => c.label || '—')} selected={splitFilters.label || new Set()} onChange={s => setSplitFilters(p => ({ ...p, label: s }))} /></th>
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownSplitAll, c => c.requested_by_name || '—')} selected={splitFilters.by || new Set()} onChange={s => setSplitFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>{isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownSplit.length === 0 && (<tr><td colSpan={7} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} batch splits.</td></tr>)}
              {shownSplit.map(c => (
                <tr key={c.id} className={`border-b last:border-0 align-top ${selSplit.has(c.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{c.status === 'Pending' ? <input type="checkbox" checked={selSplit.has(c.id)} onChange={() => setSelSplit(p => { const n = new Set(p); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n })} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 min-w-[220px]">{c.label || '—'}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{c.reason || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{c.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(c.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[c.status] || 'bg-gray-100 text-gray-700'}`}>{c.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{c.status === 'Pending' ? '—' : (<><span className="block">{c.reviewed_by_name}</span><span className="block text-gray-400">{fmt(c.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {c.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveSplit(c.id)} disabled={busyId === c.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectSplit(c.id)} disabled={busyId === c.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Stock adjustment requests */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Stock adjustments</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to apply a manual stock IN/OUT. IN adds a lot; OUT removes earliest-expiry first.' : 'Track your manual stock in/out requests.'}</p>
        {isHO && selSAIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selSAIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_stock_adjustment', selSAIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_stock_adjustment', selSAIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelSA(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={saAllSel} onChange={() => setSelSA(saAllSel ? new Set() : new Set(saPending.map(a => a.id)))} className="h-4 w-4" /></th>}
                {['Item', 'In/Out', 'Qty', 'Batch', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownSAAll, saLabel)} selected={saFilters.item || new Set()} onChange={s => setSaFilters(p => ({ ...p, item: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th><th className="px-2 py-1"></th><th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownSAAll, a => a.requested_by_name || '—')} selected={saFilters.by || new Set()} onChange={s => setSaFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>{isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownSA.length === 0 && (<tr><td colSpan={10} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} stock adjustments.</td></tr>)}
              {shownSA.map(a => (
                <tr key={a.id} className={`border-b last:border-0 align-top ${selSA.has(a.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{a.status === 'Pending' ? <input type="checkbox" checked={selSA.has(a.id)} onChange={() => setSelSA(p => { const n = new Set(p); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n })} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 min-w-[160px]"><span className="font-mono font-medium">{a.item_code}</span><span className="block text-gray-400">{a.description}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.direction === 'in' ? <span className="text-green-700 font-medium">➕ IN</span> : <span className="text-red-600 font-medium">➖ OUT</span>}</td>
                  <td className="px-3 py-2 text-right font-semibold">{a.quantity}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.batch_no || '—'}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveSA(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectSA(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
