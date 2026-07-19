'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'

// WMS Approvals — one place for a warehouse HOD (Head Office / admin) to clear every
// warehouse-side request in one go, the same "Approve all" idea as the production /
// Sales-Orders Pending Changes page, but scoped to WMS: photo bypass, stock
// adjustments, pick-check quantity corrections, and stock counts waiting to be applied.

interface GrnBypass { id: string; item_code: string | null; description: string | null; reason: string | null; status: string; requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null }
interface StockAdj { id: string; factory_code: string | null; item_code: string; description: string | null; direction: string; quantity: number; batch_no: string | null; reason: string | null; status: string; requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null }
interface WmsCheck { id: string; order_no: string | null; note: string | null; corrections: { item_code: string; picked_qty: number; checked_qty: number }[] | null; status: string; requested_by_name: string | null; created_at: string }
interface CountTask { id: string; count_no: string | null; name: string | null; status: string; completed_by_name: string | null; completed_at: string | null; created_by_name: string | null; created_at: string; wms_count_lines?: { count: number }[] }
interface PaperReq { id: string; do_number: string | null; factory_code: string | null; item_code: string | null; reason: string | null; status: string; requested_by_name: string | null; created_at: string }
interface Correction { id: string; kind: string; old_item_code: string | null; old_description: string | null; new_item_code: string | null; new_description: string | null; old_qty: number | null; new_qty: number | null; location_code: string | null; batch_no: string | null; new_batch: string | null; flag_fields: string | null; reason: string | null; status: string; requested_by_name: string | null; created_at: string }
interface ManualPick { id: string; order_no: string | null; item_code: string | null; description: string | null; uom: string | null; qty: number; note: string | null; status: string; requested_by_name: string | null; created_at: string }
interface Damage { id: string; order_no: string | null; item_code: string | null; description: string | null; uom: string | null; qty: number; from_location_code: string | null; batch: string | null; note: string | null; status: string; reported_by_name: string | null; created_at: string }

type Pend = { key: string; id: string; kind: string; summary: string; by: string | null; at: string; approve: () => Promise<void>; reject: (() => Promise<void>) | null; extra?: { label: string; fn: () => Promise<void> } | null; open?: string }

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

// A Putaway flag (item / qty / batch) raised for the office to revise. Shows each flagged field
// with the suggested correction (or "check" when the warehouse didn't know the right value).
function flagSummary(c: Correction): string {
  const fields = c.flag_fields ? c.flag_fields.split(',').map(s => s.trim()) : (c.new_batch != null ? ['batch'] : [])
  const parts: string[] = []
  if (fields.includes('item')) parts.push(`item ${c.old_item_code || c.old_description || '?'}${c.new_description ? ' → ' + c.new_description : ' (check)'}`)
  if (fields.includes('qty')) parts.push(`qty ×${c.old_qty ?? '?'}${c.new_qty != null ? ' → ' + c.new_qty : ' (check)'}`)
  if (fields.includes('batch')) parts.push(`batch ${c.batch_no || '—'}${c.new_batch ? ' → ' + c.new_batch : ' (check)'}`)
  return `Flag ${c.old_item_code || '?'}${c.location_code ? ' · ' + c.location_code : ''} — ${parts.join(', ') || 'check'}${c.reason ? ' · ' + c.reason : ''}`
}
const KIND_CHIP: Record<string, string> = {
  'Photo bypass': 'bg-indigo-100 text-indigo-700',
  'Stock adjustment': 'bg-amber-100 text-amber-700',
  'Pick check correction': 'bg-sky-100 text-sky-700',
  'Stock count': 'bg-violet-100 text-violet-700',
  'Paper receipt': 'bg-teal-100 text-teal-700',
  'Correction': 'bg-rose-100 text-rose-700',
  'Manual pick': 'bg-sky-100 text-sky-700',
  'Damaged stock': 'bg-orange-100 text-orange-700',
}
const approveLabel = (k: string) => k === 'Stock count' ? 'Apply' : k === 'Damaged stock' ? 'Write off' : 'Approve'
const rejectLabel = (k: string) => k === 'Damaged stock' ? 'Return to stock' : 'Reject'

