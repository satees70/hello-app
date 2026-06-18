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

type FormState = {
  factory_code: string; month_year: string; record_date: string; product: string; product_batch_no: string
  machine: string; crusher_before: string; crusher_after: string; qty_rework: string; qty_rejection: string
  correction_action: string; prepared_by: string; verified_by: string; remark: string; materials: Material[]
}

export default function GrindingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'grinding')
  const [records, setRecords] = useState<GrindingRecord[]>([])
  const [matsByRecord, setMatsByRecord] = useState<Record<string, Material[]>>({})
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [editing, setEditing] = useState<GrindingRecord | 'new' | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'grinding', 'edit')              // inspection (QC)
  const canRecipeView = can(profile, 'grinding_recipe', 'view') // see the mixture
  const canRecipeEdit = can(profile, 'grinding_recipe', 'edit') // enter the mixture
  const myFactoryOptions = isHO
    ? factories.map(f => f.code)
    : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : []))

  useEffect(() => { if (profile) { loadFactories(); load() } }, [profile])

  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories(data || [])
  }
  async function load() {
    const { data } = await supabase.from('grinding_records').select('*')
      .order('record_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    const recs = (data as GrindingRecord[]) || []
    setRecords(recs)
    // Materials come back only if the user has the recipe permission (DB-enforced)
    if (recs.length) {
      const { data: mats } = await supabase.from('grinding_materials').select('grinding_record_id, item, qty')
        .in('grinding_record_id', recs.map(r => r.id))
      const map: Record<string, Material[]> = {}
      ;(mats || []).forEach(m => { (map[m.grinding_record_id] = map[m.grinding_record_id] || []).push({ item: m.item || '', qty: m.qty || '' }) })
      setMatsByRecord(map)
    } else setMatsByRecord({})
  }

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c

  function openNew() {
    setError(''); setEditing('new')
    setForm({
      factory_code: myFactoryOptions[0] || '', month_year: thisMonthYear(), record_date: todayLocal(),
      product: '', product_batch_no: '', machine: '', crusher_before: '', crusher_after: '',
      qty_rework: '', qty_rejection: '', correction_action: '', prepared_by: '', verified_by: '', remark: '',
      materials: [{ item: '', qty: '' }],
    })
  }
  function openEdit(r: GrindingRecord) {
    setError(''); setEditing(r)
    setForm({
      factory_code: r.factory_code, month_year: r.month_year || '', record_date: r.record_date || '',
      product: r.product || '', product_batch_no: r.product_batch_no || '', machine: r.machine || '',
      crusher_before: r.crusher_before || '', crusher_after: r.crusher_after || '',
      qty_rework: r.qty_rework?.toString() ?? '', qty_rejection: r.qty_rejection?.toString() ?? '',
      correction_action: r.correction_action || '', prepared_by: r.prepared_by || '', verified_by: r.verified_by || '', remark: r.remark || '',
      materials: matsByRecord[r.id]?.length ? matsByRecord[r.id] : [{ item: '', qty: '' }],
    })
  }
  function close() { setEditing(null); setForm(null) }

  const upd = (k: keyof FormState, v: string) => setForm(p => p ? { ...p, [k]: v } : p)
  const setMat = (i: number, k: keyof Material, v: string) => setForm(p => { if (!p) return p; const m = [...p.materials]; m[i] = { ...m[i], [k]: v }; return { ...p, materials: m } })
  const addMat = () => setForm(p => p ? { ...p, materials: [...p.materials, { item: '', qty: '' }] } : p)
  const removeMat = (i: number) => setForm(p => p ? { ...p, materials: p.materials.filter((_, j) => j !== i) } : p)

  async function save() {
    if (!form) return
    setSaving(true); setError('')
    const isNew = editing === 'new'
    // Inspection fields anyone with grinding edit may set
    const inspection = {
      crusher_before: form.crusher_before || null, crusher_after: form.crusher_after || null,
      qty_rework: form.qty_rework === '' ? null : Number(form.qty_rework),
      qty_rejection: form.qty_rejection === '' ? null : Number(form.qty_rejection),
      correction_action: form.correction_action || null, prepared_by: form.prepared_by || null,
      verified_by: form.verified_by || null, remark: form.remark || null,
    }
    // Header fields only an operator (recipe edit) may set
    const header = {
      month_year: form.month_year || null, record_date: form.record_date || null,
      product: form.product || null, product_batch_no: form.product_batch_no || null, machine: form.machine || null,
    }
    try {
      let recordId: string
      if (isNew) {
        const { data: sess } = await supabase.auth.getSession()
        const { data, error } = await supabase.from('grinding_records')
          .insert({ factory_code: form.factory_code, ...header, ...inspection, created_by: sess.session?.user.id || null })
          .select('id').single()
        if (error) throw error
        recordId = data.id
      } else {
        const rec = editing as GrindingRecord
        recordId = rec.id
        const payload = canRecipeEdit ? { ...header, ...inspection } : inspection
        const { error } = await supabase.from('grinding_records').update(payload).eq('id', recordId)
        if (error) throw error
      }
      // Mixture is written only by recipe-edit users (DB also enforces this)
      if (canRecipeEdit) {
        await supabase.from('grinding_materials').delete().eq('grinding_record_id', recordId)
        const rows = form.materials.filter(m => m.item.trim() || m.qty.trim())
          .map(m => ({ grinding_record_id: recordId, factory_code: form.factory_code, item: m.item.trim() || null, qty: m.qty.trim() || null }))
        if (rows.length) { const { error } = await supabase.from('grinding_materials').insert(rows); if (error) throw error }
      }
      close(); load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save')
    } finally { setSaving(false) }
  }

  const fmt = (d: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }
  const matSummary = (id: string) => { const m = matsByRecord[id]; return m && m.length ? m.map(x => `${x.item}${x.qty ? ` (${x.qty})` : ''}`).join(', ') : (canRecipeView ? '—' : '🔒 hidden') }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold">Grinding &amp; Mixing Record</h1>
          {canEdit && canRecipeEdit && (
            <button onClick={openNew} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">+ New record</button>
          )}
        </div>
        <p className="text-gray-500 text-sm mb-5">
          Controlled form P07-F10.{' '}
          {canRecipeView ? 'You can see the raw-material mixture.' : 'The raw-material mixture is hidden from your role — you fill the inspection only.'}
        </p>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Date', ...(isHO ? ['Factory'] : []), 'Product', 'Batch', 'Raw material & qty', 'Machine', 'Crusher B/A', 'Rework', 'Reject', 'Verified', ''].map(h => (
                <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {records.length === 0 && <tr><td colSpan={12} className="text-center py-8 text-gray-400">No grinding records yet.</td></tr>}
              {records.map(r => (
                <tr key={r.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap">{fmt(r.record_date)}</td>
                  {isHO && <td className="px-3 py-2 whitespace-nowrap">{factoryName(r.factory_code)}</td>}
                  <td className="px-3 py-2">{r.product || '—'}</td>
                  <td className="px-3 py-2 font-mono">{r.product_batch_no || '—'}</td>
                  <td className={`px-3 py-2 max-w-xs ${!canRecipeView ? 'text-gray-400 italic' : ''}`}>{matSummary(r.id)}</td>
                  <td className="px-3 py-2">{r.machine || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{(r.crusher_before || '—')} / {(r.crusher_after || '—')}</td>
                  <td className="px-3 py-2 text-right">{r.qty_rework ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{r.qty_rejection ?? '—'}</td>
                  <td className="px-3 py-2">{r.verified_by || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {canEdit ? <button onClick={() => openEdit(r)} className="text-blue-600 hover:underline">Open</button>
                             : <button onClick={() => openEdit(r)} className="text-blue-600 hover:underline">View</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Editor modal */}
      {editing && form && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={close}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-3xl my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-4">{editing === 'new' ? 'New grinding record' : 'Grinding record'}</h2>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              {editing === 'new' && myFactoryOptions.length > 1 && (
                <F label="Factory"><select value={form.factory_code} onChange={e => upd('factory_code', e.target.value)} className="w-full border rounded-lg px-3 py-2">{myFactoryOptions.map(c => <option key={c} value={c}>{factoryName(c)}</option>)}</select></F>
              )}
              <F label="Month / Year"><In v={form.month_year} on={v => upd('month_year', v)} ro={!canRecipeEdit} /></F>
              <F label="Date"><input type="date" value={form.record_date} onChange={e => upd('record_date', e.target.value)} disabled={!canRecipeEdit} className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" /></F>
              <F label="Product"><In v={form.product} on={v => upd('product', v)} ro={!canRecipeEdit} /></F>
              <F label="Product Batch No."><In v={form.product_batch_no} on={v => upd('product_batch_no', v)} ro={!canRecipeEdit} /></F>
              <F label="Machine & condition"><In v={form.machine} on={v => upd('machine', v)} ro={!canRecipeEdit} /></F>
            </div>

            {/* Raw material mixture — recipe */}
            <div className="mb-4 border rounded-lg p-3 bg-gray-50">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-semibold">Raw material &amp; qty (mixture)</label>
                {canRecipeEdit && <button type="button" onClick={addMat} className="text-blue-600 hover:underline text-xs">+ Add material</button>}
              </div>
              {!canRecipeView ? (
                <p className="text-sm text-gray-500 italic">🔒 The raw-material mixture is hidden from your role.</p>
              ) : canRecipeEdit ? (
                <div className="space-y-2">
                  {form.materials.map((m, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input value={m.item} onChange={e => setMat(i, 'item', e.target.value)} placeholder="Raw material / item" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
                      <input value={m.qty} onChange={e => setMat(i, 'qty', e.target.value)} placeholder="Qty" className="w-28 border rounded-lg px-3 py-2 text-sm" />
                      {form.materials.length > 1 && <button type="button" onClick={() => removeMat(i)} className="text-red-500 text-sm px-2">✕</button>}
                    </div>
                  ))}
                </div>
              ) : (
                <ul className="text-sm list-disc pl-5">
                  {form.materials.filter(m => m.item || m.qty).map((m, i) => <li key={i}>{m.item}{m.qty ? ` — ${m.qty}` : ''}</li>)}
                  {form.materials.filter(m => m.item || m.qty).length === 0 && <li className="list-none text-gray-400">—</li>}
                </ul>
              )}
            </div>

            {/* Inspection — QC */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              <F label="Crusher — before"><In v={form.crusher_before} on={v => upd('crusher_before', v)} ro={!canEdit} /></F>
              <F label="Crusher — after"><In v={form.crusher_after} on={v => upd('crusher_after', v)} ro={!canEdit} /></F>
              <div />
              <F label="Qty Rework"><In v={form.qty_rework} on={v => upd('qty_rework', v)} ro={!canEdit} /></F>
              <F label="Qty Rejection"><In v={form.qty_rejection} on={v => upd('qty_rejection', v)} ro={!canEdit} /></F>
              <F label="Correction action"><In v={form.correction_action} on={v => upd('correction_action', v)} ro={!canEdit} /></F>
              <F label="Prepared by"><In v={form.prepared_by} on={v => upd('prepared_by', v)} ro={!canEdit} /></F>
              <F label="Verified by"><In v={form.verified_by} on={v => upd('verified_by', v)} ro={!canEdit} /></F>
              <F label="Remark"><In v={form.remark} on={v => upd('remark', v)} ro={!canEdit} /></F>
            </div>

            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
            <div className="flex gap-2">
              {canEdit && <button onClick={save} disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{saving ? 'Saving…' : 'Save'}</button>}
              <button onClick={close} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-sm font-medium mb-1">{label}</label>{children}</div>
}
function In({ v, on, ro }: { v: string; on: (v: string) => void; ro?: boolean }) {
  return <input value={v} onChange={e => on(e.target.value)} disabled={ro} className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500" />
}
