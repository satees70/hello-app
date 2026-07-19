'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'

// Customer Credit Notes — reference copies of CNs raised in SQL Account. Upload the CN's PDF and
// tag it (CN no, customer, date, linked SO). Costing stays in SQL; nothing is created here.
interface CN { id: string; cn_number: string | null; customer_name: string | null; so_number: string | null; cn_date: string | null; note: string | null; file_path: string | null; file_name: string | null; created_by_name: string | null; created_at: string }
const BUCKET = 'delivery-orders'   // reuse the existing bucket, under a credit-notes/ prefix

const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function CreditNotesPage() {
  const { profile, loading, error } = useProfile()
  const canEdit = !!profile && can(profile, 'sales', 'edit')
  const [list, setList] = useState<CN[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  // upload form
  const [file, setFile] = useState<File | null>(null)
  const [cnNo, setCnNo] = useState(''); const [cust, setCust] = useState(''); const [so, setSo] = useState(''); const [cnDate, setCnDate] = useState(''); const [note, setNote] = useState('')
  const [reading, setReading] = useState(false)
  const [lines, setLines] = useState<{ item_code: string; description: string; quantity: number }[]>([])

  // Auto-read the CN PDF (like Sales Orders) to pre-fill the fields. The page still saves on review.
  async function readPdf(f: File) {
    setReading(true); setErr('')
    try {
      const { data: sess } = await supabase.auth.getSession()
      const fd = new FormData(); fd.append('file', f)
      const r = await fetch('/api/extract-credit-note', { method: 'POST', headers: { Authorization: `Bearer ${sess.session?.access_token || ''}` }, body: fd })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'Could not read the PDF.')
      const d = j.data || {}
      if (d.cn_number) setCnNo(String(d.cn_number))
      if (d.customer_name) setCust(String(d.customer_name))
      if (d.cn_date && /^\d{4}-\d{2}-\d{2}$/.test(String(d.cn_date))) setCnDate(String(d.cn_date))
      if (d.so_number) setSo(String(d.so_number))
      setLines(Array.isArray(d.lines) ? d.lines : [])
      setMsg('Read the PDF — check the details below, then upload.')
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not read the PDF.') }
    setReading(false)
  }

  const load = useCallback(async () => {
    const { data } = await supabase.from('credit_notes').select('id, cn_number, customer_name, so_number, cn_date, note, file_path, file_name, created_by_name, created_at').order('created_at', { ascending: false }).limit(500)
    setList((data as CN[]) || [])
  }, [])
  useEffect(() => { if (profile) load() }, [profile, load])

  async function save() {
    setErr(''); setMsg('')
    if (!file) { setErr('Choose the CN PDF from SQL Account to upload.'); return }
    if (!cnNo.trim()) { setErr('Enter the CN number.'); return }
    setBusy(true)
    try {
      const id = (crypto as Crypto).randomUUID()
      const safe = (file.name || 'cn.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `credit-notes/${id}-${safe}`
      const { error: up } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/pdf', upsert: false })
      if (up) throw up
      const { error: ie } = await supabase.from('credit_notes').insert({
        cn_number: cnNo.trim(), customer_name: cust.trim() || null, so_number: so.trim() || null,
        cn_date: cnDate || null, note: note.trim() || null, file_path: path, file_name: file.name,
        factory_code: profile?.factory_code || null, created_by: profile?.id, created_by_name: profile?.full_name || null,
      })
      if (ie) throw ie
      setMsg(`Credit note ${cnNo.trim()} uploaded.`)
      setFile(null); setCnNo(''); setCust(''); setSo(''); setCnDate(''); setNote(''); setLines([])
      load()
    } catch (e) {
      setErr(/credit_notes|does not exist|schema cache|could not find/i.test(e instanceof Error ? e.message : String(e)) ? 'This needs a database update — run db/2026-07-credit-notes.sql in the Supabase SQL editor.' : (e instanceof Error ? e.message : String(e)))
    }
    setBusy(false)
  }

  async function view(cn: CN) {
    if (!cn.file_path) return
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(cn.file_path, 120)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  async function del(cn: CN) {
    if (!canEdit) return
    if (!window.confirm(`Delete credit note ${cn.cn_number || ''}? This only removes it here (SQL Account is unaffected).`)) return
    if (cn.file_path) await supabase.storage.from(BUCKET).remove([cn.file_path])
    await supabase.from('credit_notes').delete().eq('id', cn.id)
    setList(l => l.filter(x => x.id !== cn.id))
  }

  const rq = q.trim().toLowerCase()
  const shown = useMemo(() => rq ? list.filter(c => `${c.cn_number || ''} ${c.customer_name || ''} ${c.so_number || ''} ${c.note || ''}`.toLowerCase().includes(rq)) : list, [list, rq])

  if (loading && !error) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Customer Credit Notes</h1>
        <p className="text-gray-500 text-sm mb-4">Raise the CN in <b>SQL Account</b> (it keeps the costing), then upload the PDF here to keep and view it. There&apos;s no manual creation — a PDF is always required.</p>

        {err && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{err}</div>}
        {msg && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">✓ {msg}</div>}

        {canEdit && (
          <div className="bg-white rounded-xl border shadow-sm p-4 mb-6">
            <h2 className="font-semibold text-sm mb-3">Upload a CN from SQL Account</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              <div><label className="block text-xs text-gray-500 mb-1">CN number *</label><input value={cnNo} onChange={e => setCnNo(e.target.value)} placeholder="e.g. CN-2607/0012" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">Customer</label><input value={cust} onChange={e => setCust(e.target.value)} placeholder="customer name" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">CN date</label><input type="date" value={cnDate} onChange={e => setCnDate(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs text-gray-500 mb-1">Linked SO / invoice <span className="text-gray-400">(optional)</span></label><input value={so} onChange={e => setSo(e.target.value)} placeholder="e.g. SO-41492" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div className="sm:col-span-2"><label className="block text-xs text-gray-500 mb-1">Note <span className="text-gray-400">(optional)</span></label><input value={note} onChange={e => setNote(e.target.value)} placeholder="reason / reference" className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-500 mb-1">CN PDF * <span className="text-gray-400">(auto-reads to fill the fields above)</span></label>
                <input type="file" accept="application/pdf,image/*" onChange={e => { const f = e.target.files?.[0] || null; setFile(f); setLines([]); if (f) readPdf(f) }} className="text-sm" />
                {reading && <span className="ml-2 text-xs text-emerald-600">🔍 reading…</span>}
                {file && !reading && <span className="ml-2 text-xs text-gray-500">{file.name}</span>}
                {lines.length > 0 && <div className="mt-2 text-xs text-gray-500">Read {lines.length} line(s): {lines.slice(0, 6).map(l => `${l.item_code}×${l.quantity}`).join(', ')}{lines.length > 6 ? '…' : ''}</div>}
              </div>
            </div>
            <div className="mt-3">
              <button onClick={save} disabled={busy || !file || !cnNo.trim()} className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{busy ? 'Uploading…' : '⬆ Upload CN'}</button>
            </div>
          </div>
        )}

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 CN no., customer, SO…" className="border rounded-lg px-3 py-2 text-sm w-full sm:w-80 mb-4" />

        <div className="bg-white rounded-xl border shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>{['CN No.', 'Customer', 'Date', 'Linked SO', 'Uploaded', 'PDF', ''].map(h => <th key={h} className="text-left px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-gray-400">No credit notes yet.</td></tr>}
              {shown.map(c => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{c.cn_number || '—'}</td>
                  <td className="px-3 py-2">{c.customer_name || '—'}{c.note ? <span className="block text-xs text-gray-400">{c.note}</span> : ''}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtDate(c.cn_date)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.so_number || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{c.created_by_name || '—'}<span className="block text-gray-400">{fmtWhen(c.created_at)}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{c.file_path ? <button onClick={() => view(c)} className="text-emerald-700 hover:underline text-xs">📄 View</button> : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{canEdit && <button onClick={() => del(c)} className="text-red-500 hover:underline text-xs">Delete</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