export default function WmsApprovalsPage() {
  const { profile, loading } = useProfile()
  const isHO = !!profile && (profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')

  const [bypasses, setBypasses] = useState<GrnBypass[]>([])
  const [adjs, setAdjs] = useState<StockAdj[]>([])
  const [checks, setChecks] = useState<WmsCheck[]>([])
  const [counts, setCounts] = useState<CountTask[]>([])
  const [papers, setPapers] = useState<PaperReq[]>([])
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [manualPicks, setManualPicks] = useState<ManualPick[]>([])
  const [damages, setDamages] = useState<Damage[]>([])
  const [busy, setBusy] = useState('')
  const [allBusy, setAllBusy] = useState(false)
  const [err, setErr] = useState(''); const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const [{ data: bp }, { data: sa }, { data: wc }, { data: ct }, { data: pr }] = await Promise.all([
      supabase.from('grn_bypass_requests').select('*').eq('status', 'Pending').order('created_at', { ascending: false }),
      supabase.from('stock_adjustments').select('*').eq('status', 'Pending').order('created_at', { ascending: false }),
      supabase.from('wms_check_qty_requests').select('id, order_no, note, corrections, status, requested_by_name, created_at').eq('status', 'Pending').order('created_at', { ascending: false }),
      supabase.from('wms_count_tasks').select('id, count_no, name, status, completed_by_name, completed_at, created_by_name, created_at, wms_count_lines(count)').eq('status', 'Review').order('completed_at', { ascending: false }),
      supabase.from('do_paper_receipt_requests').select('id, do_number, factory_code, item_code, reason, status, requested_by_name, created_at').eq('status', 'Pending').order('created_at', { ascending: false }),
    ])
    const { data: cr } = await supabase.from('wms_correction_requests').select('id, kind, old_item_code, old_description, new_item_code, new_description, old_qty, new_qty, location_code, batch_no, new_batch, flag_fields, reason, status, requested_by_name, created_at').eq('status', 'Pending').order('created_at', { ascending: false })
    const { data: mp } = await supabase.from('wms_manual_pick_requests').select('id, order_no, item_code, description, uom, qty, note, status, requested_by_name, created_at').eq('status', 'Pending').order('created_at', { ascending: false })
    const { data: dg } = await supabase.from('wms_damage_reports').select('id, order_no, item_code, description, uom, qty, from_location_code, batch, note, status, reported_by_name, created_at').eq('status', 'Pending').order('created_at', { ascending: false })
    setBypasses((bp as GrnBypass[]) || [])
    setAdjs((sa as StockAdj[]) || [])
    setChecks((wc as WmsCheck[]) || [])
    setCounts((ct as CountTask[]) || [])
    setPapers((pr as PaperReq[]) || [])
    setCorrections((cr as Correction[]) || [])
    setManualPicks((mp as ManualPick[]) || [])
    setDamages((dg as Damage[]) || [])
  }, [])

  useEffect(() => {
    if (!profile) return
    load()
    supabase.auth.getSession().then(({ data }) => { if (data.session) supabase.realtime.setAuth(data.session.access_token) })
    const ch = supabase.channel('wms-approvals-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grn_bypass_requests' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_adjustments' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_check_qty_requests' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_count_tasks' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'do_paper_receipt_requests' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_correction_requests' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_manual_pick_requests' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_damage_reports' }, () => load())
      .subscribe()
    const timer = setInterval(load, 20000)
    return () => { supabase.removeChannel(ch); clearInterval(timer) }
  }, [profile, load])

  // RPC wrappers — each refreshes the list and surfaces a friendly message.
  const run = useCallback(async (id: string, rpc: string, params: Record<string, string>, okMsg: string) => {
    setBusy(id); setErr(''); setMsg('')
    const { error } = await supabase.rpc(rpc, params)
    setBusy('')
    if (error) { setErr(error.message); return false }
    setMsg(okMsg); load(); return true
  }, [load])

  const approveBypass = (id: string) => run(id, 'approve_grn_bypass', { p_id: id }, 'Photo bypass approved.')
  const rejectBypass = (id: string) => run(id, 'reject_grn_bypass', { p_id: id }, 'Photo bypass rejected.')
  const approveAdj = (id: string) => run(id, 'approve_stock_adjustment', { p_id: id }, 'Stock adjustment approved — stock updated.')
  const rejectAdj = (id: string) => run(id, 'reject_stock_adjustment', { p_id: id }, 'Stock adjustment rejected.')
  const approveCheck = (id: string) => run(id, 'approve_wms_check_correction', { p_id: id }, 'Pick-check correction approved.')
  const rejectCheck = (id: string) => run(id, 'reject_wms_check_correction', { p_id: id }, 'Pick-check correction rejected.')
  const applyCount = (id: string) => run(id, 'wms_apply_count', { p_task_id: id }, 'Stock count applied — stock corrected.')
  const approvePaper = (id: string) => run(id, 'approve_do_paper_receipt', { p_id: id }, 'Paper receipt approved — the delivery is marked received.')
  const rejectPaper = (id: string) => run(id, 'reject_do_paper_receipt', { p_id: id }, 'Paper receipt rejected.')
  const approveCorr = (id: string) => run(id, 'approve_wms_correction', { p_id: id }, 'Correction applied.')
  const rejectCorr = (id: string) => run(id, 'reject_wms_correction', { p_id: id }, 'Correction rejected.')
  const approveManual = (id: string) => run(id, 'approve_wms_manual_pick', { p_id: id }, 'Manual fill approved — booked as picked.')
  const rejectManual = (id: string) => run(id, 'reject_wms_manual_pick', { p_id: id }, 'Manual fill rejected.')
  const damageWriteoff = (id: string) => run(id, 'resolve_damage_writeoff', { p_id: id }, 'Damaged stock written off.')
  const damageReturn = (id: string) => run(id, 'resolve_damage_return', { p_id: id }, 'Damaged stock returned to its bin.')
  const damageReturnSupplier = (id: string) => run(id, 'resolve_damage_return_supplier', { p_id: id }, 'Damaged stock returned to supplier.')

  const allPending = useMemo<Pend[]>(() => [
    ...bypasses.map(b => ({ key: `bp|${b.id}`, id: b.id, kind: 'Photo bypass', summary: `${b.item_code || '—'}${b.description ? ' · ' + b.description : ''}${b.reason ? ' · ' + b.reason : ''}`, by: b.requested_by_name, at: b.created_at, approve: () => approveBypass(b.id).then(() => {}), reject: () => rejectBypass(b.id).then(() => {}) })),
    ...adjs.map(a => ({ key: `sa|${a.id}`, id: a.id, kind: 'Stock adjustment', summary: `${a.item_code}${a.description ? ' — ' + a.description : ''} · ${a.direction === 'in' ? 'IN' : 'OUT'} ${a.quantity}${a.batch_no ? ' · ' + a.batch_no : ''}${a.reason ? ' · ' + a.reason : ''}`, by: a.requested_by_name, at: a.created_at, approve: () => approveAdj(a.id).then(() => {}), reject: () => rejectAdj(a.id).then(() => {}) })),
    ...checks.map(w => ({ key: `wc|${w.id}`, id: w.id, kind: 'Pick check correction', summary: `${w.order_no || 'order'} · ${(w.corrections || []).map(c => `${c.item_code} ${c.picked_qty}→${c.checked_qty}`).join(', ') || w.note || ''}`, by: w.requested_by_name, at: w.created_at, approve: () => approveCheck(w.id).then(() => {}), reject: () => rejectCheck(w.id).then(() => {}) })),
    ...counts.map(c => ({ key: `ct|${c.id}`, id: c.id, kind: 'Stock count', summary: `${c.count_no || '—'}${c.name ? ' · ' + c.name : ''} · ${c.wms_count_lines?.[0]?.count ?? 0} line(s) counted`, by: c.completed_by_name || c.created_by_name, at: c.completed_at || c.created_at, approve: () => applyCount(c.id).then(() => {}), reject: null, open: `/wms/counts/${c.id}` })),
    ...papers.map(p => ({ key: `pr|${p.id}`, id: p.id, kind: 'Paper receipt', summary: `${p.do_number || 'DO'}${p.factory_code ? ' · ' + p.factory_code : ''}${p.item_code ? ' · item ' + p.item_code : ' · whole DO'}${p.reason ? ' · ' + p.reason : ''} — receive on paper (no photos)`, by: p.requested_by_name, at: p.created_at, approve: () => approvePaper(p.id).then(() => {}), reject: () => rejectPaper(p.id).then(() => {}) })),
    ...corrections.map(c => ({ key: `cr|${c.id}`, id: c.id, kind: 'Correction', summary: c.kind === 'stock_recode'
        ? `Re-code stock ${c.old_item_code || '?'} → ${c.new_item_code || '?'}${c.location_code ? ' · ' + c.location_code : ''}${c.batch_no ? ' · b:' + c.batch_no : ''}${c.reason ? ' · ' + c.reason : ''}`
        : (c.kind === 'batch_flag' || c.kind === 'stock_flag')
        ? flagSummary(c)
        : c.kind === 'stock_adjust'
        ? `${Number(c.new_qty) === 0 ? 'Remove' : 'Adjust'} stock ${c.old_item_code || '?'}${c.location_code ? ' · ' + c.location_code : ''}${c.batch_no ? ' · b:' + c.batch_no : ''} · ${c.old_qty ?? '?'} → ${c.new_qty ?? '?'}${c.reason ? ' · ' + c.reason : ''}`
        : `Edit PO line ${c.old_item_code || '?'} → ${c.new_item_code || c.old_item_code || '?'}${c.new_qty != null ? ' · qty ' + c.new_qty : ''}${c.reason ? ' · ' + c.reason : ''}`,
      by: c.requested_by_name, at: c.created_at, approve: () => approveCorr(c.id).then(() => {}), reject: () => rejectCorr(c.id).then(() => {}) })),
    ...manualPicks.map(m => ({ key: `mp|${m.id}`, id: m.id, kind: 'Manual pick', summary: `${m.order_no || 'order'} · ${m.item_code || '?'}${m.description ? ' — ' + m.description : ''} · fill ${m.qty}${m.uom ? ' ' + m.uom : ''}${m.note ? ' · ' + m.note : ''}`, by: m.requested_by_name, at: m.created_at, approve: () => approveManual(m.id).then(() => {}), reject: () => rejectManual(m.id).then(() => {}) })),
    ...damages.map(d => ({ key: `dg|${d.id}`, id: d.id, kind: 'Damaged stock', summary: `${d.item_code || '?'}${d.description ? ' — ' + d.description : ''} · ${d.qty}${d.uom ? ' ' + d.uom : ''} from ${d.from_location_code || '?'}${d.batch ? ' · b:' + d.batch : ''} → DAMAGED${d.note ? ' · ' + d.note : ''}${d.order_no ? ' · ' + d.order_no : ''}`, by: d.reported_by_name, at: d.created_at, approve: () => damageWriteoff(d.id).then(() => {}), reject: () => damageReturn(d.id).then(() => {}), extra: { label: 'Return to supplier', fn: () => damageReturnSupplier(d.id).then(() => {}) } })),
  ].sort((a, b) => (a.at || '').localeCompare(b.at || '')), [bypasses, adjs, checks, counts, papers, corrections, manualPicks, damages, approveBypass, rejectBypass, approveAdj, rejectAdj, approveCheck, rejectCheck, applyCount, approvePaper, rejectPaper, approveCorr, rejectCorr, approveManual, rejectManual, damageWriteoff, damageReturn, damageReturnSupplier])

  async function approveAll() {
    if (allPending.length === 0) return
    const nCounts = counts.length
    const nDmg = damages.length
    if (!confirm(`Approve all ${allPending.length} pending request(s)?${nCounts ? `\n\nThis includes ${nCounts} stock count(s) — approving them applies the counted stock corrections.` : ''}${nDmg ? `\n\n⚠ This includes ${nDmg} damaged-stock report(s) — "Approve all" WRITES THEM OFF. To return any to stock instead, handle it individually first.` : ''}\n\nEach one is applied and logged.`)) return
    setAllBusy(true); setErr(''); setMsg('')
    let ok = 0, fail = 0
    for (const p of allPending) { try { await p.approve(); ok++ } catch { fail++ } }
    setAllBusy(false)
    setMsg(`Processed ${ok} request(s)${fail ? ` · ${fail} failed` : ''}.`); load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  const byKind = (k: string) => allPending.filter(p => p.kind === k).length
  const CARDS = [
    { kind: 'Photo bypass', n: byKind('Photo bypass') },
    { kind: 'Stock adjustment', n: byKind('Stock adjustment') },
    { kind: 'Pick check correction', n: byKind('Pick check correction') },
    { kind: 'Stock count', n: byKind('Stock count') },
    { kind: 'Paper receipt', n: byKind('Paper receipt') },
    { kind: 'Correction', n: byKind('Correction') },
    { kind: 'Manual pick', n: byKind('Manual pick') },
    { kind: 'Damaged stock', n: byKind('Damaged stock') },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
          <div>
            <h1 className="text-2xl font-bold">WMS Approvals</h1>
            <p className="text-gray-500 text-sm mt-1">Warehouse requests waiting for Head Office — approve them one by one, or all at once.</p>
          </div>
          <button onClick={load} className="text-sm text-emerald-700 hover:underline">↻ Refresh</button>
        </div>

        {!isHO && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 my-4">Only Head Office can approve these. You can see what’s pending, but the buttons are hidden.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg my-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg my-4">✓ {msg}</p>}

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 my-5">
          {CARDS.map(c => (
            <div key={c.kind} className="bg-white rounded-xl border shadow-sm px-4 py-3">
              <div className={`text-2xl font-bold tabular-nums ${c.n ? 'text-gray-900' : 'text-gray-300'}`}>{c.n}</div>
              <div className="text-xs text-gray-500 mt-0.5">{c.kind}</div>
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b bg-gray-50 flex-wrap">
            <span className="font-semibold">📋 All pending — <span className="text-emerald-700">{allPending.length}</span> request(s)</span>
            {isHO && allPending.length > 0 && (
              <button onClick={approveAll} disabled={allBusy} className="bg-green-600 text-white px-4 py-1.5 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium">
                {allBusy ? 'Approving…' : `✓ Approve all (${allPending.length})`}
              </button>
            )}
          </div>
          {/* Desktop: table */}
          <div className="hidden sm:block overflow-auto max-h-[32rem]">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0 z-10"><tr>{['Type', 'Details', 'Requested by', 'Action'].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>
                {allPending.length === 0 && <tr><td colSpan={4} className="text-center py-12 text-gray-400">Nothing pending 🎉</td></tr>}
                {allPending.map(p => (
                  <tr key={p.key} className="border-b last:border-0 hover:bg-gray-50 align-top">
                    <td className="px-3 py-2.5 whitespace-nowrap"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${KIND_CHIP[p.kind] || 'bg-gray-100 text-gray-700'}`}>{p.kind}</span></td>
                    <td className="px-3 py-2.5 min-w-[260px]">{p.summary}{p.open && <Link href={p.open} className="ml-2 text-emerald-700 hover:underline text-xs">open →</Link>}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-xs"><span className="block">{p.by || '—'}</span><span className="block text-gray-400">{fmt(p.at)}</span></td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {isHO ? <div className="flex gap-2">
                        <button onClick={() => p.approve()} disabled={busy === p.id || allBusy} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50 text-xs">{approveLabel(p.kind)}</button>
                        {p.reject && <button onClick={() => p.reject!()} disabled={busy === p.id || allBusy} className={`text-white px-3 py-1 rounded disabled:opacity-50 text-xs ${p.kind === 'Damaged stock' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>{rejectLabel(p.kind)}</button>}
                        {p.extra && <button onClick={() => p.extra!.fn()} disabled={busy === p.id || allBusy} className="bg-rose-600 text-white px-3 py-1 rounded hover:bg-rose-700 disabled:opacity-50 text-xs">{p.extra.label}</button>}
                      </div> : <span className="text-gray-400 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: one card per pending request */}
          <div className="sm:hidden p-3 space-y-2">
            {allPending.length === 0 && <div className="text-center py-8 text-gray-400 text-sm">Nothing pending 🎉</div>}
            {allPending.map(p => (
              <div key={p.key} className="bg-white rounded-xl border shadow-sm p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${KIND_CHIP[p.kind] || 'bg-gray-100 text-gray-700'}`}>{p.kind}</span>
                  <span className="text-xs text-gray-400 text-right shrink-0">{fmt(p.at)}</span>
                </div>
                <div className="text-sm mt-2 leading-snug">{p.summary}{p.open && <Link href={p.open} className="ml-2 text-emerald-700 hover:underline text-xs">open →</Link>}</div>
                <div className="text-xs text-gray-400 mt-1">{p.by || '—'}</div>
                {isHO && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5 pt-2 border-t text-xs">
                    <button onClick={() => p.approve()} disabled={busy === p.id || allBusy} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">{approveLabel(p.kind)}</button>
                    {p.reject && <button onClick={() => p.reject!()} disabled={busy === p.id || allBusy} className={`text-white px-3 py-1 rounded disabled:opacity-50 ${p.kind === 'Damaged stock' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>{rejectLabel(p.kind)}</button>}
                    {p.extra && <button onClick={() => p.extra!.fn()} disabled={busy === p.id || allBusy} className="bg-rose-600 text-white px-3 py-1 rounded hover:bg-rose-700 disabled:opacity-50">{p.extra.label}</button>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 px-4 py-2 border-t">Photo bypasses, stock adjustments and pick-check corrections all appear here. “Stock count” rows are counts finished and waiting to be applied — approving one applies its stock corrections. The full Sales/production Pending Changes page still lives under Sales Orders.</p>
        </div>
      </div>
    </div>
  )
}
