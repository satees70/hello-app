'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface Material { item: string; qty: string }
interface GrindingRecord {
  id: string
  factory_code: string
  month_year: string | null
  record_date: string | null
  product: string | null
  product_batch_no: string | null
  materials: Material[] | null
  machine: string | null
  crusher_before: string | null
  crusher_after: string | null
  qty_rework: number | null
  qty_rejection: number | null
  correction_action: string | null
  prepared_by: string | null
  verified_by: string | null
  remark: string | null
  created_at: string
}

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const thisMonthYear = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` }

const blankForm = () => ({
  month_year: thisMonthYear(), record_date: todayLocal(), product: '', product_batch_no: '',
  materials: [{ item: '', qty: '' }] as Material[],
  machine: '', crusher_before: '', crusher_after: '', qty_rework: '', qty_rejection: '',
  correction_action: '', prepared_by: '', verified_by: '', remark: '',
})

export default function GrindingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'grinding')
  const [records, setRecords] = useState<GrindingRecord[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [factory, setFactory] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(blankForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'grinding', 'edit')
  // Which factories this user can file grinding records for
  const myFactoryOptions = isHO
    ? factories.map(f => f.code)
    : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : []))

  useEffect(() => { if (profile) { loadFactories(); load() } }, [profile])
  useEffect(() => { if (myFactoryOptions.length && !factory) setFactory(myFactoryOptions[0]) }, [factories, profile])

  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  async function load() {
    const { data } = await supabase.from('grinding_records').select('*')
      .order('record_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    setRecords((data as GrindingRecord[]) || [])
  }

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const setMat = (i: number, k: keyof Material, v: string) =>
    setForm(prev => { const m = [...prev.materials]; m[i] = { ...m[i], [k]: v }; return { ...prev, materials: m } })
  const addMat = () => setForm(prev => ({ ...prev, materials: [...prev.materials, { item: '', qty: '' }] }))
  const removeMat = (i: number) => setForm(prev => ({ ...prev, materials: prev.materials.filter((_, j) => j !== i) }))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    if (!factory) { setError('Pick a factory.'); setSaving(false); return }
    const materials = form.materials.filter(m => m.item.trim() || m.qty.trim())
    const { data: sess } = await supabase.auth.getSession()
    const { error } = await supabase.from('grinding_records').insert({
      factory_code: factory,
      month_year: form.month_year || null,
      record_date: form.record_date || null,
      product: form.product || null,
      product_batch_no: form.product_batch_no || null,
      materials,
      machine: form.machine || null,
      crusher_before: form.crusher_before || null,
      crusher_after: form.crusher_after || null,
      qty_rework: form.qty_rework === '' ? null : Number(form.qty_rework),
      qty_rejection: form.qty_rejection === '' ? null : Number(form.qty_rejection),
      correction_action: form.correction_action || null,
      prepared_by: form.prepared_by || null,
      verified_by: form.verified_by || null,
      remark: form.remark || null,
      created_by: sess.session?.user.id || null,
    })
    setSaving(false)
    if (error) { setError(error.message); return }
    setForm(blankForm()); setShowForm(false); load()
  }

  const fmt = (d: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const matSummary = (m: Material[] | null) => (m && m.length ? m.map(x => `${x.item}${x.qty ? ` (${x.qty})` : ''}`).join(', ') : '—')

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold">Grinding &amp; Mixing Record</h1>
          {canEdit && (
            <button onClick={() => { setShowForm(s => !s); setError('') }}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
              {showForm ? 'Cancel' : '+ New record'}
            </button>
          )}
        </div>
        <p className="text-gray-500 text-sm mb-5">Controlled form P07-F10. Each record can list a mixture of several raw materials.</p>

        {showForm && canEdit && (
          <form onSubmit={save} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {myFactoryOptions.length > 1 && (
                <Field label="Factory">
                  <select value={factory} onChange={e => setFactory(e.target.value)} className="w-full border rounded-lg px-3 py-2">
                    {myFactoryOptions.map(c => <option key={c} value={c}>{factoryName(c)}</option>)}
                  </select>
                </Field>
              )}
              <Field label="Month / Year"><input value={form.month_year} onChange={e => setForm({ ...form, month_year: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Date"><input type="date" value={form.record_date} onChange={e => setForm({ ...form, record_date: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Product"><input value={form.product} onChange={e => setForm({ ...form, product: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Product Batch No."><input value={form.product_batch_no} onChange={e => setForm({ ...form, product_batch_no: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Machine & condition"><input value={form.machine} onChange={e => setForm({ ...form, machine: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
            </div>

            {/* Raw material mixture */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium">Raw material &amp; qty (mixture)</label>
                <button type="button" onClick={addMat} className="text-blue-600 hover:underline text-xs">+ Add material</button>
              </div>
              <div className="space-y-2">
                {form.materials.map((m, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input value={m.item} onChange={e => setMat(i, 'item', e.target.value)} placeholder="Raw material / item" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
                    <input value={m.qty} onChange={e => setMat(i, 'qty', e.target.value)} placeholder="Qty" className="w-28 border rounded-lg px-3 py-2 text-sm" />
                    {form.materials.length > 1 && <button type="button" onClick={() => removeMat(i)} className="text-red-500 text-sm px-2">✕</button>}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Crusher condition — before"><input value={form.crusher_before} onChange={e => setForm({ ...form, crusher_before: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Crusher condition — after"><input value={form.crusher_after} onChange={e => setForm({ ...form, crusher_after: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <div />
              <Field label="Qty Rework"><input value={form.qty_rework} onChange={e => setForm({ ...form, qty_rework: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Qty Rejection"><input value={form.qty_rejection} onChange={e => setForm({ ...form, qty_rejection: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Correction action"><input value={form.correction_action} onChange={e => setForm({ ...form, correction_action: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Prepared by"><input value={form.prepared_by} onChange={e => setForm({ ...form, prepared_by: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Verified by"><input value={form.verified_by} onChange={e => setForm({ ...form, verified_by: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
              <Field label="Remark"><input value={form.remark} onChange={e => setForm({ ...form, remark: e.target.value })} className="w-full border rounded-lg px-3 py-2" /></Field>
            </div>

            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded">{error}</p>}
            <button type="submit" disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{saving ? 'Saving…' : 'Save record'}</button>
          </form>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Date', ...(isHO ? ['Factory'] : []), 'Product', 'Batch', 'Raw material & qty', 'Machine', 'Crusher B/A', 'Rework', 'Reject', 'Prepared', 'Verified', 'Remark'].map(h => (
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {records.length === 0 && <tr><td colSpan={12} className="text-center py-8 text-gray-400">No grinding records yet.</td></tr>}
              {records.map(r => (
                <tr key={r.id} className="border-b last:border-0 align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(r.record_date)}</td>
                  {isHO && <td className="px-3 py-2 whitespace-nowrap">{factoryName(r.factory_code)}</td>}
                  <td className="px-3 py-2">{r.product || '—'}</td>
                  <td className="px-3 py-2 font-mono">{r.product_batch_no || '—'}</td>
                  <td className="px-3 py-2 max-w-xs">{matSummary(r.materials)}</td>
                  <td className="px-3 py-2">{r.machine || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{(r.crusher_before || '—')} / {(r.crusher_after || '—')}</td>
                  <td className="px-3 py-2 text-right">{r.qty_rework ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{r.qty_rejection ?? '—'}</td>
                  <td className="px-3 py-2">{r.prepared_by || '—'}</td>
                  <td className="px-3 py-2">{r.verified_by || '—'}</td>
                  <td className="px-3 py-2">{r.remark || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-sm font-medium mb-1">{label}</label>{children}</div>
}
