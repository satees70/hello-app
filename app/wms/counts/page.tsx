'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import { openWmsDiscussion } from '@/components/WmsDiscussionWidget'

interface Task {
  id: string; count_no: string | null; name: string | null; scope_type: string; scope: string[] | null
  blind: boolean; status: string; created_by_name: string | null; created_at: string
  completed_at: string | null; applied_at: string | null; applied_by_name: string | null
  wms_count_lines?: { count: number }[]
}
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
// Human duration between two timestamps (e.g. "1h 20m", "45m", "3d").
function durText(a: string | null, b: string | null): string {
  if (!a || !b) return '—'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!(ms > 0)) return '—'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60), rm = mins % 60
  if (hrs < 24) return rm ? `${hrs}h ${rm}m` : `${hrs}h`
  const days = Math.floor(hrs / 24), rh = hrs % 24
  return rh ? `${days}d ${rh}h` : `${days}d`
}
const STATUS_CHIP: Record<string, string> = { Counting: 'bg-emerald-100 text-emerald-700', Review: 'bg-amber-100 text-amber-700', Applied: 'bg-emerald-100 text-emerald-700', Cancelled: 'bg-gray-100 text-gray-400' }
const SCOPE_LABEL: Record<string, string> = { full: 'Full count', bins: 'Bins', zones: 'Zones', items: 'Items' }

