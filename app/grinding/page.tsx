'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can } from '@/lib/permissions'
import MultiFilter from '@/components/MultiFilter'
import { requestTimerCancel } from '@/lib/corrections'

interface Recipe { id: string; factory_code: string; product: string; recipe_type: string; active: boolean }
interface Component { item: string; qty_per_lot: string }
interface Material { id?: string; item: string; qty: string; batch_no: string; added: boolean }
interface Seg { s: string; e: string | null }
interface Timer { status: 'idle' | 'running' | 'paused' | 'stopped'; segments: Seg[] }
const EMPTY_TIMER: Timer = { status: 'idle', segments: [] }
const segMs = (seg: Seg, nowMs: number) => (seg.e ? Date.parse(seg.e) : nowMs) - Date.parse(seg.s)
const totalMs = (t: Timer, nowMs: number) => t.segments.reduce((sum, seg) => sum + segMs(seg, nowMs), 0)
const pauseMs = (t: Timer, nowMs: number) => {
  let total = 0
  for (let i = 1; i < t.segments.length; i++) { const p = t.segments[i - 1].e; if (p) total += Date.parse(t.segments[i].s) - Date.parse(p) }
  if (t.status === 'paused' && t.segments.length) { const l = t.segments[t.segments.length - 1]; if (l.e) total += nowMs - Date.parse(l.e) }
  return total
}
const fmtDur = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` }
const fmtClock = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'
interface GrindingRecord {
  id: string; factory_code: string; record_date: string | null; product: string | null; recipe_type: string | null; lots: number | null
  mix_start: string | null; mix_end: string | null; mix_timer: Timer | null
  crusher_before: string | null; crusher_after: string | null; qty_rework: number | null; qty_rejection: number | null
  correction_action: string | null; prepared_by: string | null; verified_by: string | null; remark: string | null
}

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function GrindingPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'grinding')
  const [tab, setTab] = useState<'production' | 'recipes'>('production')
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [compByRecipe, setCompByRecipe] = useState<Record<string, Component[]>>({})
  const [records, setRecords] = useState<GrindingRecord[]>([])
  const [grF, setGrF] = useState<Record<string, Set<string>>>({})
  const [collapsedFacs, setCollapsedFacs] = useState<Set<string>>(new Set())
  const toggleFac = (fc: string) => setCollapsedFacs(p => { const n = new Set(p); n.has(fc) ? n.delete(fc) : n.add(fc); return n })
  const [matsByRecord, setMatsByRecord] = useState<Record<string, Material[]>>({})
  const [error, setError] = useState('')

  // Produce panel
  const [prodSearch, setProdSearch] = useState(''); const [prodLots, setProdLots] = useState(''); const [producing, setProducing] = useState(false)
  // Record (inspection) modal
  const [openRec, setOpenRec] = useState<GrindingRecord | null>(null)
  // Recipe editor modal
  const [editRecipe, setEditRecipe] = useState<Recipe | 'new' | null>(null)
  const [recipeForm, setRecipeForm] = useState<{ factory_code: string; product: string; recipe_type: string; active: boolean; components: Component[] } | null>(null)
  const [items, setItems] = useState<{ code: string; description: string | null }[]>([])
  const [saving, setSaving] = useState(false)

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'grinding', 'edit')
  const canRecipeView = can(profile, 'grinding_recipe', 'view')
  const canRecipeEdit = can(profile, 'grinding_recipe', 'edit')
  // Per-factory view-only helpers (a user may edit at some factories, view-only at others)
  const canEditFac = (fc: string) => can(profile, 'grinding', 'edit', fc)
  const canRecipeEditFac = (fc: string) => can(profile, 'grinding_recipe', 'edit', fc)
  // For the open inspection modal: edit rights at that record's factory
  const recEdit = openRec ? canEditFac(openRec.factory_code) : false
  const recRecipeEdit = openRec ? canRecipeEditFac(openRec.factory_code) : false
  const myFactoryOptions = isHO ? factories.map(f => f.code)
    : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : []))
  // Can this user create a recipe at any of their factories? (drives the New recipe button)
  const canCreateRecipe = myFactoryOptions.some(fc => canRecipeEditFac(fc))

  useEffect(() => { if (profile) { loadFactories(); load() } }, [profile])
  // Items master for the recipe pick-lists (only the mixer needs it)
  useEffect(() => { if (profile && canRecipeEdit && items.length === 0) fetchAll<{ code: string; description: string | null }>('items', 'code, description', 'code').then(setItems) }, [profile, canRecipeEdit])

  async function loadFactories() {
    const { data } = await supabase.from('factories').select('code, name').order('code'); setFactories(data || [])
  }
  async function load() {
    const [{ data: recs }, { data: recp }] = await Promise.all([
      supabase.from('grinding_records').select('*').order('record_date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }),
      supabase.from('grinding_recipes').select('*').order('product'),
    ])
    setRecords((recs as GrindingRecord[]) || [])
    setRecipes((recp as Recipe[]) || [])
    // materials per record (only returned if you have recipe view)
    const ids = ((recs as GrindingRecord[]) || []).map(r => r.id)
    if (ids.length) {
      const { data: mats } = await supabase.from('grinding_materials').select('id, grinding_record_id, item, qty, batch_no, added').in('grinding_record_id', ids)
      const map: Record<string, Material[]> = {}
      ;(mats || []).forEach(m => { (map[m.grinding_record_id] = map[m.grinding_record_id] || []).push({ id: m.id, item: m.item || '', qty: m.qty || '', batch_no: m.batch_no || '', added: !!m.added }) })
      setMatsByRecord(map)
    } else setMatsByRecord({})
    // recipe components (only returned with recipe view)
    const rids = ((recp as Recipe[]) || []).map(r => r.id)
    if (rids.length && canRecipeView) {
      const { data: comps } = await supabase.from('grinding_recipe_components').select('recipe_id, item, qty_per_lot').in('recipe_id', rids)
      const map: Record<string, Component[]> = {}
      ;(comps || []).forEach(c => { (map[c.recipe_id] = map[c.recipe_id] || []).push({ item: c.item, qty_per_lot: String(c.qty_per_lot) }) })
      setCompByRecipe(map)
    } else setCompByRecipe({})
  }

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const fmt = (d: string | null) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—' }

  async function produce() {
    setError('')
    const r = recipes.filter(x => x.active).find(x => x.product === prodSearch.trim())
    if (!r) { setError('Pick a product from the list (it must have a saved recipe).'); return }
    if (!canEditFac(r.factory_code)) { setError("You have view-only access at this factory."); return }
    setProducing(true)
    const { error } = await supabase.rpc('produce_grinding', { p_recipe_id: r.id, p_lots: Number(prodLots) })
    setProducing(false)
    if (error) { setError(error.message); return }
    setProdSearch(''); setProdLots(''); load()
  }

  // ---- inspection modal ----
  const [insp, setInsp] = useState<Record<string, string>>({})
  const [mixMats, setMixMats] = useState<Material[]>([])
  const [mixTimer, setMixTimer] = useState<Timer>(EMPTY_TIMER); const [now, setNow] = useState(Date.now())
  useEffect(() => { if (mixTimer.status !== 'running' && mixTimer.status !== 'paused') return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [mixTimer.status])
  function openRecord(r: GrindingRecord) {
    setOpenRec(r); setError('')
    setInsp({ crusher_before: r.crusher_before || '', crusher_after: r.crusher_after || '', qty_rework: r.qty_rework?.toString() ?? '', qty_rejection: r.qty_rejection?.toString() ?? '', correction_action: r.correction_action || '', prepared_by: r.prepared_by || '', verified_by: r.verified_by || '', remark: r.remark || '' })
    setMixMats((matsByRecord[r.id] || []).map(m => ({ ...m })))
    setMixTimer((r.mix_timer as Timer) || EMPTY_TIMER)
  }
  // Mix timer (recipe-edit). Persists immediately so it survives closing the modal.
  async function persistTimer(t: Timer) {
    setMixTimer(t)
    if (!openRec) return
    const start = t.segments[0]?.s || null
    const end = t.status === 'stopped' ? (t.segments[t.segments.length - 1]?.e || null) : null
    await supabase.from('grinding_records').update({ mix_timer: t, mix_start: start, mix_end: end }).eq('id', openRec.id)
  }
  const startMix = () => { const iso = new Date().toISOString(); persistTimer({ status: 'running', segments: [{ s: iso, e: null }] }) }
  const pauseMix = () => { const iso = new Date().toISOString(); persistTimer({ status: 'paused', segments: mixTimer.segments.map((sg, i) => i === mixTimer.segments.length - 1 && !sg.e ? { ...sg, e: iso } : sg) }) }
  const resumeMix = () => { const iso = new Date().toISOString(); persistTimer({ status: 'running', segments: [...mixTimer.segments, { s: iso, e: null }] }) }
  const stopMix = () => { const iso = new Date().toISOString(); persistTimer({ status: 'stopped', segments: mixTimer.segments.map((sg, i) => i === mixTimer.segments.length - 1 && !sg.e ? { ...sg, e: iso } : sg) }) }
  async function cancelMixTimer() {
    if (!openRec) return
    const res = await requestTimerCancel({ table: 'grinding_records', record_id: openRec.id, timer_key: 'grinding_mix', label: `Grinding ${openRec.product || ''} — mixing timer`, factory_code: openRec.factory_code, requested_by_name: profile?.full_name })
    if (res === null) return
    if (res) setError(res); else alert('Cancellation request sent to Head Office for approval.')
  }
  const setMixMat = (i: number, k: 'batch_no', v: string) => setMixMats(p => { const m = [...p]; m[i] = { ...m[i], [k]: v }; return m })
  const toggleMixMat = (i: number) => setMixMats(p => { const m = [...p]; m[i] = { ...m[i], added: !m[i].added }; return m })
  async function saveRecord() {
    if (!openRec) return
    const recEdit = canEditFac(openRec.factory_code), recRecipeEdit = canRecipeEditFac(openRec.factory_code)
    if (!recEdit && !recRecipeEdit) { setError("You have view-only access at this factory."); return }
    setSaving(true); setError('')
    try {
      const payload: Record<string, unknown> = {}
      if (recEdit) Object.assign(payload, {
        crusher_before: insp.crusher_before || null, crusher_after: insp.crusher_after || null,
        qty_rework: insp.qty_rework === '' ? null : Number(insp.qty_rework),
        qty_rejection: insp.qty_rejection === '' ? null : Number(insp.qty_rejection),
        correction_action: insp.correction_action || null, prepared_by: insp.prepared_by || null,
        verified_by: insp.verified_by || null, remark: insp.remark || null,
      })
      if (Object.keys(payload).length) { const { error } = await supabase.from('grinding_records').update(payload).eq('id', openRec.id); if (error) throw error }
      if (recRecipeEdit) {
        for (const m of mixMats) {
          if (!m.id) continue
          const { error } = await supabase.from('grinding_materials').update({ batch_no: m.batch_no || null, added: m.added }).eq('id', m.id)
          if (error) throw error
        }
      }
      setOpenRec(null); load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save') } finally { setSaving(false) }
  }

  // ---- recipe editor ----
  function newRecipe() { setError(''); setEditRecipe('new'); setRecipeForm({ factory_code: myFactoryOptions[0] || '', product: '', recipe_type: 'mixing', active: true, components: [{ item: '', qty_per_lot: '' }] }) }
  function openRecipe(r: Recipe) { setError(''); setEditRecipe(r); setRecipeForm({ factory_code: r.factory_code, product: r.product, recipe_type: r.recipe_type, active: r.active, components: compByRecipe[r.id]?.length ? compByRecipe[r.id] : [{ item: '', qty_per_lot: '' }] }) }
  const setComp = (i: number, k: keyof Component, v: string) => setRecipeForm(p => { if (!p) return p; const c = [...p.components]; c[i] = { ...c[i], [k]: v }; return { ...p, components: c } })
  async function saveRecipe() {
    if (!recipeForm || !canRecipeEditFac(recipeForm.factory_code)) { setError("You have view-only access to recipes at this factory."); return }
    setSaving(true); setError('')
    try {
      let rid: string
      if (editRecipe === 'new') {
        const { data: sess } = await supabase.auth.getSession()
        const { data, error } = await supabase.from('grinding_recipes').insert({ factory_code: recipeForm.factory_code, product: recipeForm.product, recipe_type: recipeForm.recipe_type, active: recipeForm.active, created_by: sess.session?.user.id || null }).select('id').single()
        if (error) throw error; rid = data.id
      } else {
        rid = (editRecipe as Recipe).id
        const { error } = await supabase.from('grinding_recipes').update({ product: recipeForm.product, recipe_type: recipeForm.recipe_type, active: recipeForm.active }).eq('id', rid)
        if (error) throw error
      }
      await supabase.from('grinding_recipe_components').delete().eq('recipe_id', rid)
      const rows = recipeForm.components.filter(c => c.item.trim()).map(c => ({ recipe_id: rid, factory_code: recipeForm.factory_code, item: c.item.trim(), qty_per_lot: c.qty_per_lot === '' ? 0 : Number(c.qty_per_lot) }))
      if (rows.length) { const { error } = await supabase.from('grinding_recipe_components').insert(rows); if (error) throw error }
      setEditRecipe(null); setRecipeForm(null); load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save') } finally { setSaving(false) }
  }
  async function deleteRecipe(r: Recipe) {
    if (!canRecipeEditFac(r.factory_code)) { setError("You have view-only access to recipes at this factory."); return }
    setError('')
    // A recipe that has been used in production can't be deleted (its records
    // must stay for traceability) — deactivate it instead so it's hidden from
    // new production but the history is preserved.
    const { count } = await supabase.from('grinding_records').select('id', { count: 'exact', head: true }).eq('recipe_id', r.id)
    if (count && count > 0) {
      if (r.active === false) { setError(`This recipe is already inactive. It can't be deleted because it has been used in ${count} production record(s).`); return }
      if (!confirm(`This recipe has been used in ${count} production record(s), so it can't be deleted (the history has to stay).\n\nDeactivate it instead? It will be hidden from new production.`)) return
      const { error } = await supabase.from('grinding_recipes').update({ active: false }).eq('id', r.id)
      if (error) { setError(error.message); return }
      load(); return
    }
    if (!confirm(`Delete recipe for ${r.product}?`)) return
    await supabase.from('grinding_recipe_components').delete().eq('recipe_id', r.id)
    const { error } = await supabase.from('grinding_recipes').delete().eq('id', r.id)
    if (error) { setError(error.message); return }
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const activeRecipes = recipes.filter(r => r.active)
  // Records table column filters (Excel-style multi-select)
  const grPass = (sel: Set<string> | undefined, v: string) => !sel || !sel.size || sel.has(v)
  const grDist = (get: (r: GrindingRecord) => string) => [...new Set(records.map(get))].filter(Boolean).sort()
  const grVal = { factory: (r: GrindingRecord) => factoryName(r.factory_code), product: (r: GrindingRecord) => r.product || '—', type: (r: GrindingRecord) => r.recipe_type || '—', verified: (r: GrindingRecord) => r.verified_by || '—' }
  const visibleRecords = records.filter(r => grPass(grF.factory, grVal.factory(r)) && grPass(grF.product, grVal.product(r)) && grPass(grF.type, grVal.type(r)) && grPass(grF.verified, grVal.verified(r)))

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Grinding &amp; Mixing</h1>
        <p className="text-gray-500 text-sm mb-4">
          {canRecipeView ? 'You can see recipes & the mixture quantities.' : 'Pick a product and number of lots — the formula is preset and hidden from your role.'}
        </p>

        {/* Tabs */}
        <div className="flex gap-2 mb-5 border-b">
          <button onClick={() => setTab('production')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'production' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}>Production</button>
          {canRecipeView && <button onClick={() => setTab('recipes')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'recipes' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}>Recipes</button>}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-4">{error}</p>}

        {tab === 'production' && (
          <>
            {canEdit && (
              <div className="bg-white rounded-xl shadow-sm border p-4 mb-5 flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Product to produce</label>
                  <input list="produce-products" value={prodSearch} onChange={e => setProdSearch(e.target.value)} placeholder="Type to search product…" className="border rounded-lg px-3 py-2 text-sm w-64" />
                  <datalist id="produce-products">
                    {activeRecipes.map(r => <option key={r.id} value={r.product}>{r.recipe_type}{isHO ? ` · ${r.factory_code}` : ''}</option>)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Number of lots</label>
                  <input value={prodLots} onChange={e => setProdLots(e.target.value)} placeholder="e.g. 5" className="border rounded-lg px-3 py-2 text-sm w-28" />
                </div>
                <button onClick={produce} disabled={producing || !prodSearch || !prodLots} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{producing ? 'Producing…' : 'Produce'}</button>
                {activeRecipes.length === 0 && <span className="text-xs text-amber-600">No recipes yet — ask the mixer to add one in the Recipes tab.</span>}
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b sticky top-0 z-10">
                  <tr>{['Date', ...(isHO ? ['Factory'] : []), 'Product', 'Type', 'Lots', 'Crusher B/A', 'Rework', 'Reject', 'Verified', ''].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                  <tr className="border-b">
                    <th className="px-2 py-1"></th>
                    {isHO && <th className="px-2 py-1 min-w-[110px]"><MultiFilter values={grDist(grVal.factory)} selected={grF.factory || new Set()} onChange={s => setGrF(p => ({ ...p, factory: s }))} /></th>}
                    <th className="px-2 py-1 min-w-[110px]"><MultiFilter values={grDist(grVal.product)} selected={grF.product || new Set()} onChange={s => setGrF(p => ({ ...p, product: s }))} /></th>
                    <th className="px-2 py-1 min-w-[90px]"><MultiFilter values={grDist(grVal.type)} selected={grF.type || new Set()} onChange={s => setGrF(p => ({ ...p, type: s }))} /></th>
                    <th className="px-2 py-1"></th><th className="px-2 py-1"></th><th className="px-2 py-1"></th><th className="px-2 py-1"></th>
                    <th className="px-2 py-1 min-w-[100px]"><MultiFilter values={grDist(grVal.verified)} selected={grF.verified || new Set()} onChange={s => setGrF(p => ({ ...p, verified: s }))} /></th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {records.length === 0 && <tr><td colSpan={11} className="text-center py-8 text-gray-400">No grinding records yet.</td></tr>}
                  {records.length > 0 && visibleRecords.length === 0 && <tr><td colSpan={11} className="text-center py-8 text-gray-400">No records match the filter.</td></tr>}
                  {!isHO && visibleRecords.map(r => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap">{fmt(r.record_date)}</td>
                      <td className="px-3 py-2">{r.product || '—'}</td>
                      <td className="px-3 py-2 capitalize">{r.recipe_type || '—'}</td>
                      <td className="px-3 py-2 text-right">{r.lots ?? '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{(r.crusher_before || '—')} / {(r.crusher_after || '—')}</td>
                      <td className="px-3 py-2 text-right">{r.qty_rework ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{r.qty_rejection ?? '—'}</td>
                      <td className="px-3 py-2">{r.verified_by || '—'}</td>
                      <td className="px-3 py-2 text-right"><button onClick={() => openRecord(r)} className="text-blue-600 hover:underline">Open</button></td>
                    </tr>
                  ))}
                  {isHO && [...new Set(visibleRecords.map(r => r.factory_code))].map(fc => {
                    const grp = visibleRecords.filter(r => r.factory_code === fc)
                    const collapsed = collapsedFacs.has(fc)
                    return (
                      <Fragment key={fc}>
                        <tr className="bg-gray-50 border-b cursor-pointer hover:bg-gray-100" onClick={() => toggleFac(fc)}>
                          <td colSpan={11} className="px-3 py-1.5 font-semibold text-gray-700"><span className="text-gray-400 mr-1">{collapsed ? '▸' : '▾'}</span>🏭 {factoryName(fc)} <span className="text-gray-400 font-normal">· {grp.length}</span></td>
                        </tr>
                        {!collapsed && grp.map(r => (
                          <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                            <td className="px-3 py-2 whitespace-nowrap">{fmt(r.record_date)}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{factoryName(r.factory_code)}</td>
                            <td className="px-3 py-2">{r.product || '—'}</td>
                            <td className="px-3 py-2 capitalize">{r.recipe_type || '—'}</td>
                            <td className="px-3 py-2 text-right">{r.lots ?? '—'}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{(r.crusher_before || '—')} / {(r.crusher_after || '—')}</td>
                            <td className="px-3 py-2 text-right">{r.qty_rework ?? '—'}</td>
                            <td className="px-3 py-2 text-right">{r.qty_rejection ?? '—'}</td>
                            <td className="px-3 py-2">{r.verified_by || '—'}</td>
                            <td className="px-3 py-2 text-right"><button onClick={() => openRecord(r)} className="text-blue-600 hover:underline">Open</button></td>
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'recipes' && canRecipeView && (
          <>
            {canCreateRecipe && <button onClick={newRecipe} className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium mb-4">+ New recipe</button>}
            <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b sticky top-0 z-10">
                  <tr>{['Product', 'Type', ...(isHO ? ['Factory'] : []), 'Ingredients (per lot)', 'Active', ''].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {recipes.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No recipes yet.</td></tr>}
                  {recipes.map(r => (
                    <tr key={r.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium">{r.product}</td>
                      <td className="px-3 py-2 capitalize">{r.recipe_type}</td>
                      {isHO && <td className="px-3 py-2">{factoryName(r.factory_code)}</td>}
                      <td className="px-3 py-2 text-xs">{(compByRecipe[r.id] || []).map((c, i) => <div key={i}>{c.item} — {c.qty_per_lot}</div>)}{!(compByRecipe[r.id]?.length) && '—'}</td>
                      <td className="px-3 py-2">{r.active ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {canRecipeEditFac(r.factory_code) && <><button onClick={() => openRecipe(r)} className="text-blue-600 hover:underline">Edit</button><button onClick={() => deleteRecipe(r)} className="text-red-600 hover:underline ml-3">Delete</button></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Inspection modal */}
      {openRec && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setOpenRec(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-2xl my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">{openRec.product} — {openRec.lots} lot(s)</h2>
            <p className="text-sm text-gray-500 mb-4">{fmt(openRec.record_date)} · {openRec.recipe_type}</p>

            <div className="mb-4 border rounded-lg p-3 bg-gray-50">
              <div className="text-sm font-semibold mb-2">Raw material &amp; qty (mixture)</div>
              {!canRecipeView ? <p className="text-sm text-gray-500 italic">🔒 Hidden from your role.</p>
                : mixMats.length === 0 ? <p className="text-sm text-gray-400">—</p> : (
                <div className="space-y-1">
                  <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 font-medium px-1">
                    <div className="col-span-5">Item</div><div className="col-span-2 text-right">Qty</div><div className="col-span-4">Batch no</div><div className="col-span-1 text-center">Added</div>
                  </div>
                  {mixMats.map((m, i) => (
                    <div key={m.id || i} className="grid grid-cols-12 gap-2 items-center text-sm">
                      <div className="col-span-5">{m.item}</div>
                      <div className="col-span-2 text-right">{m.qty}</div>
                      <div className="col-span-4">{recRecipeEdit
                        ? <input value={m.batch_no} onChange={e => setMixMat(i, 'batch_no', e.target.value)} placeholder="Batch no" className="w-full border rounded px-2 py-1 text-sm" />
                        : (m.batch_no || '—')}</div>
                      <div className="col-span-1 text-center"><input type="checkbox" checked={m.added} disabled={!recRecipeEdit} onChange={() => toggleMixMat(i)} className="h-4 w-4" /></div>
                    </div>
                  ))}
                </div>
              )}
              {canRecipeView && (
                <div className="mt-3 border-t pt-3">
                  <div className="text-sm font-semibold mb-2">Mixing time</div>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {recRecipeEdit && <>
                      {mixTimer.status === 'idle' && <button onClick={startMix} className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium">▶ Start</button>}
                      {mixTimer.status === 'running' && <>
                        <button onClick={pauseMix} className="bg-amber-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium">⏸ Pause</button>
                        <button onClick={stopMix} className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium">⏹ Stop</button>
                      </>}
                      {mixTimer.status === 'paused' && <>
                        <button onClick={resumeMix} className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium">▶ Resume</button>
                        <button onClick={stopMix} className="bg-red-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium">⏹ Stop</button>
                      </>}
                      {mixTimer.status === 'stopped' && <button onClick={startMix} className="border px-4 py-1.5 rounded-lg text-sm">↻ Restart</button>}
                    </>}
                    <span className="font-mono text-xl font-bold ml-1">{fmtDur(totalMs(mixTimer, now))}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${mixTimer.status === 'running' ? 'bg-green-100 text-green-700' : mixTimer.status === 'paused' ? 'bg-amber-100 text-amber-700' : mixTimer.status === 'stopped' ? 'bg-gray-200 text-gray-700' : 'bg-gray-100 text-gray-500'}`}>{mixTimer.status === 'idle' ? 'not started' : mixTimer.status}</span>
                    {recRecipeEdit && mixTimer.status !== 'idle' && <button onClick={cancelMixTimer} className="text-orange-600 hover:underline text-xs ml-1">Request to cancel</button>}
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                    <span>Started: {fmtClock(mixTimer.segments[0]?.s || null)}</span>
                    <span>Ended: {fmtClock(mixTimer.status === 'stopped' ? (mixTimer.segments[mixTimer.segments.length - 1]?.e || null) : null)}</span>
                    <span>Run time <span className="text-gray-400">(excl. breaks)</span>: <strong className="text-gray-700">{fmtDur(totalMs(mixTimer, now))}</strong></span>
                    <span>Pause time: <strong className="text-amber-700">{fmtDur(pauseMs(mixTimer, now))}</strong></span>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              {([['crusher_before', 'Crusher — before'], ['crusher_after', 'Crusher — after'], ['qty_rework', 'Qty Rework'], ['qty_rejection', 'Qty Rejection'], ['correction_action', 'Correction action'], ['prepared_by', 'Prepared by'], ['verified_by', 'Verified by'], ['remark', 'Remark']] as [string, string][]).map(([k, label]) => (
                <div key={k}><label className="block text-sm font-medium mb-1">{label}</label>
                  <input value={insp[k] || ''} onChange={e => setInsp(s => ({ ...s, [k]: e.target.value }))} disabled={!recEdit} className="w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" /></div>
              ))}
            </div>
            <div className="flex gap-2">
              {(recEdit || recRecipeEdit) && <button onClick={saveRecord} disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{saving ? 'Saving…' : 'Save'}</button>}
              <button onClick={() => setOpenRec(null)} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Recipe editor modal */}
      {editRecipe && recipeForm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => { setEditRecipe(null); setRecipeForm(null) }}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-2xl my-8 p-6" onClick={e => e.stopPropagation()}>
            <datalist id="grind-items">
              {items.map(it => <option key={it.code} value={`${it.code}${it.description ? ' — ' + it.description : ''}`} />)}
            </datalist>
            <h2 className="font-semibold text-lg mb-4">{editRecipe === 'new' ? 'New recipe' : 'Edit recipe'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              {editRecipe === 'new' && myFactoryOptions.length > 1 && (
                <div><label className="block text-sm font-medium mb-1">Factory</label>
                  <select value={recipeForm.factory_code} onChange={e => setRecipeForm({ ...recipeForm, factory_code: e.target.value })} className="w-full border rounded-lg px-3 py-2">{myFactoryOptions.map(c => <option key={c} value={c}>{factoryName(c)}</option>)}</select></div>
              )}
              <div><label className="block text-sm font-medium mb-1">Product</label><input list="grind-items" value={recipeForm.product} onChange={e => setRecipeForm({ ...recipeForm, product: e.target.value })} placeholder="Search code or name…" className="w-full border rounded-lg px-3 py-2" /></div>
              <div><label className="block text-sm font-medium mb-1">Type</label>
                <select value={recipeForm.recipe_type} onChange={e => setRecipeForm({ ...recipeForm, recipe_type: e.target.value })} className="w-full border rounded-lg px-3 py-2"><option value="direct">Direct</option><option value="mixing">Mixing</option></select></div>
              <label className="inline-flex items-center gap-2 text-sm self-end"><input type="checkbox" checked={recipeForm.active} onChange={e => setRecipeForm({ ...recipeForm, active: e.target.checked })} className="h-4 w-4" /> Active</label>
            </div>

            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium">Ingredients (quantity per 1 lot)</label>
                <button type="button" onClick={() => setRecipeForm({ ...recipeForm, components: [...recipeForm.components, { item: '', qty_per_lot: '' }] })} className="text-blue-600 hover:underline text-xs">+ Add ingredient</button>
              </div>
              <div className="space-y-2">
                {recipeForm.components.map((c, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input list="grind-items" value={c.item} onChange={e => setComp(i, 'item', e.target.value)} placeholder="Search code or name…" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
                    <input value={c.qty_per_lot} onChange={e => setComp(i, 'qty_per_lot', e.target.value)} placeholder="Qty / lot" className="w-32 border rounded-lg px-3 py-2 text-sm" />
                    {recipeForm.components.length > 1 && <button type="button" onClick={() => setRecipeForm({ ...recipeForm, components: recipeForm.components.filter((_, j) => j !== i) })} className="text-red-500 text-sm px-2">✕</button>}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={saveRecipe} disabled={saving || !recipeForm.product.trim()} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">{saving ? 'Saving…' : 'Save recipe'}</button>
              <button onClick={() => { setEditRecipe(null); setRecipeForm(null) }} className="border px-6 py-2 rounded-lg hover:bg-gray-50 font-medium">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
