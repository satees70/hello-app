'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Msg { id: string; author_id: string | null; author_name: string | null; body: string; created_at: string; so_number: string | null; topic: string | null; mention_ids: string[] | null; mention_factories: string[] | null; reply_to: string | null }

const GENERAL = '__general__'
// Thread key: an order (s:SO#), a ticket/topic (t:Name), or the General thread.
const keyOf = (m: Msg) => m.so_number ? 's:' + m.so_number : m.topic ? 't:' + m.topic : GENERAL
const labelOf = (key: string) => {
  if (key === GENERAL) return 'General'
  const v = key.slice(2)
  return key.startsWith('s:') ? (/^so/i.test(v) ? v : `SO ${v}`) : `🎫 ${v}`   // don't double-print "SO"
}
const rawId = (key: string) => (key.startsWith('s:') || key.startsWith('t:')) ? key.slice(2) : ''   // for done-tracking

// Discussion, WhatsApp-style: thread list on the left, the open chat on the right.
// Threads are per-order (SO), free-form tickets/topics, or the General thread.
// Any thread can be marked "completed" to archive it.
export default function DiscussionPanel({ channel = 'warehouse', me, meName, title = 'Discussion', soOptions = [], soCustomers = {}, filterSo: filterSoProp, onFilterChange, panelId, onPosted, restrictToUserIds }: {
  channel?: string; me: string; meName?: string | null; title?: string; soOptions?: string[]
  soCustomers?: Record<string, string>   // SO# -> customer name, shown on order threads
  filterSo?: string; onFilterChange?: (so: string) => void; panelId?: string; onPosted?: () => void
  // When set (e.g. a private group), only these users can be tagged and location-tagging is hidden.
  restrictToUserIds?: string[] | null
}) {
  const restricted = Array.isArray(restrictToUserIds)
  const custOf = (key: string) => key.startsWith('s:') ? (soCustomers[key.slice(2)] || '') : ''
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [mentions, setMentions] = useState<string[]>([])
  const [facMentions, setFacMentions] = useState<string[]>([])
  const [thread, setThread] = useState<string | undefined>(undefined)   // undefined=none open, else a thread key (GENERAL / s:.. / t:..)
  const [seen, setSeen] = useState<Record<string, string>>({})
  const [completed, setCompleted] = useState<Set<string>>(new Set())
  const [showCompleted, setShowCompleted] = useState(false)
  const [newSo, setNewSo] = useState('')
  const [newTicket, setNewTicket] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const seenKey = `disc_seen_${channel}`

  async function load() {
    const { data } = await supabase.from('discussions').select('*').eq('channel', channel).order('created_at', { ascending: true }).limit(1000)
    setMsgs((data as Msg[]) || [])
  }
  async function loadCompleted() {
    const { data, error } = await supabase.from('discussion_threads').select('so_number').eq('channel', channel)
    if (!error) setCompleted(new Set((data || []).map(r => r.so_number)))
  }
  useEffect(() => { try { setSeen(JSON.parse(localStorage.getItem(seenKey) || '{}')) } catch { /* ignore */ } }, [seenKey])
  useEffect(() => { load(); loadCompleted(); const id = setInterval(load, 20000); return () => clearInterval(id) }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    supabase.rpc('list_users').then(({ data }) => setUsers((data as { id: string; full_name: string }[]) || []))
    supabase.from('factories').select('code, name').order('code').then(({ data }) => setFactories((data as { code: string; name: string }[]) || []))
  }, [])
  useEffect(() => { if (filterSoProp) openThread('s:' + filterSoProp) }, [filterSoProp]) // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (id: string) => users.find(u => u.id === id)?.full_name || 'someone'
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  const soList = [...new Set([...soOptions, ...msgs.map(m => m.so_number || '').filter(Boolean)])].sort()

  const allThreads = useMemo(() => {
    const m = new Map<string, { key: string; last: Msg; count: number; unread: number }>()
    msgs.forEach(msg => {
      const k = keyOf(msg)
      const e = m.get(k) || { key: k, last: msg, count: 0, unread: 0 }
      e.count++
      if (new Date(msg.created_at) >= new Date(e.last.created_at)) e.last = msg
      m.set(k, e)
    })
    m.forEach(e => {
      const ls = seen[e.key]
      e.unread = msgs.filter(x => keyOf(x) === e.key && x.author_id !== me && (!ls || new Date(x.created_at) > new Date(ls))).length
    })
    return [...m.values()].sort((a, b) => new Date(b.last.created_at).getTime() - new Date(a.last.created_at).getTime())
  }, [msgs, seen, me])
  const isDone = (key: string) => { const r = rawId(key); return !!r && completed.has(r) }
  const threads = allThreads.filter(t => showCompleted ? true : !isDone(t.key))
  const doneCount = allThreads.filter(t => isDone(t.key)).length
  const totalUnread = threads.reduce((s, t) => s + t.unread, 0)

  function markSeen(key: string) {
    const latest = msgs.filter(x => keyOf(x) === key).reduce((mx, x) => x.created_at > mx ? x.created_at : mx, new Date().toISOString())
    setSeen(prev => { const next = { ...prev, [key]: latest }; try { localStorage.setItem(seenKey, JSON.stringify(next)) } catch { /* ignore */ } return next })
  }
  function openThread(key: string) {
    setThread(key); setErr(''); setBody(''); setMentions([]); setFacMentions([])
    markSeen(key)
    if (onFilterChange) onFilterChange(key.startsWith('s:') ? key.slice(2) : '')
  }
  async function toggleDone(key: string) {
    const r = rawId(key); if (!r) return
    if (completed.has(r)) {
      await supabase.from('discussion_threads').delete().eq('channel', channel).eq('so_number', r)
      setCompleted(p => { const n = new Set(p); n.delete(r); return n })
    } else {
      const { error } = await supabase.from('discussion_threads').insert({ channel, so_number: r, completed_by: me, completed_by_name: meName || null })
      if (error) { setErr(/discussion_threads/.test(error.message) ? 'Marking done needs a database update — run the latest catch-up SQL.' : error.message); return }
      setCompleted(p => new Set(p).add(r))
    }
  }

  const inThread = thread !== undefined
  const shown = useMemo(() => thread ? msgs.filter(m => keyOf(m) === thread) : [], [msgs, thread])
  useEffect(() => { if (inThread) endRef.current?.scrollIntoView({ block: 'nearest' }) }, [shown.length, inThread])
  useEffect(() => { if (inThread && shown.length && thread) markSeen(thread) }, [shown.length]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    const text = body.trim(); if (!text || !thread) return
    setSending(true); setErr('')
    const so = thread.startsWith('s:') ? thread.slice(2) : null
    const topic = thread.startsWith('t:') ? thread.slice(2) : null
    let { error } = await supabase.from('discussions').insert({ channel, author_id: me, author_name: meName || null, body: text, so_number: so, topic, mention_ids: mentions, mention_factories: facMentions })
    if (error && /column|schema cache|mention_|so_number|topic/i.test(error.message)) {
      const res = await supabase.from('discussions').insert({ channel, author_id: me, author_name: meName || null, body: text }); error = res.error
    }
    setSending(false)
    if (error) { setErr(error.message); return }
    setBody(''); setMentions([]); setFacMentions([]); await load(); markSeen(thread); onPosted?.()
  }

  return (
    <div id={panelId} className="bg-white rounded-xl shadow-sm border mb-8 overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <span className="font-semibold">💬 {title}</span>
        <span className="font-normal text-gray-400 text-sm">· {threads.length} thread{threads.length === 1 ? '' : 's'}</span>
        {totalUnread > 0 && <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5">{totalUnread} unread</span>}
      </div>
      <div className="flex flex-col md:flex-row md:h-[32rem]">
        {/* LEFT — thread list */}
        <div className="md:w-72 md:shrink-0 border-b md:border-b-0 md:border-r flex flex-col">
          <div className="p-2 border-b space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <input list="disc-so-list" value={newSo} onChange={e => setNewSo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newSo.trim()) { openThread('s:' + newSo.trim().toUpperCase()); setNewSo('') } }} placeholder="Open order (SO#)…" className="flex-1 min-w-0 border rounded-lg px-2 py-1.5 text-sm" />
              <datalist id="disc-so-list">{soList.map(so => <option key={so} value={so} />)}</datalist>
              <button onClick={() => { if (newSo.trim()) { openThread('s:' + newSo.trim().toUpperCase()); setNewSo('') } }} disabled={!newSo.trim()} className="bg-blue-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm">Open</button>
              <button onClick={() => openThread(GENERAL)} className={`px-2.5 py-1.5 rounded-lg text-sm border ${thread === GENERAL ? 'bg-blue-50 border-blue-300' : 'hover:bg-gray-50'}`}>General</button>
            </div>
            <div className="flex items-center gap-1.5">
              <input value={newTicket} onChange={e => setNewTicket(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newTicket.trim()) { openThread('t:' + newTicket.trim()); setNewTicket('') } }} placeholder="Raise a ticket / topic…" className="flex-1 min-w-0 border rounded-lg px-2 py-1.5 text-sm" />
              <button onClick={() => { if (newTicket.trim()) { openThread('t:' + newTicket.trim()); setNewTicket('') } }} disabled={!newTicket.trim()} className="bg-amber-600 text-white px-2.5 py-1.5 rounded-lg hover:bg-amber-700 disabled:opacity-50 text-sm">🎫 Raise</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto divide-y">
            {threads.length === 0 && <p className="text-gray-400 text-sm text-center py-8 px-3">No conversations yet — open an order or raise a ticket above.</p>}
            {threads.map(t => {
              const active = thread === t.key
              return (
                <button key={t.key} onClick={() => openThread(t.key)} className={`w-full text-left px-3 py-2.5 flex items-start gap-2 ${active ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="font-semibold text-gray-800 text-sm break-words">{labelOf(t.key)}</span>
                      {custOf(t.key) && <span className="text-gray-500 text-xs break-words">· {custOf(t.key)}</span>}
                      {isDone(t.key) && <span className="text-green-600 text-[10px] font-semibold">✓ done</span>}
                      {t.unread > 0 && <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0">{t.unread}</span>}
                    </div>
                    <div className={`text-xs break-words ${t.unread > 0 ? 'text-gray-800 font-medium' : 'text-gray-500'}`}><span className="text-gray-400">{t.last.author_name || 'Someone'}:</span> {t.last.body}</div>
                    <div className="text-[10px] text-gray-400">{fmt(t.last.created_at)}</div>
                  </div>
                </button>
              )
            })}
          </div>
          {doneCount > 0 && <button onClick={() => setShowCompleted(s => !s)} className="text-xs text-gray-500 hover:bg-gray-50 border-t px-3 py-2 text-left">{showCompleted ? 'Hide' : 'Show'} completed ({doneCount})</button>}
        </div>

        {/* RIGHT — the open chat */}
        <div className="flex-1 flex flex-col min-w-0">
          {!inThread ? (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm p-8">Pick a conversation on the left, or raise a ticket.</div>
          ) : (<>
            <div className="px-4 py-2.5 border-b flex items-center gap-2">
              {thread!.startsWith('s:')
                ? <a href={`/sales-orders?so=${encodeURIComponent(thread!.slice(2))}`} className="font-semibold text-blue-600 hover:underline" title="Open this order in Sales Orders">{labelOf(thread!)} ↗</a>
                : <span className="font-semibold">{labelOf(thread!)}</span>}
              {custOf(thread!) && <span className="text-gray-500 text-sm">· {custOf(thread!)}</span>}
              <span className="text-gray-400 text-sm">· {shown.length} msg</span>
              {rawId(thread!) && (
                <button onClick={() => toggleDone(thread!)} className={`ml-auto text-xs px-3 py-1 rounded-lg font-medium border ${isDone(thread!) ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-300 text-gray-600 hover:bg-green-50'}`}>{isDone(thread!) ? '✓ Completed · Reopen' : '✓ Mark completed'}</button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 p-3 bg-gray-50">
              {shown.length === 0 && <p className="text-gray-400 text-sm text-center py-6">No messages yet — {thread!.startsWith('t:') ? 'describe the ticket' : 'say something'}.</p>}
              {shown.map(m => {
                const mine = m.author_id === me
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${mine ? 'bg-blue-600 text-white' : 'bg-white border'}`}>
                      {!mine && <div className="text-xs font-medium text-gray-500">{m.author_name || 'Someone'}</div>}
                      {((m.mention_ids && m.mention_ids.length > 0) || (m.mention_factories && m.mention_factories.length > 0)) && <div className="mb-0.5 flex flex-wrap gap-1">
                        {(m.mention_ids || []).map(id => <span key={id} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${mine ? 'bg-blue-500 text-white' : 'bg-amber-100 text-amber-800'}`}>@{nameOf(id)}</span>)}
                        {(m.mention_factories || []).map(fc => <span key={fc} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${mine ? 'bg-blue-500 text-white' : 'bg-teal-100 text-teal-800'}`}>@{fc} (all)</span>)}
                      </div>}
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                      <div className={`text-[10px] mt-0.5 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>{fmt(m.created_at)}</div>
                    </div>
                  </div>
                )
              })}
              <div ref={endRef} />
            </div>
            {(mentions.length > 0 || facMentions.length > 0) && (
              <div className="flex flex-wrap items-center gap-1 px-3 pt-2 text-xs">
                <span className="text-gray-500">Tagging:</span>
                {mentions.map(id => <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">@{nameOf(id)}<button onClick={() => setMentions(m => m.filter(x => x !== id))} className="text-amber-600">✕</button></span>)}
                {facMentions.map(fc => <span key={fc} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-teal-100 text-teal-800 font-medium">@{fc} (all)<button onClick={() => setFacMentions(f => f.filter(x => x !== fc))} className="text-teal-600">✕</button></span>)}
              </div>
            )}
            <div className="flex flex-wrap gap-2 p-3 border-t">
              {(users.length > 0 || factories.length > 0) && (
                <select value="" onChange={e => { const v = e.target.value; if (!v) return; if (v.startsWith('fac:')) { const c = v.slice(4); setFacMentions(f => f.includes(c) ? f : [...f, c]) } else { setMentions(m => m.includes(v) ? m : [...m, v]) } }} className="w-32 border rounded-lg px-2 py-2 text-sm bg-white" title={restricted ? 'Tag a group member' : 'Tag a person or location'}>
                  <option value="">＠ Tag…</option>
                  {!restricted && factories.length > 0 && <optgroup label="Locations (all users)">
                    {factories.filter(f => f.code !== 'HEAD_OFFICE' && !facMentions.includes(f.code)).map(f => <option key={f.code} value={`fac:${f.code}`}>{f.code}{f.name && f.name !== f.code ? ` — ${f.name}` : ''}</option>)}
                  </optgroup>}
                  {users.length > 0 && <optgroup label={restricted ? 'Group members' : 'People'}>
                    {users.filter(u => u.id !== me && !mentions.includes(u.id) && (!restricted || restrictToUserIds!.includes(u.id))).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </optgroup>}
                </select>
              )}
              <input value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder={thread === GENERAL ? 'Type a message…' : `Message · ${labelOf(thread!)}…`} className="flex-1 min-w-[10rem] border rounded-lg px-3 py-2 text-sm" />
              <button onClick={send} disabled={sending || !body.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{sending ? 'Sending…' : 'Send'}</button>
            </div>
            {err && <p className="text-red-500 text-xs px-3 pb-2">Couldn’t send: {err}</p>}
          </>)}
        </div>
      </div>
    </div>
  )
}
