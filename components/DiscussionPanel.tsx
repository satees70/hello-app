'use client'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Msg { id: string; author_id: string | null; author_name: string | null; body: string; created_at: string; so_number: string | null; mention_ids: string[] | null }

// A lightweight message board so the warehouse and office can talk to each other.
// Messages are shared by `channel` (default "warehouse") and can be linked to a
// specific SO number — filter the thread by SO, or post against one.
export default function DiscussionPanel({ channel = 'warehouse', me, meName, title = 'Discussion', soOptions = [], filterSo: filterSoProp, onFilterChange, panelId, onPosted }: {
  channel?: string; me: string; meName?: string | null; title?: string; soOptions?: string[]
  filterSo?: string; onFilterChange?: (so: string) => void; panelId?: string; onPosted?: () => void
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [body, setBody] = useState('')
  const [tagSo, setTagSo] = useState('')      // SO to link the new message to
  const [internalFilter, setInternalFilter] = useState('')
  const filterSo = filterSoProp !== undefined ? filterSoProp : internalFilter   // controlled or internal
  const setFilterSo = onFilterChange || setInternalFilter
  const [sending, setSending] = useState(false)
  const [open, setOpen] = useState(true)
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [mentions, setMentions] = useState<string[]>([])   // tagged user ids on the new message
  const endRef = useRef<HTMLDivElement>(null)
  const nameOf = (id: string) => users.find(u => u.id === id)?.full_name || 'someone'

  async function load() {
    const { data } = await supabase.from('discussions').select('*').eq('channel', channel).order('created_at', { ascending: true }).limit(500)
    setMsgs((data as Msg[]) || [])
  }
  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id) }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { supabase.rpc('list_users').then(({ data }) => setUsers((data as { id: string; full_name: string }[]) || [])) }, [])
  // When the parent points us at an SO (e.g. clicked from a document), open and pre-link the reply
  useEffect(() => { if (filterSoProp) { setOpen(true); setTagSo(filterSoProp) } }, [filterSoProp])
  const shown = filterSo ? msgs.filter(m => (m.so_number || '') === filterSo) : msgs
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [shown.length])

  async function send() {
    const text = body.trim()
    if (!text) return
    setSending(true)
    const { error } = await supabase.from('discussions').insert({ channel, author_id: me, author_name: meName || null, body: text, so_number: tagSo.trim() || null, mention_ids: mentions })
    setSending(false)
    if (!error) { setBody(''); setMentions([]); load(); onPosted?.() }
  }
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  // SO numbers to offer: the ones passed in plus any already used in messages
  const soList = [...new Set([...soOptions, ...msgs.map(m => m.so_number || '').filter(Boolean)])].sort()

  return (
    <div id={panelId} className="bg-white rounded-xl shadow-sm border mb-8">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-semibold">💬 {title} <span className="font-normal text-gray-400 text-sm">· {msgs.length} message{msgs.length === 1 ? '' : 's'}</span></span>
        <span className="text-gray-400 text-sm">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {soList.length > 0 && (
            <div className="flex items-center gap-2 mb-2 text-sm">
              <span className="text-gray-500">Show:</span>
              <select value={filterSo} onChange={e => setFilterSo(e.target.value)} className="border rounded-lg px-2 py-1 text-sm bg-white">
                <option value="">All messages</option>
                {soList.map(so => <option key={so} value={so}>SO {so}</option>)}
              </select>
              {filterSo && <span className="text-gray-400 text-xs">{shown.length} for SO {filterSo}</span>}
            </div>
          )}
          <div className="max-h-72 overflow-y-auto space-y-2 border rounded-lg p-3 bg-gray-50 mb-3">
            {shown.length === 0 && <p className="text-gray-400 text-sm text-center py-4">{filterSo ? `No messages for SO ${filterSo} yet.` : 'No messages yet — start the conversation.'}</p>}
            {shown.map(m => {
              const mine = m.author_id === me
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${mine ? 'bg-blue-600 text-white' : 'bg-white border'}`}>
                    {!mine && <div className="text-xs font-medium text-gray-500">{m.author_name || 'Someone'}</div>}
                    {m.so_number && <button onClick={() => setFilterSo(m.so_number!)} className={`inline-block mb-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${mine ? 'bg-blue-500 text-white' : 'bg-indigo-100 text-indigo-700'}`}>SO {m.so_number}</button>}
                    {m.mention_ids && m.mention_ids.length > 0 && <div className="mb-0.5 flex flex-wrap gap-1">{m.mention_ids.map(id => <span key={id} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${mine ? 'bg-blue-500 text-white' : 'bg-amber-100 text-amber-800'}`}>@{nameOf(id)}</span>)}</div>}
                    <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    <div className={`text-[10px] mt-0.5 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>{fmt(m.created_at)}</div>
                  </div>
                </div>
              )
            })}
            <div ref={endRef} />
          </div>
          {mentions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mb-2 text-xs">
              <span className="text-gray-500">Tagging:</span>
              {mentions.map(id => <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">@{nameOf(id)}<button onClick={() => setMentions(m => m.filter(x => x !== id))} className="text-amber-600">✕</button></span>)}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <input list="disc-so-list" value={tagSo} onChange={e => setTagSo(e.target.value)} placeholder="Link SO# (optional)" className="w-36 border rounded-lg px-3 py-2 text-sm" />
            <datalist id="disc-so-list">{soList.map(so => <option key={so} value={so} />)}</datalist>
            {users.length > 0 && (
              <select value="" onChange={e => { if (e.target.value) setMentions(m => m.includes(e.target.value) ? m : [...m, e.target.value]) }} className="w-36 border rounded-lg px-2 py-2 text-sm bg-white" title="Tag a person">
                <option value="">＠ Tag…</option>
                {users.filter(u => u.id !== me && !mentions.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            )}
            <input value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder={tagSo ? `Message about SO ${tagSo}…` : 'Type a message…'} className="flex-1 min-w-[12rem] border rounded-lg px-3 py-2 text-sm" />
            <button onClick={send} disabled={sending || !body.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{sending ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
