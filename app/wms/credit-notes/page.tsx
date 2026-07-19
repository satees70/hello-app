'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

// Customer Credit Notes + returns. The CN (with costing) is raised in SQL Account; here we upload
// its PDF (auto-read) and handle the QUANTITY when goods come back: returned goods → RETURNS
// quarantine → quality check → Pass (transfer to a bin) / Fail (→ DAMAGED, Head Office decides).
interface CN { id: string; cn_number: string | null; customer_name: string | null; so_number: string | null; cn_date: string | null; note: string | null; file_path: string | null; created_by_name: string | null; created_at: string }
interface RLine { item_code: string; description: string | null; quantity: number }
interface Held { id: string; item_code: string; description: string | null; batch_no: string; exp_date: string | null; quantity: number; uom: string | null; updated_at: string }
interface Loc { id: string; code: string; pickable: boolean | null; location_type: string }
const BUCKET = 'delivery-orders'

const fmtQty = (n: number) => Number(Number(n).toPrecision(12)).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function WmsCreditNotesPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const [list, setList] = useState<CN[]>([])
  const [held, setHeld] = useState<Held[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  // upload form
  const [file, setFile] = useState<File | null>(null)
  const [cnNo, setCnNo] = useState(''); const [cust, setCust] = useState(''); const [so, setSo] = useState(''); const [cnDate, setCnDate] = useState(''); const [note, setNote] = useState('')
  const [reading, setReading] = useState(false)
  const [lines, setLines] = useState<(RLine & { batch: string })[]>([])
  const [passTo, setPassTo] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const [{ data: cn }, { data: hs }, lo] = await Promise.all([
      supabase.from('credit_notes').select('id, cn_number, customer_name, so_number, cn_date, note, file_path, created_by_name, created_at').order('created_at', { ascending: false }).limit(300),
      supabase.from('wms_stock').select('id, item_code, description, batch_no, exp_date, quantity, uom, updated_at').eq('location_code', 'RETURNS').gt('quantity', 0).order('updated_at', { ascending: false }),
      fetchAll<Loc>('wms_locations', 'id, code, pickable, location_type'),
    ])
    setList((cn as CN[]) || [])
    setHeld((hs as Held[]) || [])
    setLocs(lo)
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  const bins = useMemo(() => locs.filter(l => l.pickable !== false && !['STAGE'].includes(l.location_type) && !['RETURNS', 'DAMAGED', 'QC-HOLD', 'GOODS-IN', 'PENDING'].includes(l.code)).sort((a, b) => a.code.localeCompare(b.code)), [locs])

  async function readPdf(f: File) {
    setReading(true); setErr('')
    try {
      const { data: sess } = await supabase.auth.getSession()
      const fd = new FormData(); fd.append('file', f)
      const r = await fetch('/api/extract-credit-note', { method: 'POST', headers: { Authorization: `Bearer ${sess.session?.access_token || ''}` }, body: fd })
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Could not read the PDF.')
      const d = j.data || {}
      if (d.cn_number) setCnNo(String(d.cn_number)); if (d.customer_name) setCust(String(d.customer_name))
      if (d.cn_date && /^\d{4}-\d{2}-\d{2}$/.test(String(d.cn_date))) setCnDate(String(d.cn_date)); if (d.so_number) setSo(String(d.so_number))
      setLines(Array.isArray(d.lines) ? d.lines.map((l: RLine) => ({ ...l, batch: '' })) : [])
      setMsg('Read the PDF — check the details, upload the CN, and receive any returned goods below.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the PDF.') }
    setReading(false)
  }

  async function saveCN() {
    setErr(''); setMsg('')
    if (!file) { setErr('Choose the CN PDF from SQL Account.'); return }
    if (!cnNo.trim()) { setErr('Enter the CN number.'); return }
    setBusy('cn')
    try {
      const id = (crypto as Crypto).randomUUID()
      const safe = (file.name || 'cn.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `credit-notes/${id}-${safe}`
      const { error: up } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/pdf', upsert: false })
      if (up) throw up
      const { error: ie } = await supabase.from('credit_notes').insert({ cn_number: cnNo.trim(), customer_name: cust.trim() || null, so_number: so.trim() || null, cn_date: cnDate || null, note: note.trim() || null, file_path: path, file_name: file.name, factory_code: profile?.factory_code || null, created_by: profile?.id, created_by_name: profile?.full_name || null })
      if (ie) throw ie
      setMsg(`Credit note ${cnNo.trim()} uploaded. Receive any returned goods below.`)
      load()
    } catch (e) { setErr(/credit_notes|does not exist|schema cache|could not find/i.test(e instanceof Error ? e.message : String(e)) ? 'This needs a database update — run db/2026-07-credit-notes.sql in the Supabase SQL editor.' : (e instanceof Error ? e.message : String(e))) }
    setBusy('')
  }

  async function receiveLine(i: number) {
    const l = lines[i]; if (!l || !canEdit) return
    if (!(l.quantity > 0)) { setErr('Enter a quantity.'); return }
    setBusy('r' + i); setErr('')
    const { error } = await supabase.rpc('wms_receive_customer_return', { p_item_code: l.item_code, p_qty: l.quantity, p_batch: l.batch.trim() || null, p_exp_date: null, p_reference: cnNo.trim() ? 'CN ' + cnNo.trim() : null })
    setBusy('')
    if (error) { setErr(/wms_receive_customer_return|RETURNS/.test(error.message) && /does not exist|schema cache|could not find|missing/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-customer-returns.sql in the Supabase SQL editor.' : error.message); return }
    setLines(ls => ls.filter((_, j) => j !== i))
    setMsg(`${l.item_code} received to RETURNS quarantine.`); load()
  }
  async function pass(h: Held) {
    const loc = passTo[h.id]; if (!loc) { setErr('Choose a bin to move it to.'); return }
    setBusy(h.id); setErr('')
    const { error } = await supabase.rpc('wms_return_pass', { p_stock_id: h.id, p_location_id: loc })
    setBusy('')
    if (error) { setErr(error.message); return }
    setMsg(`${h.item_code} passed — moved to stock.`); load()
  }
  async function fail(h: Held) {
    const reason = window.prompt(`Fail QC for ${h.item_code} (×${fmtQty(h.quantity)})?\n\nIt goes to DAMAGED and Head Office decides (write off / return to stock / return to supplier).\n\nReason:`, '')
    if (reason === null) return
    setBusy(h.id); setErr('')
    const { error } = await supabase.rpc('wms_return_fail', { p_stock_id: h.id, p_reason: reason || null })
    setBusy('')
    if (error) { setErr(error.message); return }
    setMsg(`${h.item_code} failed — sent to DAMAGED for Head Office.`); load()
  }
  async function view(cn: CN) {
    if (!cn.file_path) return
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(cn.file_path, 120)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-2xl font-bold">Customer Credit Notes &amp; Returns</h1>
          <Link href="/wms" className="text-sm text-emerald-700 hover:underline">← Warehouse home</Link>
        </div>
        <p className="text-gray-500 text-sm mb-4">Raise the CN in <b>SQL Account</b> (costing stays there), upload the PDF here, then handle returned goods: they go to <b>RETURNS quarantine</b> → quality check → <b>Pass</b> (move to a bin) or <b>Fail</b> (→ DAMAGED, Head Office decides).</p>

        {err && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}
        {msg && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {msg}</div>}

        {/* Upload + auto-read */}
        {canEdit && (
          <div className="bg-white rounded-xl border shadow-sm p-4 mb-6">
            <h2 className="font-semibold text-sm mb-3">Upload a CN from SQL Account</h2>
            <div className="mb-3">
              <input type="file" accept="application/pdf,image/*" onChange={e => { const f = e.target.files?.[0] || null; setFile(f); setLines([]); if (f) readPdf(f) }} className="text-sm" />
              {reading && <span className="ml-2 text-xs text-emerald-600">🔍 reading…</span>}
              {file && !reading && <span className="ml-2 text-xs text-gray-500">{file.name}</span>}
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div><label className="block text-xs text-gray-500 mb-1">CN number *</label><input value={cnNo} onChange={e => setCnNo(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">Customer</label><input value={cust} onChange={e => setCust(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">CN date</label><input type="date" value={cnDate} onChange={e => setCnDate(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">Linked SO / invoice</label><input value={so} onChange={e => setSo(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div className="sm:col-span-2"><label className="block text-xs text-gray-500 mb-1">Note</label><input value={note} onChange={e => setNote(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
            </div>
            <button onClick={saveCN} disabled={busy === 'cn' || !file || !cnNo.trim()} className="mt-3 bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{busy === 'cn' ? 'Uploading…' : '⬆ Upload CN'}</button>

            {lines.length > 0 && (
              <div className="mt-4 border-t pt-3">
                <div className="text-xs font-semibold text-gray-600 mb-2">Returned goods on this CN — receive to RETURNS quarantine</div>
                <div className="space-y-1.5">
                  {lines.map((l, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1"><span className="font-mono">{l.item_code}</span>{l.description ? <span className="text-gray-400"> — {l.description}</span> : ''}</span>
                      <input value={String(l.quantity)} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, quantity: Number(e.target.value.replace(/[^0-9.]/g, '')) || 0 } : x))} className="w-20 border rounded px-2 py-1 text-xs text-right" inputMode="decimal" title="Qty returned" />
                      <input value={l.batch} onChange={e => setLines(ls => ls.map((x, j) => j === i ? { ...x, batch: e.target.value } : x))} placeholder="batch" className="w-28 border rounded px-2 py-1 text-xs" />
                      {canEdit && <button onClick={() => receiveLine(i)} disabled={busy === 'r' + i} className="text-xs border border-amber-500 text-amber-700 rounded px-3 py-1.5 hover:bg-amber-50 disabled:opacity-50 font-medium">↩ Receive to quarantine</button>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* RETURNS quarantine — quality check */}
        <div className="bg-white rounded-xl border shadow-sm mb-6">
          <div className="px-4 py-2.5 border-b font-semibold text-sm bg-amber-50/60">RETURNS quarantine — quality check <span className="text-gray-400 font-normal">· {held.length}</span></div>
          {held.length === 0 ? <p className="px-4 py-6 text-gray-400 text-sm text-center">Nothing awaiting quality check.</p> : (
            <div className="divide-y">
              {held.map(h => (
                <div key={h.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono font-medium">{h.item_code}</span>{h.description ? <span className="text-gray-500"> — {h.description}</span> : ''}
                    <span className="block text-xs text-gray-400">× {fmtQty(h.quantity)}{h.uom ? ' ' + h.uom : ''}{h.batch_no ? ` · batch ${h.batch_no}` : ''} · in {fmtWhen(h.updated_at)}</span>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-2 shrink-0">
                      <select value={passTo[h.id] || ''} onChange={e => setPassTo(m => ({ ...m, [h.id]: e.target.value }))} className="border rounded-lg px-2 py-1.5 text-xs">
                        <option value="">Pass to bin…</option>
                        {bins.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
                      </select>
                      <button onClick={() => pass(h)} disabled={busy === h.id || !passTo[h.id]} className="bg-emerald-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">✓ Pass</button>
                      <button onClick={() => fail(h)} disabled={busy === h.id} className="bg-red-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-50">✗ Fail</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* CN log */}
        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <div className="px-4 py-2.5 border-b font-semibold text-sm">Credit notes <span className="text-gray-400 font-normal">· {list.length}</span></div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['CN No.', 'Customer', 'Date', 'Linked SO', 'Uploaded', 'PDF'].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No credit notes yet.</td></tr>}
              {list.map(c => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{c.cn_number || '—'}</td>
                  <td className="px-3 py-2">{c.customer_name || '—'}{c.note ? <span className="block text-xs text-gray-400">{c.note}</span> : ''}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(c.cn_date)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.so_number || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{c.created_by_name || '—'}<span className="block text-gray-400">{fmtWhen(c.created_at)}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{c.file_path ? <button onClick={() => view(c)} className="text-emerald-700 hover:underline text-xs">📄 View</button> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