export default function WmsCountsPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const router = useRouter()

  const [tasks, setTasks] = useState<Task[]>([])
  const [discByTask, setDiscByTask] = useState<Record<string, number>>({})
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState(''); const [scopeType, setScopeType] = useState('full'); const [scopeText, setScopeText] = useState(''); const [blind, setBlind] = useState(false)
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  // "Specific items" scope: search the item master by name/code and pick — staff can't remember codes.
  const [pickedItems, setPickedItems] = useState<{ code: string; description: string | null }[]>([])
  const [itemQuery, setItemQuery] = useState(''); const [itemResults, setItemResults] = useState<{ code: string; description: string | null }[]>([]); const [searching, setSearching] = useState(false)

  useEffect(() => { if (profile) load() }, [profile])

  // Live item search (by description OR code) for the "Specific items" picker.
  useEffect(() => {
    if (scopeType !== 'items') return
    const q = itemQuery.trim()
    if (q.length < 2) { setItemResults([]); setSearching(false); return }
    let active = true; setSearching(true)
    const t = setTimeout(async () => {
      const safe = q.replace(/[(),]/g, ' ')   // keep PostgREST or() syntax intact
      const { data } = await supabase.from('items').select('code, description')
        .or(`code.ilike.%${safe}%,description.ilike.%${safe}%`).order('code').limit(20)
      if (!active) return
      const already = new Set(pickedItems.map(p => p.code))
      setItemResults(((data as { code: string; description: string | null }[]) || []).filter(r => !already.has(r.code)))
      setSearching(false)
    }, 250)
    return () => { active = false; clearTimeout(t) }
  }, [itemQuery, scopeType, pickedItems])

  function addItem(it: { code: string; description: string | null }) {
    setPickedItems(p => p.some(x => x.code === it.code) ? p : [...p, it]); setItemQuery(''); setItemResults([])
  }
  function removeItem(code: string) { setPickedItems(p => p.filter(x => x.code !== code)) }
  async function load() {
    const { data } = await supabase.from('wms_count_tasks').select('*, wms_count_lines(count)').order('created_at', { ascending: false }).limit(50)
    const ts = (data as Task[]) || []
    setTasks(ts)
    // Count discrepancies (counted ≠ system, or unexpected item) across the loaded counts.
    const ids = ts.map(t => t.id)
    if (ids.length) {
      const { data: cl } = await supabase.from('wms_count_lines')
        .select('task_id, expected_qty, counted_qty, is_unexpected, skip').in('task_id', ids).not('counted_qty', 'is', null)
      const m: Record<string, number> = {}
      ;(cl as { task_id: string; expected_qty: number; counted_qty: number; is_unexpected: boolean; skip: boolean }[] || []).forEach(l => {
        if (l.skip) return
        const isDisc = l.is_unexpected || Number(l.counted_qty) !== Number(l.expected_qty)
        if (isDisc) m[l.task_id] = (m[l.task_id] || 0) + 1
      })
      setDiscByTask(m)
    } else setDiscByTask({})
  }

  // Dashboard stats from the loaded counts.
  const stats = useMemo(() => {
    const counting = tasks.filter(t => t.status === 'Counting').length
    const review = tasks.filter(t => t.status === 'Review').length
    const applied = tasks.filter(t => t.status === 'Applied').length
    const totalDisc = Object.values(discByTask).reduce((a, b) => a + b, 0)
    // Average counting duration (start → counting finished) over counts that have finished.
    const durs = tasks.map(t => t.completed_at ? new Date(t.completed_at).getTime() - new Date(t.created_at).getTime() : null).filter((n): n is number => n != null && n > 0)
    const avgMs = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0
    const avgMins = Math.round(avgMs / 60000)
    const avgDur = !avgMins ? '—' : avgMins < 60 ? `${avgMins}m` : `${Math.floor(avgMins / 60)}h ${avgMins % 60}m`
    return { total: tasks.length, counting, review, applied, totalDisc, avgDur }
  }, [tasks, discByTask])

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    const scope = scopeType === 'full' ? []
      : scopeType === 'items' ? pickedItems.map(p => p.code)
      : scopeText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    if (scopeType !== 'full' && scope.length === 0) { setErr(scopeType === 'items' ? 'Search and pick at least one item.' : 'Enter at least one ' + (scopeType === 'zones' ? 'aisle' : 'bin') + '.'); return }
    const norm = scopeType === 'items' ? scope : scope.map(s => s.toUpperCase())
    setBusy(true); setErr('')
    const { data, error } = await supabase.rpc('wms_start_count', { p_name: name.trim(), p_scope_type: scopeType, p_scope: norm, p_blind: blind })
    setBusy(false)
    if (error) { setErr(error.message); return }
    router.push(`/wms/counts/${data as string}`)
  }

  // Cancel a count that's still Counting or in Review (trial run / duplicate / abandoned).
  async function cancelCount(t: Task) {
    if (!canEdit) return
    if (!confirm(`Cancel ${t.count_no || 'this count'}? It won't change any stock. This can't be undone.`)) return
    const { error } = await supabase.rpc('wms_cancel_count', { p_task_id: t.id })
    if (error) { setErr(/wms_cancel_count/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-cancel-count.sql in the Supabase SQL editor.' : error.message); return }
    load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div><h1 className="text-2xl font-bold">Stock Counts</h1><p className="text-gray-500 text-sm mt-1">Count a section (or the whole warehouse) and correct the stock — with your approval. <Link href="/wms/counts/cycle" className="text-emerald-700 underline">🔁 Cycle count</Link> for a scheduled ABC program.</p></div>
          {canEdit && <button onClick={() => { setShowForm(v => !v); setErr('') }} className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 text-sm font-medium">{showForm ? 'Close' : '+ New count'}</button>}
        </div>

        {err && !showForm && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-2 rounded mb-4">{err}</p>}

        {tasks.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            {[
              { label: 'Counts', value: stats.total, tone: 'text-gray-900' },
              { label: 'Counting now', value: stats.counting, tone: 'text-emerald-700' },
              { label: 'Awaiting apply', value: stats.review, tone: 'text-amber-700' },
              { label: 'Applied', value: stats.applied, tone: 'text-emerald-700' },
              { label: 'Discrepancies', value: stats.totalDisc, tone: 'text-red-600' },
              { label: 'Avg. duration', value: stats.avgDur, tone: 'text-gray-900' },
            ].map(s => (
              <div key={s.label} className="bg-white rounded-xl border shadow-sm px-4 py-3">
                <div className={`text-2xl font-bold tabular-nums ${s.tone}`}>{s.value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {showForm && (
          <form onSubmit={create} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">New count</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1">Name <span className="text-gray-400 font-normal">(optional)</span></label><input value={name} onChange={e => setName(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="e.g. Aisle A weekly" /></div>
              <div><label className="block text-sm font-medium mb-1">What to count</label>
                <select value={scopeType} onChange={e => { setScopeType(e.target.value); setScopeText(''); setPickedItems([]); setItemQuery(''); setItemResults([]) }} className="w-full border rounded-lg px-3 py-2">
                  <option value="full">Whole warehouse</option>
                  <option value="bins">Specific bins</option>
                  <option value="zones">Specific zones (aisles)</option>
                  <option value="items">Specific items</option>
                </select>
              </div>
            </div>
            {scopeType === 'items' && (
              <div>
                <label className="block text-sm font-medium mb-1">Items to count <span className="text-gray-400 font-normal">(search by name or code — no need to remember codes)</span></label>
                <div className="relative">
                  <input value={itemQuery} onChange={e => setItemQuery(e.target.value)} autoComplete="off" className="w-full border rounded-lg px-3 py-2" placeholder="Type an item name, e.g. Mysore Dhall…" />
                  {itemQuery.trim().length >= 2 && (
                    <ul className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-64 overflow-auto text-sm">
                      {searching && itemResults.length === 0 && <li className="px-3 py-2 text-gray-400">Searching…</li>}
                      {itemResults.map(r => (
                        <li key={r.code}>
                          <button type="button" onClick={() => addItem(r)} className="w-full text-left px-3 py-2 hover:bg-emerald-50 flex items-center justify-between gap-3">
                            <span className="truncate">{r.description || <span className="text-gray-400">(no description)</span>}</span>
                            <span className="font-mono text-xs text-gray-400 whitespace-nowrap">{r.code}</span>
                          </button>
                        </li>
                      ))}
                      {!searching && itemResults.length === 0 && <li className="px-3 py-2 text-gray-400">No items match &ldquo;{itemQuery.trim()}&rdquo;</li>}
                    </ul>
                  )}
                </div>
                {pickedItems.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {pickedItems.map(it => (
                      <span key={it.code} className="inline-flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-full pl-3 pr-1.5 py-1 text-xs">
                        <span className="font-medium truncate max-w-[14rem]">{it.description || it.code}</span>
                        <span className="font-mono text-emerald-500">{it.code}</span>
                        <button type="button" onClick={() => removeItem(it.code)} className="w-4 h-4 rounded-full hover:bg-emerald-200 text-emerald-600 flex items-center justify-center text-sm leading-none" aria-label={`Remove ${it.code}`}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-1">{pickedItems.length ? `${pickedItems.length} item(s) selected` : 'Search and pick the items you want to count.'}</p>
              </div>
            )}
            {(scopeType === 'bins' || scopeType === 'zones') && (
              <div>
                <label className="block text-sm font-medium mb-1">{scopeType === 'zones' ? 'Aisles' : 'Bin codes'} <span className="text-gray-400 font-normal">(separate with spaces, commas or new lines)</span></label>
                <textarea value={scopeText} onChange={e => setScopeText(e.target.value)} rows={3} className="w-full border rounded-lg px-3 py-2 font-mono text-sm" placeholder={scopeType === 'zones' ? 'A  AA  ZG' : 'A105 A106 A107'} />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={blind} onChange={e => setBlind(e.target.checked)} /> <b>Blind count</b> — hide the system quantity while counting (avoids bias)</label>
            {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{err}</p>}
            <button type="submit" disabled={busy} className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">{busy ? 'Creating…' : 'Start count'}</button>
          </form>
        )}

        {/* Desktop: table */}
        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Count', 'What', 'Lines', 'Δ', 'Duration', 'Status', 'Started', 'By', ''].map(h => <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {tasks.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No counts yet.</td></tr>}
              {tasks.map(t => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono font-medium">{t.count_no}{t.name ? <span className="text-gray-400 font-normal"> · {t.name}</span> : ''}{t.blind ? <span className="ml-1 text-xs text-violet-600">blind</span> : ''}</td>
                  <td className="px-4 py-2.5 text-xs">{SCOPE_LABEL[t.scope_type]}{t.scope && t.scope.length ? <span className="text-gray-400"> ({t.scope.slice(0, 4).join(', ')}{t.scope.length > 4 ? '…' : ''})</span> : ''}</td>
                  <td className="px-4 py-2.5 tabular-nums">{t.wms_count_lines?.[0]?.count ?? 0}</td>
                  <td className="px-4 py-2.5 tabular-nums">{discByTask[t.id] ? <span className="text-red-600 font-medium">{discByTask[t.id]}</span> : <span className="text-gray-300">0</span>}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{durText(t.created_at, t.completed_at)}</td>
                  <td className="px-4 py-2.5"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CHIP[t.status] || 'bg-gray-100'}`}>{t.status}</span></td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(t.created_at)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{t.created_by_name}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <Link href={`/wms/counts/${t.id}`} className="text-emerald-700 font-medium hover:underline text-xs">{t.status === 'Applied' ? 'View' : 'Open →'}</Link>
                    <button onClick={() => openWmsDiscussion(`Count ${t.count_no || t.id.slice(0, 8)}`)} title="Ask a question about this count" className="ml-3 text-indigo-600 hover:underline text-xs">💬 Discuss</button>
                    {canEdit && (t.status === 'Counting' || t.status === 'Review') && <button onClick={() => cancelCount(t)} className="ml-3 text-red-500 hover:underline text-xs">Cancel</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per count */}
        <div className="sm:hidden space-y-2">
          {tasks.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">No counts yet.</div>}
          {tasks.map(t => (
            <div key={t.id} className="bg-white rounded-xl border shadow-sm p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-semibold text-sm">{t.count_no}{t.blind ? <span className="ml-1 text-xs text-violet-600 font-sans">blind</span> : ''}</div>
                  {t.name && <div className="text-xs text-gray-500 leading-snug">{t.name}</div>}
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${STATUS_CHIP[t.status] || 'bg-gray-100'}`}>{t.status}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
                <span>{SCOPE_LABEL[t.scope_type]}{t.scope && t.scope.length ? <span className="text-gray-400"> ({t.scope.slice(0, 4).join(', ')}{t.scope.length > 4 ? '…' : ''})</span> : ''}</span>
                <span>Lines: <span className="tabular-nums">{t.wms_count_lines?.[0]?.count ?? 0}</span></span>
                <span>Δ: {discByTask[t.id] ? <span className="text-red-600 font-medium tabular-nums">{discByTask[t.id]}</span> : <span className="text-gray-300 tabular-nums">0</span>}</span>
                <span>Duration: {durText(t.created_at, t.completed_at)}</span>
              </div>
              <div className="text-xs text-gray-400 mt-1">{fmtTime(t.created_at)}{t.created_by_name ? ' · ' + t.created_by_name : ''}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5 pt-2 border-t text-xs">
                <Link href={`/wms/counts/${t.id}`} className="text-emerald-700 font-medium hover:underline">{t.status === 'Applied' ? 'View' : 'Open →'}</Link>
                <button onClick={() => openWmsDiscussion(`Count ${t.count_no || t.id.slice(0, 8)}`)} title="Ask a question about this count" className="text-indigo-600 hover:underline">💬 Discuss</button>
                {canEdit && (t.status === 'Counting' || t.status === 'Review') && <button onClick={() => cancelCount(t)} className="text-red-500 hover:underline">Cancel</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
