'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Msg { id: string; author_id: string | null; author_name: string | null; body: string; created_at: string; so_number: string | null; mention_ids: string[] | null; mention_factories: string[] | null; reply_to: string | null }

const GENERAL = '__general__'
const keyOf = (m: Msg) => m.so_number || GENERAL

// Per-order discussion: a list of order threads (with unread counts) → open one to chat.
// Each order (SO) is its own conversation, so there's no confusing reply nesting.
export default function DiscussionPanel({ channel = 'warehouse', me, meName, title = 'Discussion', soOptions = [], filterSo: filterSoProp, onFilterChange, panelId, onPosted }: {
  channel?: string; me: string; meName?: string | null; title?: string; soOptions?: string[]
  filterSo?: string; onFilterChange?: (so: string) => void; panelId?: string; onPosted?: () => void
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [mentions, setMentions] = useState<string[]>([])
  const [facMentions, setFacMentions] = useState<string[]>([])
  const [thread, setThread] = useState<string | null | undefined>(undefined)   // undefined=list, null=General, string=SO
  const [seen, setSeen] = useState<Record<string, string>>({})
  const [newSo, setNewSo] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const seenKey = `disc_seen_${channel}`

  async function load() {
    const { data } = await supabase.from('discussions').select('*').eq('channel', channel).order('created_at', { ascending: true }).limit(1000)
    setMsgs((data as Msg[]) || [])
  }
  useEffect(() => { try { setSeen(JSON.parse(localStorage.getItem(seenKey) || '{}')) } catch { /* ignore */ } }, [seenKey])
  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id) }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    supabase.rpc('list_users').then(({ data }) => setUsers((data as { id: string; full_name: string }[]) || []))
    supabase.from('factories').select('code, name').order('code').then(({ data }) => setFactories((data as { code: string; name: string }[]) || []))
  }, [])
  // Deep link (e.g. /discussion?so=SO-40823) opens that order's thread directly.
  useEffect(() => { if (filterSoProp) openThread(filterSoProp) }, [filterSoProp]) // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (id: string) => users.find(u => u.id === id)?.full_name || 'someone'
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  const soList = [...new Set([...soOptions, ...msgs.map(m => m.so_number || '').filter(Boolean)])].sort()

  // One entry per order (plus General), newest activity first, with an unread count.
  const threads = useMemo(() => {
    const m = new Map<string, { key: string; so: string | null; last: Msg; count: number; unread: number }>()
    msgs.forEach(msg => {
      const k = keyOf(msg)
      const e = m.get(k) || { key: k, so: msg.so_number, last: msg, count: 0, unread: 0 }
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
  const totalUnread = threads.reduce((s, t) => s + t.unread, 0)

  function markSeen(k: string) {
    const latest = msgs.filter(x => keyOf(x) === k).reduce((mx, x) => x.created_at > mx ? x.created_at : mx, new Date().toISOString())
    setSeen(prev => { const next = { ...prev, [k]: latest }; try { localStorage.setItem(seenKey, JSON.stringify(next)) } catch { /* ignore */ } return next })
  }
  function openThread(so: string | null) {
    setThread(so); setErr(''); setBody(''); setMentions([]); setFacMentions([])
    markSeen(so || GENERAL)
    if (onFilterChange) onFilterChange(so || '')
  }
  function backToList() { setThread(undefined); if (onFilterChange) onFilterChange('') }

  const inThread = thread !== undefined
  const threadKey = thread || GENERAL
  const shown = useMemo(() => msgs.filter(m => keyOf(m) === threadKey), [msgs, threadKey])
  useEffect(() => { if (inThread) endRef.current?.scrollIntoView({ block: 'nearest' }) }, [shown.length, inThread])
  // keep the open thread marked read as new messages arrive
  useEffect(() => { if (inThread && shown.length) markSeen(threadKey) }, [shown.length]) // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    const text = body.trim(); if (!text) return
    setSending(true); setErr('')
    const so = typeof thread === 'string' ? thread : null
    let { error } = await supabase.from('discussions').insert({ channel, author_id: me, author_name: meName || null, body: text, so_number: so, mention_ids: mentions, mention_factories: facMentions })
    if (error && /column|schema cache|mention_|so_number/i.test(error.message)) {
      const res = await supabase.from('discussions').insert({ channel, author_id: me, author_name: meName || null, body: text }); error = res.error
    }
    setSending(false)
    if (error) { setErr(error.message); return }
    setBody(''); setMentions([]); setFacMentions([]); await load(); markSeen(so || GENERAL); onPosted?.()
  }

  return (
    <div id={panelId} className="bg-white rounded-xl shadow-sm border mb-8">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        {inThread && <button onClick={backToList} className="text-blue-600 hover:underline text-sm font-medium">← Orders</button>}
        <span className="font-semibold">💬 {inThread ? (thread ? `Order ${thread}` : 'General chat') : title}</span>
        <span className="font-normal text-gray-400 text-sm">· {inThread ? `${shown.length} message${shown.length === 1 ? '' : 's'}` : `${threads.length} thread${threads.length === 1 ? '' : 's'}`}</span>
        {!inThread && totalUnread > 0 && <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5">{totalUnread} unread</span>}
      </div>

      {/* THREAD LIST */}
      {!inThread && (
        <div className="p-3">
          <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
            <input list="disc-so-list" value={newSo} onChange={e => setNewSo(e.target.value)} placeholder="Open an order (SO#)…" className="w-48 border rounded-lg px-3 py-2 text-sm" />
            <datalist id="disc-so-list">{soList.map(so => <option key={so} value={so} />)}</datalist>
            <button onClick={() => { if (newSo.trim()) { openThread(newSo.trim().toUpperCase()); setNewSo('') } }} disabled={!newSo.trim()} className="bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">Open</button>
            <button onClick={() => openThread(null)} className="border px-3 py-2 rounded-lg hover:bg-gray-50 text-sm">General chat</button>
          </div>
          <div className="divide-y border rounded-lg overflow-hidden max-h-[30rem] overflow-y-auto">
            {threads.length === 0 && <p className="text-gray-400 text-sm text-center py-8">No conversations yet — open an order above to start.</p>}
            {threads.map(t => (
              <button key={t.key} onClick={() => openThread(t.so)} className="w-full text-left px-3 py-2.5 hover:bg-gray-50 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-800">{t.so ? `SO ${t.so}` : 'General'}</span>
                    <span className="text-gray-400 text-xs">· {t.count} msg</span>
                    {t.unread > 0 && <span className="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5">{t.unread} new</span>}
                  </div>
                  <div className={`text-sm truncate ${t.unread > 0 ? 'text-gray-800 font-medium' : 'text-gray-500'}`}><span className="text-gray-400">{t.last.author_name || 'Someone'}:</span> {t.last.body}</div>
                </div>
                <span className="text-gray-400 text-xs whitespace-nowrap">{fmt(t.last.created_at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ONE THREAD (chat) */}
      {inThread && (
        <div className="px-4 pb-4 pt-3">
          <div className="max-h-80 overflow-y-auto space-y-2 border rounded-lg p-3 bg-gray-50 mb-3">
            {shown.length === 0 && <p className="text-gray-400 text-sm text-center py-6">No messages yet — say something about this {thread ? 'order' : 'topic'}.</p>}
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
            <div className="flex flex-wrap items-center gap-1 mb-2 text-xs">
              <span className="text-gray-500">Tagging:</span>
              {mentions.map(id => <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">@{nameOf(id)}<button onClick={() => setMentions(m => m.filter(x => x !== id))} className="text-amber-600">✕</button></span>)}
              {facMentions.map(fc => <span key={fc} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-teal-100 text-teal-800 font-medium">@{fc} (all)<button onClick={() => setFacMentions(f => f.filter(x => x !== fc))} className="text-teal-600">✕</button></span>)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {(users.length > 0 || factories.length > 0) && (
              <select value="" onChange={e => { const v = e.target.value; if (!v) return; if (v.startsWith('fac:')) { const c = v.slice(4); setFacMentions(f => f.includes(c) ? f : [...f, c]) } else { setMentions(m => m.includes(v) ? m : [...m, v]) } }} className="w-36 border rounded-lg px-2 py-2 text-sm bg-white" title="Tag a person or location">
                <option value="">＠ Tag…</option>
                {factories.length > 0 && <optgroup label="Locations (all users)">
                  {factories.filter(f => f.code !== 'HEAD_OFFICE' && !facMentions.includes(f.code)).map(f => <option key={f.code} value={`fac:${f.code}`}>{f.code}{f.name && f.name !== f.code ? ` — ${f.name}` : ''}</option>)}
                </optgroup>}
                {users.length > 0 && <optgroup label="People">
                  {users.filter(u => u.id !== me && !mentions.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </optgroup>}
              </select>
            )}
            <input value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder={thread ? `Message about SO ${thread}…` : 'Type a message…'} className="flex-1 min-w-[12rem] border rounded-lg px-3 py-2 text-sm" />
            <button onClick={send} disabled={sending || !body.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{sending ? 'Sending…' : 'Send'}</button>
          </div>
          {err && <p className="text-red-500 text-xs mt-2">Couldn’t send: {err}</p>}
        </div>
      )}
    </div>
  )
}
