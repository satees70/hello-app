'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, hasCap } from '@/lib/permissions'
import { fetchTomorrowDeliverySOs } from '@/lib/delivery'
import ItemPicker from '@/components/ItemPicker'

interface BatchItem { id: string; customer_name: string; so_number: string; quantity: number; line_id: string | null }
interface Batch {
  id: string
  is_grinding?: boolean
  batch_no: string
  item_code: string
  description: string
  delivery_date: string
  factory_code: string
  total_quantity: number
  produced_qty: number
  status: string
  material_request_id: string | null
  pack_line: string | null
  pack_date: string | null
  run_mode: string | null
  no_combine?: boolean
  production_batch_items: BatchItem[]
}
interface ConsRow { id: string; item_code: string; description: string | null; batch_no: string | null; exp_date: string | null; qty_consumed: number; consumed_at: string }
interface Item { id: string; code: string; description: string; unit: string; type: string; supplied_by_factory?: boolean; stock_code?: string | null }
interface BomComp { parent_item_id: string; component_item_id: string; quantity: number; apply_allowance: boolean; use_mode: string }

// A materials target: a single batch or a combined group of batches (same item + factory)
interface MatTarget { label: string; item_code: string; factory_code: string; total: number; batchIds: string[]; mode: string }

const STATUSES = ['Planned', 'Requested', 'In Progress', 'Completed'] as const
const FILTERS = ['All', ...STATUSES] as const
type Filter = typeof FILTERS[number]

