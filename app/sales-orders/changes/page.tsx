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

interface RunModeReq {
  id: string; batch_no: string | null; item_code: string | null; from_mode: string | null; to_mode: string | null
  reason: string | null; status: string; requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface MrCancelReq {
  id: string; request_no: string | null; factory_code: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface DocDelReq {
  id: string; file_name: string | null; file_path: string | null; factory_code: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface RetEditReq {
  id: string; factory_code: string | null; item_code: string | null; batch_no: string | null
  old_qty: number | null; new_qty: number | null; new_reason: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface ItemChangeReq {
  id: string; item_code: string | null; field: string | null; old_value: string | null; new_value: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface SoChangeReq {
  id: string; pick_run_no: string | null; factory_code: string | null; old_so: string | null; new_so: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface QtyMoveReq {
  id: string; item_code: string | null; qty: number | null; from_label: string | null; to_label: string | null; reason: string | null; status: string
  requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

interface FoodLossAlert {
  id: string; factory_code: string | null; batch_no: string | null; item_code: string | null; pct: number | null; status: string
  created_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
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
  const [runModes, setRunModes] = useState<RunModeReq[]>([])
  const [selRM, setSelRM] = useState<Set<string>>(new Set())
  const [rmFilters, setRmFilters] = useState<Record<string, Set<string>>>({})
  const [mrCancels, setMrCancels] = useState<MrCancelReq[]>([])
  const [selMC, setSelMC] = useState<Set<string>>(new Set())
  const [mcFilters, setMcFilters] = useState<Record<string, Set<string>>>({})
  const [docDels, setDocDels] = useState<DocDelReq[]>([])
  const [retEdits, setRetEdits] = useState<RetEditReq[]>([])
  const [itemChanges, setItemChanges] = useState<ItemChangeReq[]>([])
  const [soChanges, setSoChanges] = useState<SoChangeReq[]>([])
  const [qtyMoves, setQtyMoves] = useState<QtyMoveReq[]>([])
  const [foodLoss, setFoodLoss] = useState<FoodLossAlert[]>([])

  // Distinct values present in a list, for a filter dropdown
  const distinctOf = <T,>(arr: T[], get: (x: T) => string) => [...new Set(arr.map(get))].filter(Boolean).sort()
  // A row passes a column filter when nothing is selected, or its value is ticked
  const passes = (sel: Set<string> | undefined, val: string) => !sel || sel.size === 0 || sel.has(val)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => {
    if (!profile) return
    loadRequests(); loadCorrections(); loadDoChanges(); loadSplits(); loadStockAdjs(); loadRunModes(); loadMrCancels(); loadDocDels(); loadRetEdits(); loadItemChanges(); loadSoChanges(); loadQtyMoves(); loadFoodLoss()
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'run_mode_requests' }, () => loadRunModes())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mr_cancel_requests' }, () => loadMrCancels())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doc_delete_requests' }, () => loadDocDels())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'return_edit_requests' }, () => loadRetEdits())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'item_change_requests' }, () => loadItemChanges())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'so_change_requests' }, () => loadSoChanges())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mr_qty_move_requests' }, () => loadQtyMoves())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'food_loss_alerts' }, () => loadFoodLoss())
      .subscribe()
    const timer = setInterval(() => { loadRequests(); loadCorrections(); loadDoChanges(); loadSplits(); loadStockAdjs(); loadRunModes(); loadMrCancels(); loadDocDels(); loadRetEdits(); loadItemChanges(); loadSoChanges(); loadQtyMoves() }, 20000)
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
  async function loadRunModes() {
    const { data } = await supabase.from('run_mode_requests').select('*').order('created_at', { ascending: false })
    setRunModes((data as RunModeReq[]) || [])
  }
  async function loadMrCancels() {
    const { data } = await supabase.from('mr_cancel_requests').select('*').order('created_at', { ascending: false })
    setMrCancels((data as MrCancelReq[]) || [])
  }
  async function approveMC(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_mr_cancel', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Material request cancelled — its batches are freed.'); setBusyId(''); loadMrCancels()
  }
  async function rejectMC(id: string) {
    if (!confirm('Reject this cancellation? The material request stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_mr_cancel', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Cancellation rejected.'); setBusyId(''); loadMrCancels()
  }
  async function loadDocDels() {
    const { data } = await supabase.from('doc_delete_requests').select('*').order('created_at', { ascending: false })
    setDocDels((data as DocDelReq[]) || [])
  }
  async function approveDD(r: DocDelReq) {
    setBusyId(r.id); setError(''); setSuccess('')
    const { data: path, error: e } = await supabase.rpc('approve_doc_delete', { p_id: r.id })
    if (e) { setError(e.message); setBusyId(''); return }
    if (path) await supabase.storage.from('sales-orders').remove([path as string])
    setSuccess(`Deleted "${r.file_name}".`); setBusyId(''); loadDocDels()
  }
  async function rejectDD(id: string) {
    if (!confirm('Reject this delete request? The document stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_doc_delete', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Delete request rejected.'); setBusyId(''); loadDocDels()
  }
  async function loadRetEdits() {
    const { data } = await supabase.from('return_edit_requests').select('*').order('created_at', { ascending: false })
    setRetEdits((data as RetEditReq[]) || [])
  }
  async function approveRE(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_return_edit', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Return edit approved — stock adjusted.'); setBusyId(''); loadRetEdits()
  }
  async function rejectRE(id: string) {
    if (!confirm('Reject this return edit? The return stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_return_edit', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Return edit rejected.'); setBusyId(''); loadRetEdits()
  }
  async function loadItemChanges() {
    const { data } = await supabase.from('item_change_requests').select('*').order('created_at', { ascending: false })
    setItemChanges((data as ItemChangeReq[]) || [])
  }
  async function approveIC(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_item_change', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Item change approved — the item was updated.'); setBusyId(''); loadItemChanges()
  }
  async function rejectIC(id: string) {
    if (!confirm('Reject this item change? The item stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_item_change', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Item change rejected.'); setBusyId(''); loadItemChanges()
  }
  async function loadSoChanges() {
    const { data } = await supabase.from('so_change_requests').select('*').order('created_at', { ascending: false })
    setSoChanges((data as SoChangeReq[]) || [])
  }
  async function approveSO(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_so_change', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('SO number change approved.'); setBusyId(''); loadSoChanges()
  }
  async function rejectSO(id: string) {
    if (!confirm('Reject this SO number change? It stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_so_change', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('SO number change rejected.'); setBusyId(''); loadSoChanges()
  }
  async function loadQtyMoves() {
    const { data } = await supabase.from('mr_qty_move_requests').select('*').order('created_at', { ascending: false })
    setQtyMoves((data as QtyMoveReq[]) || [])
  }
  async function approveQM(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_mr_qty_move', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Quantity move approved.'); setBusyId(''); loadQtyMoves()
  }
  async function rejectQM(id: string) {
    if (!confirm('Reject this quantity move? Nothing changes.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_mr_qty_move', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Quantity move rejected.'); setBusyId(''); loadQtyMoves()
  }
  async function loadFoodLoss() {
    const { data } = await supabase.from('food_loss_alerts').select('*').order('created_at', { ascending: false })
    setFoodLoss((data as FoodLossAlert[]) || [])
  }
  async function ackFL(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('ack_food_loss', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Food-loss alert acknowledged.'); setBusyId(''); loadFoodLoss()
  }
  async function approveRM(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_run_mode', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Run mode changed — materials recalculated.'); setBusyId(''); loadRunModes()
  }
  async function rejectRM(id: string) {
    if (!confirm('Reject this run-mode change? The mode stays as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_run_mode', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Run-mode change rejected.'); setBusyId(''); loadRunModes()
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
  const rmLabel = (r: RunModeReq) => `${r.batch_no || ''}${r.item_code ? ' · ' + r.item_code : ''}`
  const shownRMAll = filter === 'All' ? runModes : runModes.filter(a => a.status === filter)
  const shownRM = shownRMAll.filter(a => passes(rmFilters.batch, rmLabel(a)) && passes(rmFilters.by, a.requested_by_name || '—'))
  const rmPending = shownRM.filter(a => a.status === 'Pending')
  const rmAllSel = rmPending.length > 0 && rmPending.every(a => selRM.has(a.id))
  const selRMIds = rmPending.filter(a => selRM.has(a.id)).map(a => a.id)
  const shownMCAll = filter === 'All' ? mrCancels : mrCancels.filter(a => a.status === filter)
  const shownMC = shownMCAll.filter(a => passes(mcFilters.req, a.request_no || '—') && passes(mcFilters.by, a.requested_by_name || '—'))
  const mcPending = shownMC.filter(a => a.status === 'Pending')
  const mcAllSel = mcPending.length > 0 && mcPending.every(a => selMC.has(a.id))
  const selMCIds = mcPending.filter(a => selMC.has(a.id)).map(a => a.id)
  const shownDD = filter === 'All' ? docDels : docDels.filter(a => a.status === filter)
  const shownRE = filter === 'All' ? retEdits : retEdits.filter(a => a.status === filter)
  const ITEM_FIELD_LABEL: Record<string, string> = { description: 'Description', unit: 'Unit', type: 'Type', stock_group: 'Stock Group', supplied_by_factory: 'Made at factory', kg_per_bag: 'KG per bag', pcs_per_roll: 'Pieces per roll' }
  const shownIC = filter === 'All' ? itemChanges : itemChanges.filter(a => a.status === filter)
  const shownSO = filter === 'All' ? soChanges : soChanges.filter(a => a.status === filter)
  const shownQM = filter === 'All' ? qtyMoves : qtyMoves.filter(a => a.status === filter)
  const shownFL = filter === 'All' ? foodLoss : foodLoss.filter(a => filter === 'Pending' ? a.status === 'Pending' : a.status !== 'Pending')
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

        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
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
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
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
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
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
                      : <><span className="text-gray-500">{c.request_type === 'correct_qty' ? 'Correct received qty: ' : `${c.field}: `}</span><span className="line-through text-gray-400">{c.old_value || '(empty)'}</span><span className="mx-1">→</span><span className="font-medium text-gray-800">{c.new_value}</span></>}
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
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
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
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
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

        {/* Run-mode change requests */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Run-mode changes</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to switch a batch between Auto and Manual. The open material request is recalculated (roll vs pieces).' : 'Track your requests to change a batch run mode.'}</p>
        {isHO && selRMIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selRMIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_run_mode', selRMIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_run_mode', selRMIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelRM(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={rmAllSel} onChange={() => setSelRM(rmAllSel ? new Set() : new Set(rmPending.map(a => a.id)))} className="h-4 w-4" /></th>}
                {['Batch / item', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownRMAll, rmLabel)} selected={rmFilters.batch || new Set()} onChange={s => setRmFilters(p => ({ ...p, batch: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownRMAll, a => a.requested_by_name || '—')} selected={rmFilters.by || new Set()} onChange={s => setRmFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>{isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownRM.length === 0 && (<tr><td colSpan={8} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} run-mode changes.</td></tr>)}
              {shownRM.map(a => (
                <tr key={a.id} className={`border-b last:border-0 align-top ${selRM.has(a.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{a.status === 'Pending' ? <input type="checkbox" checked={selRM.has(a.id)} onChange={() => setSelRM(p => { const n = new Set(p); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n })} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono font-medium">{a.batch_no}</span><span className="block text-gray-400">{a.item_code}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="capitalize">{a.from_mode}</span> <span className="mx-1">→</span> <span className="capitalize font-medium text-gray-800">{a.to_mode}</span></td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveRM(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectRM(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Material request cancellations (released to warehouse) */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Material request cancellations</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to cancel a material request that was already sent to the warehouse. Its batches are freed (only if nothing was received).' : 'Track your requests to cancel a released material request.'}</p>
        {isHO && selMCIds.length > 0 && (
          <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
            <span className="font-medium text-blue-800">{selMCIds.length} pending selected</span>
            <button onClick={() => bulkAct('approve_mr_cancel', selMCIds, 'approve')} disabled={bulkBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">Approve selected</button>
            <button onClick={() => bulkAct('reject_mr_cancel', selMCIds, 'reject')} disabled={bulkBusy} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium">Reject selected</button>
            <button onClick={() => setSelMC(new Set())} className="text-gray-500 hover:underline">Clear</button>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>
                {isHO && <th className="px-3 py-2"><input type="checkbox" checked={mcAllSel} onChange={() => setSelMC(mcAllSel ? new Set() : new Set(mcPending.map(a => a.id)))} className="h-4 w-4" /></th>}
                {['Request', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                  <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}
              </tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"></th>}
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownMCAll, a => a.request_no || '—')} selected={mcFilters.req || new Set()} onChange={s => setMcFilters(p => ({ ...p, req: s }))} /></th>
                <th className="px-2 py-1"></th>
                <th className="px-2 py-1"><MultiFilter values={distinctOf(shownMCAll, a => a.requested_by_name || '—')} selected={mcFilters.by || new Set()} onChange={s => setMcFilters(p => ({ ...p, by: s }))} /></th>
                <th className="px-2 py-1"></th><th className="px-2 py-1"></th>{isHO && <th className="px-2 py-1"></th>}
              </tr>
            </thead>
            <tbody>
              {shownMC.length === 0 && (<tr><td colSpan={7} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} material request cancellations.</td></tr>)}
              {shownMC.map(a => (
                <tr key={a.id} className={`border-b last:border-0 align-top ${selMC.has(a.id) ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  {isHO && <td className="px-3 py-2">{a.status === 'Pending' ? <input type="checkbox" checked={selMC.has(a.id)} onChange={() => setSelMC(p => { const n = new Set(p); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n })} className="h-4 w-4" /> : null}</td>}
                  <td className="px-3 py-2 whitespace-nowrap font-mono font-medium">{a.request_no}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveMC(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectMC(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Document delete requests (whole Sales Order document) */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Document delete requests</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to permanently delete the Sales Order document — its PDF, extracted lines and change requests are removed.' : 'Track your requests to delete a Sales Order document.'}</p>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['File', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shownDD.length === 0 && (<tr><td colSpan={6} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} document delete requests.</td></tr>)}
              {shownDD.map(a => (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium min-w-[160px]">{a.file_name || '—'}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveDD(a)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectDD(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Material return edits */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Material return edits</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to change a past material return — approving adjusts the batch stock by the difference.' : 'Track your requests to edit a material return.'}</p>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['Material', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shownRE.length === 0 && (<tr><td colSpan={7} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} material return edits.</td></tr>)}
              {shownRE.map(a => (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap"><span className="font-mono font-medium">{a.item_code}</span><span className="block text-gray-400">batch {a.batch_no || '—'}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">qty {a.old_qty} → <strong>{a.new_qty}</strong></td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveRE(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectRE(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Item master changes */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Item changes</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to apply a staff-requested change to the Items master.' : 'Track your requested changes to the Items master.'}</p>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['Item', 'Field', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shownIC.length === 0 && (<tr><td colSpan={8} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} item changes.</td></tr>)}
              {shownIC.map(a => (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{a.item_code}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{ITEM_FIELD_LABEL[a.field || ''] || a.field}</td>
                  <td className="px-3 py-2"><span className="text-gray-400 line-through">{a.old_value || '—'}</span> → <strong>{a.new_value || '(blank)'}</strong></td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveIC(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectIC(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pick-run SO number changes */}
        <h2 className="text-lg font-semibold mt-8 mb-2">SO number changes</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to change the SO number on a released pick run.' : 'Track your requests to change a pick-run SO number.'}</p>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem] mb-10">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['Pick run', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shownSO.length === 0 && (<tr><td colSpan={7} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} SO number changes.</td></tr>)}
              {shownSO.map(a => (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{a.pick_run_no}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="text-gray-400 line-through">{a.old_so || '—'}</span> → <strong>{a.new_so}</strong></td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveSO(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectSO(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Move received qty between requests */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Received-quantity moves</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Approve to move a received quantity from one material request to another (same material).' : 'Track your requests to move received quantity between requests.'}</p>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem] mb-10">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['Material', 'Move', 'From → To', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shownQM.length === 0 && (<tr><td colSpan={8} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} quantity moves.</td></tr>)}
              {shownQM.map(a => (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{a.item_code}</td>
                  <td className="px-3 py-2 text-right font-semibold">{a.qty}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[160px]">{a.from_label} → <strong>{a.to_label}</strong></td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approveQM(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => rejectQM(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Food-loss alerts (inspection) */}
        <h2 className="text-lg font-semibold mt-8 mb-2">Food-loss alerts</h2>
        <p className="text-gray-500 text-sm mb-3">{isHO ? 'Production runs where food loss exceeded 5%. Investigate, then acknowledge.' : 'Food-loss alerts raised at your factory.'}</p>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem] mb-10">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['Factory', 'Batch', 'Item', 'Food loss %', 'Raised by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shownFL.length === 0 && (<tr><td colSpan={8} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} food-loss alerts.</td></tr>)}
              {shownFL.map(a => (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.factory_code}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{a.batch_no}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{a.item_code}</td>
                  <td className="px-3 py-2 text-right font-semibold text-red-600">{a.pct != null ? a.pct + '%' : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.created_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${a.status === 'Pending' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (<td className="px-3 py-2 whitespace-nowrap">{a.status === 'Pending' ? <button onClick={() => ackFL(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Acknowledge</button> : <span className="text-gray-400">done</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
