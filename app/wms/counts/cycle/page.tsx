'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

// Cycle-count program: assign each item an ABC count class, see when it was last counted and
// whether it's due, then start a count for exactly the items that are due.
interface Stock { item_code: string; description: string | null; quantity: number }
interface Setting { item_code: string; count_class: string | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
// How often each class should be counted (days).
const INTERVAL: Record<string, number> = { A: 30, B: 90, C: 180 }
const CLASSES = ['A', 'B', 'C'] as const
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const daysSince = (iso: string | null) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null

export default function CycleCountPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [onhand, setOnhand] = useState<Map<string, { qty: number; desc: string }>>(new Map())
  const [cls, setCls] = useState<Map<string, string>>(new Map())
  const [last, setLast] = useState<Map<string, string>>(new Map())
  const [filter, setFilter] = useState<'due' | 'all' | 'A' | 'B' | 'C'>('due')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const [st, se, { data: lc }] = await Promise.all([
      fetchAll<Stock>('wms_stock', 'item_code, description, quantity'),
      fetchAll<Setting>('wms_item_settings', 'item_code, count_class'),
      supabase.rpc('wms_item_last_counted'),
    ])
    const oh = new Map<string, { qty: number; desc: string }>()
    for (const s of st) { if (s.quantity <= 0) continue; const e = oh.get(s.item_code) || { qty: 0, desc: s.description || '' }; e.qty = clean(e.qty + Number(s.quantity)); if (!e.desc && s.description) e.desc = s.description; oh.set(s.item_code, e) }
    setOnhand(oh)
    setCls(new Map(se.filter(x => x.count_class).map(x => [x.item_code, x.count_class as string])))
    setLast(new Map(((lc as { item_code: string; last_counted: string }[]) || []).map(x => [x.item_code, x.last_counted])))
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  async function setClass(code: string, c: string) {
    if (!canEdit) return
    setCls(m => { const n = new Map(m); c ? n.set(code, c) : n.delete(code); return n })
    await supabase.from('wms_item_settings').upsert({ item_code: code, count_class: c || null, updated_at: new Date().toISOString() }, { onConflict: 'item_code' })
  }

  // A row per stocked item, with class / last-counted / due.
  const rows = useMemo(() => {
    const out: { code: string; desc: string; qty: number; cls: string; last: string | null; days: number | null; due: boolean }[] = []
    for (const [code, e] of onhand.entries()) {
      const c = cls.get(code) || ''
      const l = last.get(code) || null
      const d = daysSince(l)
      const due = !!c && (l === null || (d !== null && d >= (INTERVAL[c] ?? 90)))
      out.push({ code, desc: e.desc, qty: e.qty, cls: c, last: l, days: d, due })
    }
    return out.sort((a, b) => (a.due === b.due ? 0 : a.due ? -1 : 1) || a.code.localeCompare(b.code))
  }, [onhand, cls, last])

  const rq = q.trim().toLowerCase()
  const shown = useMemo(() => rows.filter(r => {
    if (rq && !`${r.code} ${r.desc}`.toLowerCase().includes(rq)) return false
    if (filter === 'due') return r.due
    if (filter === 'all') return true
    return r.cls === filter
  }), [rows, rq, filter])
  const dueCodes = useMemo(() => rows.filter(r => r.due).map(r => r.code), [rows])

  async function startCycleCount() {
    if (!canEdit || dueCodes.length === 0) return
    setBusy(true); setErr(''); setMsg('')
    const name = `Cycle count · ${new Date().toLocaleDateString('en-GB')} · ${dueCodes.length} item(s)`
    const { data, error } = await supabase.rpc('wms_start_count', { p_name: name, p_scope_type: 'items', p_scope: dueCodes, p_blind: false })
    setBusy(false)
    if (error) { setErr(/wms_start_count|wms_item_last_counted|count_class/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-cycle-count.sql in the Supabase SQL editor.' : error.message); return }
    if (data) router.push(`/wms/counts/${data}`)
    else { setMsg('Cycle count started.'); load() }
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  const dueCount = dueCodes.length

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">🔁 Cycle count</h1>
          <Link href="/wms/counts" className="text-sm text-emerald-700 hover:underline">← Stock Counts</Link>
        </div>
        <p className="text-gray-500 text-sm mb-4">Give each item a count class — <b>A</b> (count monthly), <b>B</b> (quarterly), <b>C</b> (twice a year) — and count what&apos;s due, so coverage is systematic. Items with no class aren&apos;t on the program.</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        <div className="flex flex-wrap items-center gap-2 mb-4">
          {(['due', 'all', 'A', 'B', 'C'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${filter === f ? 'bg-emerald-700 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'}`}>{f === 'due' ? `Due (${dueCount})` : f === 'all' ? 'All' : `Class ${f}`}</button>
          ))}
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 item…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[160px]" />
          {canEdit && <button onClick={startCycleCount} disabled={busy || dueCount === 0} className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium whitespace-nowrap">{busy ? 'Starting…' : `▶ Start count (${dueCount} due)`}</button>}
        </div>

        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['Item', 'On-hand', 'Class', 'Last counted', 'Days ago', 'Status'].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={6} className="text-center py-10 text-gray-400">{filter === 'due' ? 'Nothing due 🎉' : 'No items.'}</td></tr>}
              {shown.map(r => (
                <tr key={r.code} className={`border-b last:border-0 ${r.due ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-3 py-2"><span className="font-mono font-medium">{r.code}</span>{r.desc ? <span className="text-gray-400 text-xs"> — {r.desc}</span> : ''}</td>
                  <td className="px-3 py-2 tabular-nums text-gray-600">{fmtQty(r.qty)}</td>
                  <td className="px-3 py-2">
                    <select value={r.cls} disabled={!canEdit} onChange={e => setClass(r.code, e.target.value)} className="border rounded px-2 py-1 text-xs disabled:bg-gray-50">
                      <option value="">—</option>
                      {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(r.last)}</td>
                  <td className="px-3 py-2 tabular-nums text-gray-500">{r.days ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {!r.cls ? <span className="text-gray-300 text-xs">not scheduled</span>
                      : r.due ? <span className="text-amber-700 font-medium text-xs">{r.last ? 'Due' : 'Never counted'}</span>
                      : <span className="text-emerald-600 text-xs">ok</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">{shown.length} item(s) · classes: A = every {INTERVAL.A}d · B = every {INTERVAL.B}d · C = every {INTERVAL.C}d.</p>
      </div>
    </div>
  )
}
