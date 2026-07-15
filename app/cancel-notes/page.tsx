'use client'
import { useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'

interface Note {
  id: string; cancel_note_no: string | null; so_number: string | null; customer_name: string | null; item_code: string | null; description: string | null
  factory_code: string | null; ordered_qty: number | null; delivered_qty: number | null; cancel_qty: number | null
  reason: string | null; status: string
  requested_by_name: string | null; reviewed_by_name: string | null; reviewed_at: string | null; created_at: string
}
interface Cand {
  line_id: string; so_number: string | null; customer_name: string | null; item_code: string | null; description: string | null
  factory_code: string | null; delivery_date: string | null; ordered_qty: number | null; delivered_qty: number | null; balance: number | null
}

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700', Approved: 'bg-green-100 text-green-700', Rejected: 'bg-red-100 text-red-700',
}

export default function CancelNotesPage() {
  const { profile, loading, error } = useProfile()
  useRequireView(profile, 'sales')
  const [notes, setNotes] = useState<Note[]>([])
  const [q, setQ] = useState('')
  const [statusF, setStatusF] = useState('')
  const [cands, setCands] = useState<Cand[]>([])
  const [selCand, setSelCand] = useState<Set<string>>(new Set())
  const [candReason, setCandReason] = useState('')
  const [candQ, setCandQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => { if (profile) load() }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  async function load() {
    const { data } = await supabase.from('so_balance_cancel_requests').select('*').order('created_at', { ascending: false })
    setNotes((data as Note[]) || [])
    const { data: c } = await supabase.rpc('so_lines_unscheduled')
    setCands((c as Cand[]) || [])
  }
  // Group the candidate lines by SO so a whole order can be cancelled in one tick.
  const allGroups = useMemo(() => {
    const m = new Map<string, Cand[]>()
    cands.forEach(c => { const k = c.so_number || '—'; const a = m.get(k) || []; a.push(c); m.set(k, a) })
    return [...m.entries()].map(([so, lines]) => ({
      so, lines, ids: lines.map(l => l.line_id),
      customer: lines[0]?.customer_name || '',
      factories: [...new Set(lines.map(l => l.factory_code).filter(Boolean))].join(', '),
      deliveryDate: lines.map(l => l.delivery_date).filter(Boolean).sort()[0] || '',
      items: lines.map(l => ({ code: l.item_code || '', name: l.description || '' })),
      balance: lines.reduce((s, l) => s + Number(l.balance || 0), 0),
    }))
  }, [cands])
  const groups = useMemo(() => {
    const n = candQ.trim().toLowerCase()
    if (!n) return allGroups
    return allGroups.filter(g => `${g.so} ${g.customer} ${g.factories} ${g.deliveryDate} ${g.items.map(i => i.code + ' ' + i.name).join(' ')}`.toLowerCase().includes(n))
  }, [allGroups, candQ])
  const groupChecked = (ids: string[]) => ids.length > 0 && ids.every(id => selCand.has(id))
  const toggleGroup = (ids: string[]) => setSelCand(p => { const n = new Set(p); const all = ids.every(id => n.has(id)); ids.forEach(id => all ? n.delete(id) : n.add(id)); return n })
  const selSoCount = groups.filter(g => groupChecked(g.ids)).length
  // HO cancels the ticked balances outright (writes Cancel Notes); factory raises them for approval.
  async function proceedCancel() {
    const ids = [...selCand]
    if (!ids.length) { setMsg(''); return }
    if (!confirm(`${isHO ? 'Cancel' : 'Request cancel for'} the balance of ${ids.length} order line(s) not on any delivery schedule?`)) return
    setBusy(true); setMsg('')
    let ok = 0; let firstErr = ''
    for (const id of ids) {
      const { error } = isHO
        ? await supabase.rpc('cancel_so_balance_now', { p_line_id: id, p_reason: candReason || 'Not on any delivery schedule' })
        : await supabase.rpc('request_so_balance_cancel', { p_line_id: id, p_reason: candReason || 'Not on any delivery schedule' })
      if (error) { if (!firstErr) firstErr = error.message } else ok++
    }
    setBusy(false); setSelCand(new Set()); setCandReason('')
    if (firstErr && ok === 0) { setMsg(/so_lines_unscheduled|cancel_so_balance_now/.test(firstErr) && /does not exist|schema cache|could not find/i.test(firstErr) ? 'This needs a database update — run db/2026-07-so-unscheduled-cancel.sql in the Supabase SQL editor.' : firstErr); return }
    setMsg(isHO ? `Cancelled ${ok} line(s) — saved as Cancel Notes below.` : `Requested cancel for ${ok} line(s) — waiting for Head Office approval.`)
    load()
  }
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (error) return <div className="flex min-h-screen items-center justify-center text-red-500">{error}</div>
  if (!profile) return null

  const n = q.trim().toLowerCase()
  const shown = notes.filter(x =>
    (!statusF || x.status === statusF) &&
    (!n || `${x.cancel_note_no} ${x.so_number} ${x.customer_name} ${x.item_code} ${x.description} ${x.reason}`.toLowerCase().includes(n)))

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Cancel Notes</h1>
        <p className="text-gray-500 text-sm mb-4">Cancelled order balances — the leftover (undelivered) quantity that was cancelled off an order. Pending ones are approved in <span className="font-medium">Pending Changes</span>.</p>

        {msg && <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">{msg}</div>}

        {/* Candidates: outstanding orders not on any delivery schedule — tick to cancel/proceed. */}
        <div className="bg-white rounded-xl border shadow-sm mb-6">
          <div className="px-4 py-3 border-b flex flex-wrap items-center gap-3">
            <div>
              <h2 className="font-semibold">Not on any delivery schedule</h2>
              <p className="text-xs text-gray-500">Outstanding orders that were never placed on a delivery line. Tick the ones to cancel, add a reason, then proceed.</p>
            </div>
            {selCand.size > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <input value={candReason} onChange={e => setCandReason(e.target.value)} placeholder="Reason (optional)" className="border rounded-lg px-3 py-1.5 text-sm w-56" />
                <button onClick={proceedCancel} disabled={busy} className="bg-orange-600 text-white px-4 py-1.5 rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm font-medium">
                  {busy ? 'Working…' : isHO ? `Cancel ${selSoCount} order(s)` : `Request cancel (${selSoCount})`}
                </button>
              </div>
            )}
          </div>
          <div className="px-4 py-2 border-b"><input value={candQ} onChange={e => setCandQ(e.target.value)} placeholder="Search SO / customer / item / factory / date…" className="border rounded-lg px-3 py-2 text-sm w-full" /></div>
          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b sticky top-0"><tr>
                <th className="px-3 py-2"><input type="checkbox" checked={cands.length > 0 && selCand.size === cands.length} onChange={e => setSelCand(e.target.checked ? new Set(cands.map(c => c.line_id)) : new Set())} className="h-4 w-4" /></th>
                {['SO', 'Customer', 'Items', 'Delivery', 'Factory', 'Balance'].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody>
                {groups.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-gray-400">{candQ ? 'No match.' : 'Nothing outstanding is off the schedule. 🎉'}</td></tr>}
                {groups.map(g => (
                  <tr key={g.so} className={`border-b last:border-0 ${groupChecked(g.ids) ? 'bg-orange-50' : 'hover:bg-gray-50'}`}>
                    <td className="px-3 py-2 align-top"><input type="checkbox" checked={groupChecked(g.ids)} onChange={() => toggleGroup(g.ids)} className="h-4 w-4" /></td>
                    <td className="px-3 py-2 font-mono whitespace-nowrap align-top">{g.so}</td>
                    <td className="px-3 py-2 min-w-[140px] align-top">{g.customer || '—'}</td>
                    <td className="px-3 py-2 align-top min-w-[220px]">
                      {g.items.slice(0, 4).map((it, i) => <div key={i} className="text-xs"><span className="font-mono text-gray-700">{it.code}</span>{it.name ? <span className="text-gray-500"> — {it.name}</span> : null}</div>)}
                      {g.items.length > 4 && <div className="text-[11px] text-gray-400">+{g.items.length - 4} more</div>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600 align-top">{g.deliveryDate ? g.deliveryDate.split('-').reverse().join('/') : '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600 align-top">{g.factories || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-orange-600 align-top">{Number(g.balance.toFixed(3))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {groups.length > 0 && <p className="px-4 py-2 text-xs text-gray-400">{groups.length} order(s) · {cands.length} line(s) not scheduled{isHO ? '' : ' · your cancel goes to Head Office for approval'}.</p>}
        </div>

        <h2 className="font-semibold mb-2">Cancel Note history</h2>

        <div className="flex flex-wrap gap-2 mb-4 text-sm">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SO / customer / item / reason…" className="border rounded-lg px-3 py-2 flex-1 min-w-[220px]" />
          <select value={statusF} onChange={e => setStatusF(e.target.value)} className="border rounded-lg px-3 py-2">
            <option value="">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['No.', 'SO', 'Customer', 'Item', 'Ordered', 'Delivered', 'Cancelled', 'Reason', 'Status', 'Requested', 'Reviewed'].map(h =>
                <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={11} className="text-center py-10 text-gray-400">No cancel notes.</td></tr>}
              {shown.map(x => (
                <tr key={x.id} className="border-b last:border-0 hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-mono whitespace-nowrap font-semibold text-gray-700">{x.cancel_note_no || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{x.so_number || '—'}</td>
                  <td className="px-3 py-2 min-w-[140px]">{x.customer_name || '—'}</td>
                  <td className="px-3 py-2"><span className="font-medium">{x.item_code}</span>{x.description ? <span className="block text-xs text-gray-500">{x.description}</span> : null}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.ordered_qty ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.delivered_qty ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-orange-600">{x.cancel_qty ?? '—'}</td>
                  <td className="px-3 py-2 min-w-[140px] text-gray-600">{x.reason || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[x.status] || 'bg-gray-100 text-gray-600'}`}>{x.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{x.requested_by_name || '—'}<span className="block text-gray-400">{fmt(x.created_at)}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{x.reviewed_by_name || '—'}{x.reviewed_at ? <span className="block text-gray-400">{fmt(x.reviewed_at)}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">{shown.length} note(s).</p>
      </div>
    </div>
  )
}
