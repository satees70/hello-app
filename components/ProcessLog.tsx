'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, type ModuleKey } from '@/lib/permissions'
import { requestTimerCancel } from '@/lib/corrections'

export type Field = {
  key: string
  label: string
  type?: 'text' | 'number' | 'date' | 'time' | 'select' | 'item' | 'timer'
  options?: string[]
  list?: boolean        // show as a column in the list table
  wide?: boolean        // span full width in the form
  startKey?: string     // for type 'timer': the start-time column
  finishKey?: string    // for type 'timer': the finish-time column
  cancelKey?: string    // for type 'timer': semantic key for a cancellation request
}

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const fmtDate = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || '—') }
const fmtClock = (iso: string) => iso ? new Date(iso).toLocaleTimeString() : '—'
const fmtDur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` }

export default function ProcessLog({ table, title, subtitle, moduleKey, fields, applyAction }: {
  table: string; title: string; subtitle?: string; moduleKey: ModuleKey; fields: Field[]
  applyAction?: { rpc: string; flagField: string; label: string; doneLabel: string }
}) {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, moduleKey)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [colF, setColF] = useState<Record<string, string>>({})
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [factory, setFactory] = useState('')
  const [editing, setEditing] = useState<Record<string, unknown> | 'new' | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [items, setItems] = useState<{ code: string; description: string | null }[]>([])
  const [now, setNow] = useState(Date.now())
  const hasItemField = fields.some(f => f.type === 'item')
  const anyRunning = fields.some(f => f.type === 'timer' && form[f.startKey!] && !form[f.finishKey!])
  useEffect(() => { if (!editing || !anyRunning) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [editing, anyRunning])

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, moduleKey, 'edit')
  const myFactoryOptions = isHO ? factories.map(f => f.code)
    : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : []))
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const listFields = fields.filter(f => f.list)
  const visibleRows = rows.filter(r => {
    if (isHO && colF.__factory && !factoryName(r.factory_code as string).toLowerCase().includes(colF.__factory.toLowerCase())) return false
    return listFields.every(fl => !colF[fl.key] || String(r[fl.key] ?? '').toLowerCase().includes(colF[fl.key].toLowerCase()))
  })

  useEffect(() => { if (profile) { loadFactories(); load() } }, [profile])
  useEffect(() => { if (profile && hasItemField && items.length === 0) fetchAll<{ code: string; description: string | null }>('items', 'code, description', 'code').then(setItems) }, [profile])
  async function loadFactories() { const { data } = await supabase.from('factories').select('code, name').order('code'); setFactories(data || []) }
  async function load() { const { data } = await supabase.from(table).select('*').order('created_at', { ascending: false }); setRows((data as Record<string, unknown>[]) || []) }

  function openNew() {
    setEditing('new'); setError(''); setFactory(myFactoryOptions[0] || '')
    const f: Record<string, string> = {}
    fields.forEach(fl => { if (fl.type === 'timer') { f[fl.startKey!] = ''; f[fl.finishKey!] = '' } else f[fl.key] = fl.type === 'date' ? todayLocal() : '' })
    setForm(f)
  }
  function openEdit(r: Record<string, unknown>) {
    setEditing(r); setError(''); setFactory((r.factory_code as string) || '')
    const f: Record<string, string> = {}
    fields.forEach(fl => { if (fl.type === 'timer') { f[fl.startKey!] = r[fl.startKey!] == null ? '' : String(r[fl.startKey!]); f[fl.finishKey!] = r[fl.finishKey!] == null ? '' : String(r[fl.finishKey!]) } else f[fl.key] = r[fl.key] == null ? '' : String(r[fl.key]) })
    setForm(f)
  }
  function close() { setEditing(null) }

  // Set a field; if editing an existing record, persist it immediately (so a
  // timer's Start survives closing the form and coming back to press Finish).
  async function setField(key: string, value: string) {
    setForm(prev => ({ ...prev, [key]: value }))
    if (editing && editing !== 'new') await supabase.from(table).update({ [key]: value || null }).eq('id', (editing as Record<string, unknown>).id as string)
  }

  async function runApply() {
    if (!applyAction || !editing || editing === 'new') return
    setSaving(true); setError('')
    const { error } = await supabase.rpc(applyAction.rpc, { p_id: (editing as Record<string, unknown>).id })
    setSaving(false)
    if (error) { setError(error.message); return }
    alert('Done — stock updated.'); close(); load()
  }

  async function requestCancel(fl: Field) {
    if (!editing || editing === 'new' || !fl.cancelKey) return
    const r = editing as Record<string, unknown>
    const res = await requestTimerCancel({ table, record_id: r.id as string, timer_key: fl.cancelKey, label: `${title} — ${fl.label}`, factory_code: (r.factory_code as string) || factory, requested_by_name: profile?.full_name })
    if (res === null) return
    if (res) setError(res); else alert('Cancellation request sent to Head Office for approval.')
  }

  async function save() {
    setSaving(true); setError('')
    if (!factory) { setError('Pick a factory.'); setSaving(false); return }
    const payload: Record<string, unknown> = { factory_code: factory }
    fields.forEach(fl => {
      if (fl.type === 'timer') { payload[fl.startKey!] = form[fl.startKey!] || null; payload[fl.finishKey!] = form[fl.finishKey!] || null; return }
      const v = form[fl.key]; payload[fl.key] = fl.type === 'number' ? (v === '' ? null : Number(v)) : (v === '' ? null : v)
    })
    let err
    if (editing === 'new') {
      const { data: sess } = await supabase.auth.getSession()
      payload.created_by = sess.session?.user.id || null
      err = (await supabase.from(table).insert(payload)).error
    } else {
      err = (await supabase.from(table).update(payload).eq('id', (editing as Record<string, unknown>).id as string)).error
    }
    setSaving(false)
    if (err) { setError(err.message); return }
    close(); load()
  }

  const cell = (r: Record<string, unknown>, fl: Field) => {
    const v = r[fl.key]
    if (v == null || v === '') return '—'
    return fl.type === 'date' ? fmtDate(String(v)) : String(v)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          {canEdit && <button onClick={() => (editing ? close() : openNew())} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">{editing ? 'Cancel' : '+ New record'}</button>}
        </div>
        {subtitle && <p className="text-gray-500 text-sm mb-5">{subtitle}</p>}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{[...(isHO ? ['Factory'] : []), ...listFields.map(f => f.label), ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
              <tr className="border-b">
                {isHO && <th className="px-2 py-1"><input value={colF.__factory || ''} onChange={e => setColF(p => ({ ...p, __factory: e.target.value }))} placeholder="filter…" className="w-full min-w-[70px] border rounded px-2 py-1 text-xs bg-white" /></th>}
                {listFields.map(fl => <th key={fl.key} className="px-2 py-1"><input value={colF[fl.key] || ''} onChange={e => setColF(p => ({ ...p, [fl.key]: e.target.value }))} placeholder="filter…" className="w-full min-w-[70px] border rounded px-2 py-1 text-xs bg-white" /></th>)}
                <th className="px-2 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={listFields.length + 2} className="text-center py-8 text-gray-400">No records yet.</td></tr>}
              {rows.length > 0 && visibleRows.length === 0 && <tr><td colSpan={listFields.length + 2} className="text-center py-8 text-gray-400">No records match the filter.</td></tr>}
              {visibleRows.map(r => (
                <tr key={r.id as string} className="border-b last:border-0 hover:bg-gray-50">
                  {isHO && <td className="px-3 py-2 whitespace-nowrap">{factoryName(r.factory_code as string)}</td>}
                  {listFields.map(fl => <td key={fl.key} className="px-3 py-2 whitespace-nowrap">{cell(r, fl)}</td>)}
                  <td className="px-3 py-2 text-right"><button onClick={() => openEdit(r)} className="text-blue-600 hover:underline">{canEdit ? 'Open' : 'View'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={close}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-3xl my-8 p-6" onClick={e => e.stopPropagation()}>
            {hasItemField && <datalist id="process-items">{items.map(it => <option key={it.code} value={`${it.code}${it.description ? ' — ' + it.description : ''}`} />)}</datalist>}
            <h2 className="font-semibold text-lg mb-4">{editing === 'new' ? `New — ${title}` : title}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {editing === 'new' && myFactoryOptions.length > 1 && (
                <div><label className="block text-sm font-medium mb-1">Factory</label>
                  <select value={factory} onChange={e => setFactory(e.target.value)} className="w-full border rounded-lg px-3 py-2">{myFactoryOptions.map(c => <option key={c} value={c}>{factoryName(c)}</option>)}</select></div>
              )}
              {fields.map(fl => (
                <div key={fl.key} className={fl.wide ? 'sm:col-span-3' : ''}>
                  <label className="block text-sm font-medium mb-1">{fl.label}</label>
                  {fl.type === 'timer' ? (() => {
                    const sv = form[fl.startKey!] || '', fv = form[fl.finishKey!] || ''
                    const dur = sv ? (Date.parse(fv || new Date(now).toISOString()) - Date.parse(sv)) : 0
                    return (
                      <div className="flex flex-wrap items-center gap-2 border rounded-lg px-3 py-2">
                        {canEdit && !sv && <button type="button" onClick={() => setField(fl.startKey!, new Date().toISOString())} className="bg-green-600 text-white px-3 py-1 rounded-lg text-sm font-medium">▶ Start</button>}
                        {canEdit && sv && !fv && <button type="button" onClick={() => setField(fl.finishKey!, new Date().toISOString())} className="bg-red-600 text-white px-3 py-1 rounded-lg text-sm font-medium">⏹ Finish</button>}
                        {canEdit && sv && editing === 'new' && <button type="button" onClick={() => { setField(fl.startKey!, ''); setField(fl.finishKey!, '') }} className="border px-3 py-1 rounded-lg text-sm">↻ Reset</button>}
                        <span className="font-mono text-sm font-semibold">{sv ? fmtDur(dur) : '—'}</span>
                        <span className="text-xs text-gray-500">{sv && `Start ${fmtClock(sv)}`}{fv ? ` · End ${fmtClock(fv)}` : sv ? ' · running' : ''}</span>
                        {canEdit && sv && editing !== 'new' && fl.cancelKey && <button type="button" onClick={() => requestCancel(fl)} className="text-orange-600 hover:underline text-xs ml-1">Request to cancel</button>}
                      </div>
                    )
                  })() : fl.type === 'select' ? (
                    <select value={form[fl.key] || ''} onChange={e => setForm({ ...form, [fl.key]: e.target.value })} disabled={!canEdit} className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100">
                      <option value="">—</option>{(fl.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : fl.type === 'item' ? (
                    <input list="process-items" value={form[fl.key] || ''} onChange={e => setForm({ ...form, [fl.key]: e.target.value })} disabled={!canEdit}
                      placeholder="Search code or name…" className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
                  ) : (
                    <input type={fl.type === 'number' ? 'number' : fl.type === 'date' ? 'date' : fl.type === 'time' ? 'time' : 'text'}
                      value={form[fl.key] || ''} onChange={e => setForm({ ...form, [fl.key]: e.target.value })} disabled={!canEdit}
                      className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
                  )}
                </div>
              ))}
            </div>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mt-3">{error}</p>}
            <div className="flex flex-wrap gap-2 mt-4 items-center">
              {canEdit && <button onClick={save} disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{saving ? 'Saving…' : 'Save'}</button>}
              {applyAction && canEdit && editing !== 'new' && (
                (editing as Record<string, unknown>)[applyAction.flagField]
                  ? <span className="text-green-700 text-sm font-medium">✓ {applyAction.doneLabel}</span>
                  : <button onClick={runApply} disabled={saving} className="bg-emerald-600 text-white px-5 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-medium">{applyAction.label}</button>
              )}
              <button onClick={close} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium ml-auto">Close</button>
            </div>
            {applyAction && editing === 'new' && <p className="text-xs text-gray-400 mt-2">Save first, then re-open this record to move the stock.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
