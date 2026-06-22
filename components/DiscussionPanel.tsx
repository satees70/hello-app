'use client'
import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Msg { id: string; author_id: string | null; author_name: string | null; body: string; created_at: string }

// A lightweight message board so the warehouse and office can talk to each other.
// Messages are shared by `channel` (default "warehouse").
export default function DiscussionPanel({ channel = 'warehouse', me, meName, title = 'Discussion' }: {
  channel?: string; me: string; meName?: string | null; title?: string
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [open, setOpen] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  async function load() {
    const { data } = await supabase.from('discussions').select('*').eq('channel', channel).order('created_at', { ascending: true }).limit(500)
    setMsgs((data as Msg[]) || [])
  }
  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id) }, [channel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [msgs.length])

  async function send() {
    const text = body.trim()
    if (!text) return
    setSending(true)
    const { error } = await supabase.from('discussions').insert({ channel, author_id: me, author_name: meName || null, body: text })
    setSending(false)
    if (!error) { setBody(''); load() }
  }
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="bg-white rounded-xl shadow-sm border mb-8">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span className="font-semibold">💬 {title} <span className="font-normal text-gray-400 text-sm">· {msgs.length} message{msgs.length === 1 ? '' : 's'}</span></span>
        <span className="text-gray-400 text-sm">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <div className="max-h-72 overflow-y-auto space-y-2 border rounded-lg p-3 bg-gray-50 mb-3">
            {msgs.length === 0 && <p className="text-gray-400 text-sm text-center py-4">No messages yet — start the conversation.</p>}
            {msgs.map(m => {
              const mine = m.author_id === me
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-sm ${mine ? 'bg-blue-600 text-white' : 'bg-white border'}`}>
                    {!mine && <div className="text-xs font-medium text-gray-500">{m.author_name || 'Someone'}</div>}
                    <div className="whitespace-pre-wrap break-words">{m.body}</div>
                    <div className={`text-[10px] mt-0.5 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>{fmt(m.created_at)}</div>
                  </div>
                </div>
              )
            })}
            <div ref={endRef} />
          </div>
          <div className="flex gap-2">
            <input value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder="Type a message…" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
            <button onClick={send} disabled={sending || !body.trim()} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{sending ? 'Sending…' : 'Send'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