const STATUS_STYLE: Record<string, string> = {
  Planned: 'bg-blue-100 text-blue-700',
  Requested: 'bg-indigo-100 text-indigo-700',
  'In Progress': 'bg-amber-100 text-amber-700',
  Completed: 'bg-green-100 text-green-700',
}
// Bag/carton → loose code + KG-per-bag (same rules as Receiving). e.g. S852-K-20KG/BAG → S852-K, 20.
const PACK = 'BAG|CTN|CARTON'
const looseCode = (code: string) => code.replace(new RegExp(`[-\\s]*\\d+(?:\\.\\d+)?\\s*KG\\s*\\/\\s*(?:${PACK})\\s*$`, 'i'), '').trim()
const kgPerBagOf = (code: string, desc: string) => { const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*KG\\s*\\/\\s*(?:${PACK})`, 'i').exec(`${code} ${desc || ''}`); return m ? Number(m[1]) : null }

export default function ProductionPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'order_board')
  const canEdit = profile ? can(profile, 'order_board', 'edit') : false
  const canEditFac = (fc: string) => can(profile, 'order_board', 'edit', fc)   // honours per-factory view-only
  const [batches, setBatches] = useState<Batch[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [boms, setBoms] = useState<BomComp[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<Filter>('All')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [selected, setSelected] = useState<MatTarget | null>(null)
  const [reqCreator, setReqCreator] = useState('')   // who raised the open request for the selected batch
  const [reqNo, setReqNo] = useState('')             // its request number (for easy lookup)
  useEffect(() => {
    setReqCreator(''); setReqNo('')
    if (!selected) return
    const b = batches.find(x => selected.batchIds.includes(x.id) && x.material_request_id)
    if (!b?.material_request_id) return
    supabase.from('material_requests').select('created_by_name, request_no, pick_run_no').eq('id', b.material_request_id).maybeSingle()
      .then(({ data }) => { setReqCreator((data?.created_by_name as string) || ''); setReqNo((data?.pick_run_no as string) || (data?.request_no as string) || '') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedFacs, setCollapsedFacs] = useState<Set<string>>(new Set())
  const toggleFac = (fc: string) => setCollapsedFacs(p => { const n = new Set(p); n.has(fc) ? n.delete(fc) : n.add(fc); return n })
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [factoryFilter, setFactoryFilter] = useState('')
  const [raising, setRaising] = useState(false)
  // Ad-hoc material editing in the modal (same code can need different packaging per order)
  const [adhoc, setAdhoc] = useState(false)
  const [customRows, setCustomRows] = useState<{ code: string; description: string; unit: string; qty: string }[]>([])
  const [addMat, setAddMat] = useState<{ code: string; description: string; unit: string } | null>(null)
  const [addMatQty, setAddMatQty] = useState('')
  const [extra, setExtra] = useState('')   // extra units to make for stock (beyond the order)
  const [stockReqs, setStockReqs] = useState<{ id: string; request_no: string; pick_run_no: string | null; extra_qty: number; status: string; created_at: string; batch_id: string; production_batches: { item_code: string; factory_code: string } | null }[]>([])
  const [combineOn, setCombineOn] = useState(true)
  const [tomorrowOnly, setTomorrowOnly] = useState(false)
  const [sortBy, setSortBy] = useState<'due_asc' | 'due_desc' | 'batch'>('due_asc')
  const [search, setSearch] = useState('')
  const [grindingMode, setGrindingMode] = useState(false)   // false = Order Board, true = Grinding Board
  const [grindingLineIds, setGrindingLineIds] = useState<Set<string>>(new Set())
  const [recipes, setRecipes] = useState<{ id: string; product: string; factory_code: string }[]>([])
  const [recipeComps, setRecipeComps] = useState<Record<string, { code: string; description: string; qty_per_lot: number }[]>>({})
  const [consumption, setConsumption] = useState<Record<string, ConsRow[]>>({}) // batch id -> consumed lots

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  const [tomorrowSOs, setTomorrowSOs] = useState<Set<string>>(new Set())
  const dueTomorrow = (b: Batch) => (b.production_batch_items || []).some(it => it.so_number && tomorrowSOs.has(it.so_number))
  useEffect(() => { if (profile) { loadAll(); fetchTomorrowDeliverySOs().then(setTomorrowSOs) } }, [profile])
  useEffect(() => { if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('board') === 'grinding') setGrindingMode(true) }, [])

  async function loadAll() {
    const [{ data: b }, { data: f }, it, bc, { data: st }] = await Promise.all([
      supabase.from('production_batches').select('*, production_batch_items(id, customer_name, so_number, quantity, line_id)').order('created_at', { ascending: false }),
      supabase.from('factories').select('code, name').order('code'),
      fetchAll<Item>('items', 'id, code, description, unit, type, supplied_by_factory, stock_code'),
      fetchAll<BomComp>('bom_components', 'parent_item_id, component_item_id, quantity, apply_allowance, use_mode'),
      supabase.from('item_stock').select('item_id, factory_code, quantity'),
    ])
    setBatches(((b as Batch[]) || []).filter(x => x.status !== 'Bypassed'))   // bypassed = marked completed by hand → off the board
    const { data: gl } = await supabase.from('sales_order_lines').select('id').eq('is_grinding', true)
    setGrindingLineIds(new Set((gl || []).map(x => x.id)))
    const { data: gr } = await supabase.from('grinding_recipes').select('id, product, factory_code, active').eq('active', true)
    setRecipes((gr || []).map(r => ({ id: r.id, product: r.product, factory_code: r.factory_code })))
    const rids = (gr || []).map(r => r.id)
    if (rids.length) {
      const { data: gc } = await supabase.from('grinding_recipe_components').select('recipe_id, item, qty_per_lot').in('recipe_id', rids)
      const m: Record<string, { code: string; description: string; qty_per_lot: number }[]> = {}
      ;(gc || []).forEach(c => { const code = String(c.item || '').split(' — ')[0].trim(); const desc = String(c.item || '').split(' — ').slice(1).join(' — ').trim(); (m[c.recipe_id] = m[c.recipe_id] || []).push({ code, description: desc, qty_per_lot: Number(c.qty_per_lot || 0) }) })
      setRecipeComps(m)
    } else setRecipeComps({})
    setFactories(f || [])
    setItems(it)
    setBoms(bc)
    const sm: Record<string, number> = {}
    ;(st || []).forEach(r => { sm[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setStock(sm)
    // Open requests that included extra-for-stock — to warn before requesting again
    const { data: sr } = await supabase.from('material_requests')
      .select('id, request_no, pick_run_no, extra_qty, status, created_at, batch_id, production_batches!batch_id(item_code, factory_code)')
      .gt('extra_qty', 0).in('status', ['Open', 'Partially Received'])
    setStockReqs((sr as unknown as typeof stockReqs) || [])
  }

  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code || '—'
  const clean = (n: number) => Number(n.toFixed(3))
  const BUFFER = 1.1
  const GRIND_LOSS = 0.10   // ~10% loss per grinding lot, so 1 lot yields 90% of the recipe input

  async function makeManufactured(it: Item) {
    if (!can(profile, 'items', 'edit')) { setError("You have view-only access to Items."); return }
    if (!confirm(`Change ${it.code} to a Manufactured item? You can then set its BOM recipe.`)) return
    setError(''); setSuccess('')
    const { error: upErr } = await supabase.from('items').update({ type: 'Manufactured' }).eq('id', it.id)
    if (upErr) { setError(upErr.message); return }
    setItems(prev => prev.map(x => (x.id === it.id ? { ...x, type: 'Manufactured' } : x)))
    setSuccess(`${it.code} is now Manufactured — add its BOM next (Create BOM).`)
  }

  // Flag batches whose item can't be exploded into materials, with HO quick-actions
  function bomBadge(itemCode: string) {
    // Grinding: the formula is a RECIPE on the loose code.
    if (grindingMode) {
      const loose = looseCode(itemCode)
      const li = items.find(i => i.code === loose)
      if (recipeFor(loose, li?.description)) return null
      return (
        <span className="mt-0.5 inline-flex items-center gap-2">
          <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[11px] font-medium">⚠ No recipe set ({loose})</span>
          {can(profile, 'grinding_recipe', 'edit') && <a href="/grinding" className="text-blue-600 hover:underline text-[11px]">Create recipe →</a>}
        </span>
      )
    }
    const it = items.find(i => i.code === itemCode)
    if (!it) return <span className="inline-block mt-0.5 bg-red-100 text-red-700 px-1.5 py-0.5 rounded text-[11px] font-medium">⚠ Not in Items Master</span>
    if (it.type !== 'Manufactured') {
      if (!can(profile, 'items', 'edit')) return null
      return <button onClick={() => makeManufactured(it)} className="mt-0.5 inline-block text-blue-600 hover:underline text-[11px]">Set as Manufactured</button>
    }
    if (boms.some(b => b.parent_item_id === it.id)) return null
    return (
      <span className="mt-0.5 inline-flex items-center gap-2">
        <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[11px] font-medium">⚠ No BOM set</span>
        {can(profile, 'bom', 'edit') && <a href={`/admin/bom?item=${encodeURIComponent(it.code)}`} className="text-blue-600 hover:underline text-[11px]">Create BOM →</a>}
      </span>
    )
  }

  // Status is automatic — derived from the workflow, never set by hand:
  // produced fully → Completed; some produced → In Progress; request raised → Requested; else Planned.
  function derivedStatus(b: Batch): string {
    const produced = Number(b.produced_qty || 0)
    if (produced >= b.total_quantity && b.total_quantity > 0) return 'Completed'
    if (produced > 0) return 'In Progress'
    if (b.material_request_id) return 'Requested'
    return 'Planned'
  }

  // The loose/recipe code for a grinding item: the item's Stock code if set (e.g. S246-WP → S246),
  // otherwise strip the bag suffix (S852-K-20KG/BAG → S852-K). Same mapping Goods Received uses.
  const grindProductCode = (itemCode: string) => { const it = items.find(i => i.code === itemCode); return (it?.stock_code && it.stock_code.trim()) || looseCode(itemCode) }

  // Find the grinding recipe for a (loose) product — match by product code/description; prefer same factory.
  function recipeFor(code: string, description: string | undefined, factory?: string) {
    const ic = (code || '').trim().toLowerCase(), dc = (description || '').trim().toLowerCase()
    const codeOf = (s: string) => (s || '').split(' — ')[0].trim().toLowerCase()
    const descOf = (s: string) => (s || '').split(' — ').slice(1).join(' — ').trim().toLowerCase()
    const m = (r: { product: string }) => codeOf(r.product) === ic || (!!dc && descOf(r.product) === dc) || (r.product || '').trim().toLowerCase() === ic
    return (factory && recipes.find(r => r.factory_code === factory && m(r))) || recipes.find(m) || null
  }

  // Explode a BOM for a given item/factory/quantity
  function explode(itemCode: string, factoryCode: string, total: number, mode = 'auto') {
    // Grinding: a bag SKU uses its LOOSE code's RECIPE × the bag weight (e.g. 1 × 25KG/BAG = 25kg of S246).
    if (grindingMode) {
      const bag = items.find(i => i.code === itemCode)
      const factor = kgPerBagOf(itemCode, bag?.description || '') ?? 1
      const loose = looseCode(itemCode)
      const li = items.find(i => i.code === loose)
      const rec = recipeFor(loose, li?.description, factoryCode)
      if (!rec) return { note: `No grinding recipe for ${loose} — create one in Grinding → Recipes.`, rows: [], labels: [] as { code: string; description: string; unit: string; required: number }[] }
      const comps = recipeComps[rec.id] || []
      if (!comps.length) return { note: 'This grinding recipe has no materials.', rows: [], labels: [] as { code: string; description: string; unit: string; required: number }[] }
      // One lot uses the full recipe; its usable yield is the recipe input minus 10% loss.
      const lotInput = comps.reduce((s, c) => s + (c.qty_per_lot || 0), 0)   // e.g. 100 + 50 = 150
      const lotYield = lotInput * (1 - GRIND_LOSS)                            // 150 × 0.9 = 135 kg
      const orderKg = total * factor                                         // bags × kg-per-bag (incl. extra)
      const lots = lotYield > 0 ? Math.max(1, Math.ceil(orderKg / lotYield)) : 1
      const rows = comps.map((c, i) => {
        const ci = items.find(x => x.code === c.code)
        const required = c.qty_per_lot * lots                                // whole lots × recipe
        const id = ci?.id || c.code
        const st = ci?.id ? (stock[`${id}|${factoryCode}`] ?? 0) : 0
        const shortfall = Math.max(required - st, 0)
        return { item_id: id, key: `${id}|${factoryCode}|${i}`, code: c.code, description: ci?.description || c.description, unit: ci?.unit || '', required, stock: st, shortfall, requested: clean(shortfall) }
      })
      return { note: '', rows, labels: [] as { code: string; description: string; unit: string; required: number }[], lots, orderKg: clean(orderKg), lotYield: clean(lotYield) }
    }
    const parent = items.find(i => i.code === itemCode)
    if (!parent) return { note: `Item ${itemCode} is not in Items Master.`, rows: [], labels: [] as { code: string; description: string; unit: string; required: number }[] }
    const all = boms.filter(b => b.parent_item_id === parent.id)
    if (all.length === 0) return { note: 'No BOM defined for this item. Add a recipe in BOM first.', rows: [], labels: [] as { code: string; description: string; unit: string; required: number }[] }
    const isLabel = (id: string) => !!items.find(i => i.id === id)?.supplied_by_factory
    const inMode = (b: BomComp) => (b.use_mode || 'any') === 'any' || (b.use_mode || 'any') === mode
    // Labels are printed at the factory (not requested from the warehouse) — listed separately
    const labels = all.filter(b => isLabel(b.component_item_id) && inMode(b)).map(c => {
      const ci = items.find(i => i.id === c.component_item_id)
      return { code: ci?.code || '—', description: ci?.description || '', unit: ci?.unit || '', required: c.quantity * total }
    })
    const allWh = all.filter(b => !isLabel(b.component_item_id))
    const comps = allWh.filter(inMode)
    if (comps.length === 0) return { note: allWh.length === 0 ? 'This item only has made-at-factory labels — nothing to request from the warehouse.' : `This item's BOM has no warehouse materials for ${mode === 'manual' ? 'Manual' : 'Auto machine'} mode. Switch the Run mode above (or add ${mode} components in BOM).`, rows: [], labels }
    const rows = comps.map(c => {
      const ci = items.find(i => i.id === c.component_item_id)
      const required = c.quantity * total
      const key = `${c.component_item_id}|${factoryCode}`
      const st = stock[key] ?? 0
      const shortfall = Math.max(required - st, 0)
      const requested = c.apply_allowance ? Math.ceil(shortfall * BUFFER) : clean(shortfall)
      return { item_id: c.component_item_id, key, code: ci?.code || '—', description: ci?.description || '', unit: ci?.unit || '', required, stock: st, shortfall, requested }
    })
    return { note: '', rows, labels }
  }

  async function raiseTarget(t: MatTarget) {
    if (!canEditFac(t.factory_code)) { setError("You have view-only access at this factory."); return }
    setRaising(true); setError(''); setSuccess('')
    // Save the chosen run mode onto the batch(es) first — the RPC uses run_mode to
    // pick the right BOM (auto = roll, manual = pc). Expiry is set later on the label.
    const { error: expErr } = await supabase.from('production_batches')
      .update({ run_mode: t.mode }).in('id', t.batchIds)
    if (expErr) { setError(expErr.message); setRaising(false); return }
    const { error: rpcErr } = t.batchIds.length === 1
      ? await supabase.rpc('raise_material_request', { p_batch_id: t.batchIds[0] })
      : await supabase.rpc('raise_combined_material_request', { p_batch_ids: t.batchIds })
    if (rpcErr) { setError(rpcErr.message); setRaising(false); return }
    const sentBatches = t.batchIds.map(id => batches.find(b => b.id === id)?.batch_no || id).join(' + ')
    setSuccess(`Material request raised for ${t.label} — sent ${t.batchIds.length} batch(es): ${sentBatches} (total ${t.total}).`)
    setRaising(false)
    setSelected(null)
    await loadAll()
  }

  function closeMatModal() { setSelected(null); setAdhoc(false); setCustomRows([]); setAddMat(null); setAddMatQty(''); setExtra('') }
  // Raise a request from explicit lines, recording any extra-for-stock + a note
  async function raiseExt(t: MatTarget, lines: { code: string; description: string; unit: string; qty: number }[], extraQty: number, note: string | null) {
    if (!canEditFac(t.factory_code)) { setError("You have view-only access at this factory."); return }
    const items = lines.filter(i => i.code && i.qty > 0)
    if (items.length === 0) { setError('Add at least one material with a quantity.'); return }
    setRaising(true); setError(''); setSuccess('')
    const { error: expErr } = await supabase.from('production_batches').update({ run_mode: t.mode }).in('id', t.batchIds)
    if (expErr) { setError(expErr.message); setRaising(false); return }
    const { error: rpcErr } = await supabase.rpc('raise_material_request_ext', { p_batch_ids: t.batchIds, p_items: items, p_extra: extraQty, p_note: note })
    if (rpcErr) { setError(rpcErr.message); setRaising(false); return }
    setSuccess(`Material request raised for ${t.label}${extraQty > 0 ? ` (+${extraQty} extra for stock)` : ''}.`)
    setRaising(false); closeMatModal(); await loadAll()
  }
  function addCustomRow() {
    if (!addMat) { setError('Pick a material to add.'); return }
    const q = Number(addMatQty)
    if (!(q > 0)) { setError('Enter a quantity for the material.'); return }
    setError('')
    setCustomRows(prev => { const i = prev.findIndex(r => r.code === addMat.code); if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], qty: String(q) }; return n } return [...prev, { code: addMat.code, description: addMat.description, unit: addMat.unit, qty: String(q) }] })
    setAddMat(null); setAddMatQty('')
  }
  // Raise with the (possibly edited) ad-hoc material lines for this order
  const toggleRow = (id: string) => setExpanded(prev => {
    const n = new Set(prev); const had = n.has(id); had ? n.delete(id) : n.add(id)
    if (!had && !id.startsWith('combo:') && !consumption[id]) loadConsumption(id) // load consumed batches on expand
    return n
  })
  async function requestUncombine(m: Batch) {
    if (!canEditFac(m.factory_code)) { setError("You have view-only access at this factory."); return }
    const reason = window.prompt(`Run ${m.batch_no} (${m.item_code} · qty ${m.total_quantity}) on its own, separate from the combined group?\n\nThis goes to Pending Changes for Head Office approval.\n\nReason (optional):`, '')
    if (reason === null) return
    setError(''); setSuccess('')
    const { error: insErr } = await supabase.from('split_requests').insert({
      kind: 'uncombine', batch_id: m.id, factory_code: m.factory_code,
      label: `Un-combine ${m.batch_no} · ${m.item_code} · qty ${m.total_quantity}`,
      reason: reason || null, requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    })
    if (insErr) { setError(insErr.message); alert('Could not request:\n\n' + insErr.message); return }
    setSuccess(`Requested to run ${m.batch_no} on its own — waiting for Head Office approval.`)
    alert(`Requested to run ${m.batch_no} on its own.\nGo to Pending Changes → Batch splits for Head Office to approve.`)
  }

  // Shortcut for old orders: mark a batch produced/completed, bypassing material-request & inspection steps.
  async function markCompleted(b: Batch) {
    if (!canEditFac(b.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!confirm(`Mark ${b.batch_no} (${b.item_code} · qty ${b.total_quantity}) as COMPLETED, skipping the material request and inspection steps?\n\nUse this only for old orders that were handled outside the system.`)) return
    setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('mark_batch_completed', { p_batch_id: b.id })
    if (e) { setError(e.message); return }
    setSuccess(`${b.batch_no} marked completed (bypass) — removed from the board.`)
    loadAll()
  }

  async function recombine(b: Batch) {
    if (!canEditFac(b.factory_code)) { setError("You have view-only access at this factory."); return }
    if (!confirm(`Re-combine ${b.batch_no} back into its group for material picking?`)) return
    setError(''); setSuccess('')
    const { error: e } = await supabase.from('production_batches').update({ no_combine: false }).eq('id', b.id)
    if (e) { setError(e.message); return }
    setBatches(prev => prev.map(x => (x.id === b.id ? { ...x, no_combine: false } : x)))
    setSuccess(`${b.batch_no} re-combined.`)
  }

  async function requestSplit(b: Batch, it: BatchItem) {
    if (!canEditFac(b.factory_code)) { setError("You have view-only access at this factory."); return }
    const reason = window.prompt(`Split "${it.customer_name}" (${it.so_number || ''} · qty ${it.quantity}) out of ${b.batch_no} into its own batch?\n\nThis goes to Pending Changes for Head Office approval.\n\nReason (optional):`, '')
    if (reason === null) return
    setError(''); setSuccess('')
    const { error: insErr } = await supabase.from('split_requests').insert({
      batch_item_id: it.id, batch_id: b.id, factory_code: b.factory_code,
      label: `${b.batch_no} · ${b.item_code} — ${it.customer_name}${it.so_number ? ' · ' + it.so_number : ''} · qty ${it.quantity}`,
      reason: reason || null, requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    })
    if (insErr) { setError(insErr.message); alert('Could not request split:\n\n' + insErr.message); return }
    setSuccess(`Split requested for ${it.customer_name} — waiting for Head Office approval.`)
    alert(`Split requested for ${it.customer_name}.\nGo to Pending Changes → Batch splits for Head Office to approve.`)
  }

  async function loadConsumption(batchId: string) {
    const { data } = await supabase.from('production_consumption')
      .select('id, item_code, description, batch_no, exp_date, qty_consumed, consumed_at')
      .eq('production_batch_id', batchId).order('consumed_at')
    setConsumption(prev => ({ ...prev, [batchId]: (data as ConsRow[]) || [] }))
  }


  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const dateKey = (d: string) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(d || '')
    return m ? new Date(2000 + +m[3], +m[2] - 1, +m[1]).getTime() : Number.MAX_SAFE_INTEGER
  }
  const fromTs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null
  const toTs = dateTo ? new Date(dateTo + 'T00:00:00').getTime() : null
  // A batch belongs to grinding if its line is tagged grinding (or the batch itself is flagged).
  const isGrindingBatch = (b: Batch) => !!b.is_grinding || (b.production_batch_items || []).some(it => it.line_id && grindingLineIds.has(it.line_id))
  // Each board sees only its own batches: Grinding board = grinding ones; Order Board = the rest.
  const boardBatches = batches.filter(b => grindingMode ? isGrindingBatch(b) : !isGrindingBatch(b))
  let shown = filter === 'All' ? boardBatches : boardBatches.filter(b => derivedStatus(b) === filter)
  if (fromTs !== null) shown = shown.filter(b => { const k = dateKey(b.delivery_date); return k !== Number.MAX_SAFE_INTEGER && k >= fromTs })
  if (toTs !== null) shown = shown.filter(b => { const k = dateKey(b.delivery_date); return k !== Number.MAX_SAFE_INTEGER && k <= toTs })
  if (isHO && factoryFilter) shown = shown.filter(b => b.factory_code === factoryFilter)
  if (tomorrowOnly) shown = shown.filter(dueTomorrow)
  const sq = search.trim().toLowerCase()
  if (sq) shown = shown.filter(b =>
    (b.item_code || '').toLowerCase().includes(sq) ||
    (b.description || '').toLowerCase().includes(sq) ||
    (b.batch_no || '').toLowerCase().includes(sq) ||
    (b.production_batch_items || []).some(it => (it.so_number || '').toLowerCase().includes(sq) || (it.customer_name || '').toLowerCase().includes(sq)))
  const tomorrowCount = boardBatches.filter(dueTomorrow).length
  const counts: Record<string, number> = { Planned: 0, Requested: 0, 'In Progress': 0, Completed: 0 }
  boardBatches.forEach(b => { const st = derivedStatus(b); counts[st] = (counts[st] || 0) + 1 })
  const grindingCount = batches.filter(isGrindingBatch).length

  const extraN = Math.max(0, Number(extra) || 0)
  const exploded = selected ? explode(selected.item_code, selected.factory_code, selected.total + extraN, selected.mode) : null
  const totalShortfall = exploded ? exploded.rows.reduce((s, r) => s + r.shortfall, 0) : 0
  const hasRequest = selected ? selected.batchIds.some(id => batches.find(b => b.id === id)?.material_request_id) : false
  // Prior open requests that already included extra stock for this item — warn before double-requesting
  const priorStock = selected ? stockReqs.filter(r => r.production_batches?.item_code === selected.item_code && r.production_batches?.factory_code === selected.factory_code && !selected.batchIds.includes(r.batch_id)) : []

  // Sort comparator for batches within a factory
  const cmp = (a: Batch, b: Batch) => {
    if (sortBy === 'batch') return a.batch_no.localeCompare(b.batch_no)
    const d = dateKey(a.delivery_date) - dateKey(b.delivery_date)
    return sortBy === 'due_desc' ? -d : d
  }

  // Factories present in the current view (for the combined, factory-grouped layout)
  const factoriesInView = [...new Set(shown.map(b => b.factory_code))].sort()
  // Show the 🏭 location grouping whenever the user is looking at more than one factory
  const showFacHeaders = isHO || factoriesInView.length > 1
  const singleTarget = (b: Batch): MatTarget => ({ label: b.batch_no, item_code: b.item_code, factory_code: b.factory_code, total: b.total_quantity, batchIds: [b.id], mode: b.run_mode || 'manual' })

  // Build display units for a factory's batches when Combine is on
  function buildUnits(fb: Batch[]) {
    const combinable = fb.filter(b => derivedStatus(b) === 'Planned' && !b.material_request_id && !b.no_combine)
    const byItem: Record<string, Batch[]> = {}
    combinable.forEach(b => { (byItem[b.item_code] = byItem[b.item_code] || []).push(b) })
    const combos = Object.values(byItem).filter(m => m.length >= 2)
    const comboIds = new Set(combos.flat().map(b => b.id))
    const singles = fb.filter(b => !comboIds.has(b.id))
    return { combos, singles }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">{grindingMode ? '🌀 Grinding Board' : 'Order Board'}</h1>
        <p className="text-gray-500 text-sm mb-3">
          {grindingMode
            ? 'Sales-order lines tagged for grinding. Plan, request materials and produce — separate from the normal packing line.'
            : 'Orders from confirmed sales orders. Once materials are received, plan which line packs each item and when.'}
          {isHO ? ' Showing all factories.' : ` Showing factory ${profile.factory_code}.`}
        </p>
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => { setGrindingMode(false); setFilter('All') }} className={`px-4 py-1.5 rounded-lg text-sm font-medium border ${!grindingMode ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}>Order Board</button>
          <button onClick={() => { setGrindingMode(true); setFilter('All') }} className={`px-4 py-1.5 rounded-lg text-sm font-medium border ${grindingMode ? 'bg-purple-600 text-white border-purple-600' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}>🌀 Grinding Board{grindingCount ? ` (${grindingCount})` : ''}</button>
        </div>

        {/* Summary — click to filter */}
        <div className="flex flex-wrap gap-2 mb-4 text-sm">
          <button onClick={() => setFilter('Planned')} className={`px-3 py-1.5 rounded-lg border font-medium ${filter === 'Planned' ? 'bg-blue-600 text-white border-blue-600' : 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'}`}>
            ⚠ {counts['Planned'] || 0} not requested yet
          </button>
          <button onClick={() => setFilter('Requested')} className={`px-3 py-1.5 rounded-lg border font-medium ${filter === 'Requested' ? 'bg-blue-600 text-white border-blue-600' : 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100'}`}>
            ✓ {counts['Requested'] || 0} requested
          </button>
          <button onClick={() => setFilter('In Progress')} className={`px-3 py-1.5 rounded-lg border font-medium ${filter === 'In Progress' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {counts['In Progress'] || 0} in progress
          </button>
          <button onClick={() => setFilter('Completed')} className={`px-3 py-1.5 rounded-lg border font-medium ${filter === 'Completed' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {counts['Completed'] || 0} done
          </button>
          {filter !== 'All' && <button onClick={() => setFilter('All')} className="px-3 py-1.5 text-blue-600 hover:underline">Show all</button>}
        </div>

        <div className="flex flex-wrap gap-2 items-center mb-4 text-sm">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search item or SO number…" className="border rounded-lg px-3 py-1 w-60 bg-white" />
          <span className="text-gray-500">Status:</span>
          <select value={filter} onChange={e => setFilter(e.target.value as Filter)} className="border rounded-lg px-2 py-1 bg-white">
            {FILTERS.map(f => <option key={f} value={f}>{f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}</option>)}
          </select>
          <span className="text-gray-500 ml-3">Delivery date:</span>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border rounded-lg px-2 py-1 bg-white" />
          <span className="text-gray-400">to</span>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border rounded-lg px-2 py-1 bg-white" />
          {showFacHeaders && (
            <>
              <span className="text-gray-500 ml-3">Factory:</span>
              <select value={factoryFilter} onChange={e => setFactoryFilter(e.target.value)} className="border rounded-lg px-2 py-1 bg-white">
                <option value="">All factories</option>
                {(isHO ? factories : factories.filter(f => factoriesInView.includes(f.code))).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
              </select>
            </>
          )}
          <span className="text-gray-500 ml-3">Sort:</span>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'due_asc' | 'due_desc' | 'batch')} className="border rounded-lg px-2 py-1 bg-white">
            <option value="due_asc">Due date (earliest)</option>
            <option value="due_desc">Due date (latest)</option>
            <option value="batch">Batch number</option>
          </select>
          {(dateFrom || dateTo || factoryFilter || filter !== 'All') && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setFactoryFilter(''); setFilter('All') }} className="text-blue-600 hover:underline ml-1">Clear filters</button>
          )}
        </div>

        <div className="flex items-center gap-4 mb-5 flex-wrap">
          <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
            <input type="checkbox" checked={combineOn} onChange={e => setCombineOn(e.target.checked)} className="h-4 w-4" />
            <span className="text-gray-700 font-medium">Combine same item to run together</span>
            <span className="text-gray-400">(Planned batches not yet requested, grouped by factory)</span>
          </label>
          <button onClick={() => setTomorrowOnly(v => !v)}
            className={`text-sm px-3 py-1 rounded-full font-medium border ${tomorrowOnly ? 'bg-yellow-300 border-yellow-400 text-yellow-900' : 'bg-white border-gray-300 text-gray-600 hover:bg-yellow-50'}`}>
            🚚 Tomorrow delivery{tomorrowCount ? ` (${tomorrowCount})` : ''}{tomorrowOnly ? ' ✓' : ''}
          </button>
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {shown.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border p-10 text-center text-gray-400">
            No production batches{filter !== 'All' ? ` with status "${filter}"` : ''} yet.
            <br />Confirm a sales order document to generate production demand.
          </div>
        ) : (
          <div className="space-y-6">
            {factoriesInView.map(fc => {
              const fb = [...shown.filter(b => b.factory_code === fc)].sort(cmp)
              const { combos, singles } = buildUnits(fb)
              const collapsed = collapsedFacs.has(fc)
              return (
                <div key={fc}>
                  {showFacHeaders && <button onClick={() => toggleFac(fc)} className="flex items-center gap-1 font-semibold text-sm text-gray-700 mb-2 hover:text-gray-900">
                    <span className="text-gray-400 w-3 inline-block">{collapsed ? '▸' : '▾'}</span> 🏭 {factoryName(fc)} <span className="text-gray-400 font-normal">· {fb.length} batch(es)</span></button>}
                  {!collapsed && (
                  <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="w-6"></th>
                          {['Batch', 'Item', 'Total qty', 'Delivery date', 'Status', ''].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {/* Combined units (only when Combine is on) */}
                        {combineOn && combos.map(members => {
                          const item = members[0].item_code
                          const key = `combo:${fc}:${item}`
                          const total = members.reduce((s, m) => s + m.total_quantity, 0)
                          const dates = [...new Set(members.map(m => m.delivery_date))]
                          const dateLabel = dates.length === 1 ? dates[0] : 'Multiple'
                          const target: MatTarget = { label: `${item} (combined ${members.length})`, item_code: item, factory_code: fc, total, batchIds: members.map(m => m.id), mode: members[0].run_mode || 'manual' }
                          return (
                            <Fragment key={key}>
                              <tr className={`border-b last:border-0 hover:bg-amber-50/40 cursor-pointer ${expanded.has(key) ? 'bg-amber-50/60' : 'bg-amber-50/20'}`} onClick={() => toggleRow(key)}>
                                <td className="pl-3 text-gray-400">{expanded.has(key) ? '▾' : '▸'}</td>
                                <td className="px-3 py-2 whitespace-nowrap"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-200 text-amber-800">Combined ×{members.length}</span></td>
                                <td className="px-3 py-2"><span className="font-medium">{item}</span><span className="block text-gray-500 text-xs">{members[0].description}</span>{bomBadge(item)}</td>
                                <td className="px-3 py-2 font-semibold whitespace-nowrap">{total}</td>
                                <td className="px-3 py-2 whitespace-nowrap">{dateLabel}</td>
                                <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Planned</span>{members.some(dueTomorrow) && <span className="block mt-0.5 bg-yellow-200 text-yellow-900 px-1.5 py-0.5 rounded text-[11px] font-bold whitespace-nowrap">🚚 TOMORROW DELIVERY</span>}</td>
                                <td className="px-3 py-2 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                                  <button onClick={() => { setSelected(target); setError(''); setSuccess('') }} className="text-blue-600 hover:underline text-xs font-medium">Materials</button>
                                </td>
                              </tr>
                              {expanded.has(key) && (
                                <tr className="bg-amber-50/30 border-b last:border-0">
                                  <td></td>
                                  <td colSpan={6} className="px-3 py-3">
                                    <div className="text-gray-500 text-xs mb-2">{members.length} orders combined — remove any to produce it separately:</div>
                                    <div className="space-y-2 max-w-2xl">
                                      {members.map(m => (
                                        <div key={m.id} className="border rounded-lg bg-white p-2">
                                          <div className="flex justify-between items-center mb-1">
                                            <span className="text-xs"><span className="font-mono font-semibold">{m.batch_no}</span> · due {m.delivery_date || '—'} · qty <strong>{m.total_quantity}</strong></span>
                                            <span className="flex items-center gap-3">
                                              {derivedStatus(m) !== 'Completed' && canEditFac(m.factory_code) && <button onClick={() => markCompleted(m)} title="Mark this batch completed, skipping the steps (for old orders)" className="text-green-700 hover:underline text-xs font-medium whitespace-nowrap">✓ Mark completed</button>}
                                              {hasCap(profile, 'request_split') && <button onClick={() => requestUncombine(m)}
                                                title="Request to run this batch on its own — Head Office must approve" className="text-red-600 hover:underline text-xs font-medium whitespace-nowrap">✕ Run on its own (needs approval)</button>}
                                            </span>
                                          </div>
                                          <ul className="space-y-0.5 pl-1">
                                            {m.production_batch_items?.map(it => (
                                              <li key={it.id} className="flex justify-between items-baseline gap-2 text-xs">
                                                <span className="text-gray-600 truncate min-w-0">{it.customer_name}</span>
                                                <span className="flex-shrink-0 flex items-baseline gap-2">
                                                  {it.so_number && <span className="text-gray-400 font-mono">{it.so_number}</span>}
                                                  <span className="font-medium">{it.quantity}</span>
                                                </span>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      ))}
                                    </div>
                                    <div className="mt-3">
                                      <button onClick={() => { setSelected(target); setError(''); setSuccess('') }}
                                        className="border border-blue-600 text-blue-600 px-4 py-1.5 rounded-lg hover:bg-blue-50 text-sm font-medium">Materials</button>
                                      <span className="ml-2 text-gray-400 text-xs">Request materials for all {members.length} batches together. Pack line &amp; date are set on the Packing Schedule.</span>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}

                        {/* Individual batches */}
                        {singles.map(b => (
                          <Fragment key={b.id}>
                            <tr className={`border-b last:border-0 hover:bg-gray-50 cursor-pointer ${expanded.has(b.id) ? 'bg-blue-50/40' : ''}`} onClick={() => toggleRow(b.id)}>
                              <td className="pl-3 text-gray-400">{expanded.has(b.id) ? '▾' : '▸'}</td>
                              <td className="px-3 py-2 font-mono font-semibold whitespace-nowrap">{b.batch_no}</td>
                              <td className="px-3 py-2"><span className="font-medium">{b.item_code}</span><span className="block text-gray-500 text-xs">{b.description}</span>{bomBadge(b.item_code)}{(b.pack_line || b.pack_date) && <span className="mt-0.5 inline-block bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded text-[11px] font-medium">📅 {b.pack_line || 'line ?'}{b.pack_date ? ` · ${b.pack_date.split('-').reverse().join('/')}` : ''}</span>}</td>
                              <td className="px-3 py-2 font-semibold whitespace-nowrap">{b.total_quantity}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{b.delivery_date || '—'}</td>
                              <td className="px-3 py-2">
                                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[derivedStatus(b)] || 'bg-gray-100 text-gray-700'}`}>{derivedStatus(b)}</span>
                                {dueTomorrow(b) && <span className="block mt-0.5 bg-yellow-200 text-yellow-900 px-1.5 py-0.5 rounded text-[11px] font-bold whitespace-nowrap">🚚 TOMORROW DELIVERY</span>}
                              </td>
                              <td className="px-3 py-2 text-right whitespace-nowrap">
                                {combineOn && b.no_combine && isHO && <button onClick={e => { e.stopPropagation(); recombine(b) }} className="text-blue-600 hover:underline text-xs mr-2">↩ Re-combine</button>}
                                {b.material_request_id && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">MR</span>}
                              </td>
                            </tr>
                            {expanded.has(b.id) && (
                              <tr className="bg-gray-50/60 border-b last:border-0">
                                <td></td>
                                <td colSpan={6} className="px-3 py-3">
                                  <div className="text-gray-400 text-xs mb-1">Per customer / order</div>
                                  <ul className="space-y-1 mb-3 max-w-lg">
                                    {b.production_batch_items?.map(it => (
                                      <li key={it.id} className="flex justify-between items-baseline gap-2">
                                        <span className="text-gray-700 truncate min-w-0">{it.customer_name}</span>
                                        <span className="flex-shrink-0 flex items-baseline gap-2">
                                          {it.so_number && <span className="text-gray-400 font-mono text-xs">{it.so_number}</span>}
                                          <span className="font-medium">{it.quantity}</span>
                                          {derivedStatus(b) === 'Planned' && !b.material_request_id && (b.production_batch_items?.length || 0) > 1 && hasCap(profile, 'request_split') && (
                                            <button onClick={() => requestSplit(b, it)} title="Request to split this order into its own batch — Head Office must approve"
                                              className="text-red-600 hover:underline text-xs font-medium whitespace-nowrap">✕ Split (needs approval)</button>
                                          )}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                  <button onClick={() => { setSelected(singleTarget(b)); setError(''); setSuccess('') }}
                                    className="border border-blue-600 text-blue-600 px-4 py-1.5 rounded-lg hover:bg-blue-50 text-sm font-medium">Materials</button>
                                  <span className="ml-2 text-gray-400 text-xs">Pack line &amp; date are set on the Packing Schedule once materials are received.</span>

                                  <div className="mt-4 border-t pt-3">
                                    <div className="flex flex-wrap items-center gap-4 text-sm mb-2">
                                      <span className="text-gray-500">Planned: <strong className="text-gray-800">{b.total_quantity}</strong></span>
                                      <span className="text-gray-500">Produced: <strong className="text-green-700">{clean(b.produced_qty || 0)}</strong></span>
                                      <span className="text-gray-500">Backorder: <strong className={b.total_quantity - (b.produced_qty || 0) > 0 ? 'text-red-600' : 'text-green-600'}>{clean(Math.max(0, b.total_quantity - (b.produced_qty || 0)))}</strong></span>
                                      {derivedStatus(b) !== 'Completed' && canEditFac(b.factory_code) && <button onClick={() => markCompleted(b)} className="text-green-700 border border-green-600 hover:bg-green-50 px-3 py-1 rounded-lg text-xs font-medium">✓ Mark completed (bypass)</button>}
                                    </div>
                                    <p className="text-gray-400 text-xs mb-3">Production is recorded in the <strong>Inspection Record</strong> (start/end + actual quantity produced). Recording there consumes raw materials (earliest expiry / oldest batch first) from {factoryName(b.factory_code)} stock.</p>
                                    {consumption[b.id] && consumption[b.id].length > 0 && (
                                      <div className="overflow-x-auto border rounded-lg bg-white max-w-3xl">
                                        <table className="w-full text-xs">
                                          <thead className="bg-gray-50 border-b">
                                            <tr>{['Material', 'Batch', 'Expiry', 'Consumed', 'When'].map(h => <th key={h} className="text-left px-3 py-1.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
                                          </thead>
                                          <tbody>
                                            {consumption[b.id].map(cn => (
                                              <tr key={cn.id} className="border-b last:border-0">
                                                <td className="px-3 py-1.5 font-mono">{cn.item_code}<span className="text-gray-400 font-sans ml-1">{cn.description}</span></td>
                                                <td className="px-3 py-1.5 font-mono">{cn.batch_no || '—'}</td>
                                                <td className="px-3 py-1.5">{cn.exp_date ? cn.exp_date.split('-').reverse().join('/') : '—'}</td>
                                                <td className="px-3 py-1.5 text-right font-semibold">{clean(cn.qty_consumed)}</td>
                                                <td className="px-3 py-1.5 text-gray-400 whitespace-nowrap">{new Date(cn.consumed_at).toLocaleDateString()}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {selected && exploded && (
          <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => closeMatModal()}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-4xl my-8 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-lg">Material requirements — <span className="font-mono">{selected.label}</span></h2>
              <button onClick={() => closeMatModal()} className="text-gray-400 hover:text-gray-600 text-sm">Close</button>
            </div>
            <p className="text-gray-500 text-sm mb-2">
              To make <strong>{selected.total}</strong> of {selected.item_code} at {isHO ? factoryName(selected.factory_code) : (selected.factory_code || 'this factory')}.
              {selected.batchIds.length > 1 && ` (combined from ${selected.batchIds.length} batches)`} Stock shown is the live system on-hand; the shortfall is worked out for you.
            </p>
            {grindingMode && (() => { const gi = exploded as { lots?: number; orderKg?: number; lotYield?: number }; return gi.lots ? (
              <div className="mb-3 text-sm bg-purple-50 border border-purple-200 rounded-lg p-2 text-purple-800">
                🌀 Order ≈ <strong>{gi.orderKg}</strong> kg → <strong>{gi.lots}</strong> lot{gi.lots > 1 ? 's' : ''} (1 lot ≈ {gi.lotYield} kg usable after {Math.round(GRIND_LOSS * 100)}% loss). Materials below are for {gi.lots} full lot{gi.lots > 1 ? 's' : ''}.
                <span className="block text-purple-500 text-xs mt-0.5">Planning estimate (average) — the actual materials used are recorded when grinding is done.</span>
              </div>
            ) : null })()}
            {selected.batchIds.length > 1 && (
              <div className="mb-4 text-xs bg-amber-50 border border-amber-200 rounded-lg p-2">
                <span className="font-medium text-amber-800">Requesting for {selected.batchIds.length} combined batches:</span>{' '}
                {selected.batchIds.map(id => { const b = batches.find(x => x.id === id); return b ? `${b.batch_no} (${b.total_quantity})` : id }).join('  +  ')}
                {' '}= <strong>{selected.total}</strong> total
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
              <span className="font-medium text-gray-700">Run mode:</span>
              {hasRequest ? (
                <span className="px-2 py-1 rounded bg-gray-100 text-gray-700">{selected.mode === 'manual' ? 'Manual' : 'Auto machine'} <span className="text-gray-400">(locked — request already open)</span></span>
              ) : (
                <select value={selected.mode} onChange={e => setSelected(s => (s ? { ...s, mode: e.target.value } : s))} className="border rounded px-2 py-1 bg-white">
                  <option value="auto">Auto machine</option>
                  <option value="manual">Manual</option>
                </select>
              )}
              <span className="text-gray-400 text-xs">decides which materials are needed (auto = roll, manual = pieces)</span>
            </div>

            {!hasRequest && (
              <div className="flex flex-wrap items-center gap-2 text-sm mb-3">
                <span className="font-medium text-gray-700">Extra to make for stock:</span>
                <input type="number" min="0" step="any" value={extra} onChange={e => setExtra(e.target.value)} placeholder="0" className="border rounded px-2 py-1 w-28 text-right" />
                <span className="text-gray-400 text-xs">units on top of the order ({selected.total}) — materials below cover {selected.total + extraN} total</span>
              </div>
            )}

            {priorStock.length > 0 && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-3 text-sm text-amber-800">
                ⚠ Materials were already requested for stock for <strong>{selected.item_code}</strong>:
                {priorStock.map(r => <span key={r.id}> {r.pick_run_no || r.request_no} (+{r.extra_qty} extra, {r.status})</span>)}. You may not need to request again.
              </div>
            )}

            <>
                {!hasRequest && (
                  <label className="inline-flex items-center gap-2 text-sm mb-2">
                    <input type="checkbox" checked={adhoc} onChange={e => {
                      const on = e.target.checked; setAdhoc(on)
                      if (on) setCustomRows(exploded.rows.map(r => ({ code: r.code, description: r.description, unit: r.unit, qty: String(r.shortfall > 0 ? r.requested : clean(r.required)) })))
                    }} className="h-4 w-4" />
                    ✎ Customise materials (ad-hoc) — request materials by hand for this order{exploded.note ? ' (works even without a recipe)' : ''}
                  </label>
                )}
                {adhoc ? (
                  <>
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 border-b">
                          <tr>{['Material', 'Description', 'Unit', 'Request qty', ''].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                        </thead>
                        <tbody>
                          {customRows.length === 0 && <tr><td colSpan={5} className="text-center py-4 text-gray-400">No materials — add one below.</td></tr>}
                          {customRows.map((r, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{r.code}</td>
                              <td className="px-3 py-2 text-gray-600">{r.description}</td>
                              <td className="px-3 py-2 text-gray-500">{r.unit}</td>
                              <td className="px-3 py-2"><input type="number" step="any" value={r.qty} onChange={e => setCustomRows(prev => prev.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} className="border rounded px-2 py-1 text-sm w-28 text-right" /></td>
                              <td className="px-3 py-2 text-right"><button onClick={() => setCustomRows(prev => prev.filter((_, j) => j !== i))} className="text-red-500 hover:underline text-xs">remove</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex flex-wrap items-end gap-3 mt-2">
                      <div className="flex flex-col gap-1 flex-1 min-w-[16rem]"><span className="text-xs font-medium text-gray-600">Add a material</span>
                        <ItemPicker items={items} value={addMat ? `${addMat.code} — ${addMat.description}` : ''} onPick={it => setAddMat(it)} placeholder="Type a material code or name…" /></div>
                      <div className="flex flex-col gap-1 w-28"><span className="text-xs font-medium text-gray-600">Qty{addMat ? ` (${addMat.unit})` : ''}</span>
                        <input type="number" step="any" value={addMatQty} onChange={e => setAddMatQty(e.target.value)} className="border rounded-lg px-3 py-2 text-sm text-right" /></div>
                      <button onClick={addCustomRow} className="border border-blue-600 text-blue-600 px-4 py-2 rounded-lg hover:bg-blue-50 text-sm font-medium">+ Add</button>
                    </div>
                  </>
                ) : exploded.note ? (
                  <p className="text-amber-600 text-sm bg-amber-50 p-3 rounded">{exploded.note}{!hasRequest ? ' — or tick "Customise materials (ad-hoc)" above to request materials by hand.' : ''}</p>
                ) : (
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>{['Material', 'Description', 'Unit', 'Required', 'Stock (system)', 'Shortfall', 'Requested'].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                      </thead>
                      <tbody>
                        {exploded.rows.map(r => (
                          <tr key={r.key} className={`border-b last:border-0 ${r.shortfall > 0 ? '' : 'bg-green-50/40'}`}>
                            <td className="px-3 py-2 font-mono font-medium whitespace-nowrap">{r.code}
                              {r.shortfall > 0 && (() => {
                                const others = factories.filter(f => f.code !== selected.factory_code && (stock[`${r.item_id}|${f.code}`] || 0) > 0)
                                return others.length ? <div className="font-sans font-normal text-[11px] text-purple-700 mt-0.5 whitespace-normal">Also in stock at: {others.map(f => `${factoryName(f.code)} (${clean(stock[`${r.item_id}|${f.code}`])})`).join(', ')} — consider a transfer</div> : null
                              })()}
                            </td>
                            <td className="px-3 py-2 text-gray-600">{r.description}</td>
                            <td className="px-3 py-2 text-gray-500">{r.unit}</td>
                            <td className="px-3 py-2 text-right">{clean(r.required)}</td>
                            <td className="px-3 py-2 text-right font-medium">{clean(r.stock)}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${r.shortfall > 0 ? 'text-red-600' : 'text-green-600'}`}>{clean(r.shortfall)}</td>
                            <td className="px-3 py-2 text-right font-semibold text-blue-700">{r.shortfall > 0 ? r.requested : 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {exploded.labels.length > 0 && (
                  <div className="mt-3 bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-sm">
                    <span className="font-medium text-indigo-800">🏷️ Label(s) also needed (printed at the factory, not from the warehouse):</span>
                    <ul className="mt-1 space-y-0.5 text-indigo-900">
                      {exploded.labels.map(l => <li key={l.code}><span className="font-mono font-medium">{l.code}</span> — {l.description} · {clean(l.required)} {l.unit}</li>)}
                    </ul>
                    <p className="text-indigo-500 text-xs mt-1">Request &amp; print these in Receiving → Labels.</p>
                  </div>
                )}

                {(adhoc || !exploded.note) && (
                  <div className="flex flex-wrap items-end justify-between gap-3 mt-4">
                    <div className="text-sm">
                      {hasRequest
                        ? <span className="text-purple-700">Material request {reqNo ? <strong className="font-mono">{reqNo}</strong> : ''} is already open{reqCreator ? ` (raised by ${reqCreator})` : ''} — see Material Requests.</span>
                        : adhoc
                          ? <span className="text-gray-600">Ad-hoc: requesting exactly the materials & quantities listed above.</span>
                          : totalShortfall > 0
                            ? <span className="text-red-600">Total shortfall across {exploded.rows.filter(r => r.shortfall > 0).length} material(s).</span>
                            : <span className="text-green-600">Enough stock on hand — no shortfall.</span>}
                    </div>
                    <div className="flex items-end gap-3">
                      <button onClick={() => {
                        if (adhoc) raiseExt(selected, customRows.map(r => ({ code: r.code, description: r.description, unit: r.unit, qty: Number(r.qty) })), extraN, extraN > 0 ? `Ad-hoc · +${extraN} for stock` : 'Ad-hoc')
                        else if (grindingMode) raiseExt(selected, exploded.rows.filter(r => r.shortfall > 0).map(r => ({ code: r.code, description: r.description, unit: r.unit, qty: r.requested })), 0, `Ad-hoc · Grinding${extraN > 0 ? ` (+${extraN} for stock)` : ''}`)
                        else if (extraN > 0) raiseExt(selected, exploded.rows.map(r => ({ code: r.code, description: r.description, unit: r.unit, qty: r.shortfall > 0 ? r.requested : 0 })), extraN, `+${extraN} extra for stock`)
                        else raiseTarget(selected)
                      }} disabled={raising || hasRequest || (adhoc ? customRows.filter(r => Number(r.qty) > 0).length === 0 : totalShortfall <= 0)}
                        className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                        {raising ? 'Raising…' : adhoc ? 'Raise ad-hoc request' : extraN > 0 ? 'Raise request (+ stock)' : 'Raise Material Request'}
                      </button>
                    </div>
                  </div>
                )}
                {error && <p className="text-red-500 text-sm bg-red-50 border border-red-200 rounded p-2 mt-3">Couldn’t raise: {error}</p>}
                <p className="text-gray-400 text-xs mt-2">Tip: standard requests capture the current shortfall plus a safety margin. Ad-hoc requests use exactly what you list. Batch &amp; expiry are entered later on the label.</p>
              </>
          </div>
          </div>
        )}
      </div>
    </div>
  )
}
