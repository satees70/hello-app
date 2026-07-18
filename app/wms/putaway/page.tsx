'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'
import ScanGate from '@/components/ScanGate'
import { matchBin, matchItem } from '@/lib/qr'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'

interface Item { code: string; description: string; unit: string }
interface Loc { id: string; code: string; location_type: string; active: boolean; pick_sequence: number | null }
interface Stock { id: string; item_code: string; description: string | null; location_id: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number }
interface Move { id: string; item_code: string; description: string | null; to_location_code: string | null; batch_no: string; quantity: number; moved_by_name: string | null; created_at: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const seqKey = (l: Loc) => `${(l.pick_sequence ?? 999999).toString().padStart(6, '0')}_${l.code}`

const EMPTY = { itemCode: '', description: '', uom: '', qty: '', batch: '', exp_date: '', reference: '', bin: '' }

export default function WmsPutawayPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [items, setItems] = useState<Item[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [stock, setStock] = useState<Stock[]>([])
  const [recent, setRecent] = useState<Move[]>([])
  const [form, setForm] = useState(EMPTY)
  const [binTouched, setBinTouched] = useState(false)
  const [binEdits, setBinEdits] = useState<Record<string, string>>({})   // pending row -> chosen bin
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({})   // pending row -> qty to put in this bin (rest stays in GOODS-IN)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(''); const [ok, setOk] = useState('')
  const [scanFor, setScanFor] = useState<{ row: Stock; bin: string } | null>(null)
  const [wh, setWh] = useState<WhFilter>('all')
  const [q, setQ] = useState('')   // search pending list: item / description / batch / document no / supplier / production
  const [sourceByKey, setSourceByKey] = useState<Map<string, { ref: string; supplier: string; kind: string }>>(new Map())   // (item|batch) -> where it was received from
  // Outstanding pick demand per item: orders that ran short (no-stock) still waiting for this item.
  const [demand, setDemand] = useState<Record<string, { qty: number; lines: string[]; orders: Set<string> }>>({})
  const [flagged, setFlagged] = useState<Set<string>>(new Set())   // stock ids with a flag waiting for the office
  const [flagFor, setFlagFor] = useState<Stock | null>(null)       // row whose issue is being flagged
  const [flagForm, setFlagForm] = useState({ item: false, qty: false, batch: false, correctItem: '', correctQty: '', correctBatch: '', note: '' })

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [it, lo, st, mv, { data: nos }] = await Promise.all([
      fetchAll<Item>('items', 'code, description, unit', 'code'),
      fetchAll<Loc>('wms_locations', 'id, code, location_type, active, pick_sequence', 'code'),
      fetchAll<Stock>('wms_stock', 'id, item_code, description, location_id, location_code, batch_no, exp_date, quantity'),
      supabase.from('wms_stock_moves').select('id, item_code, description, to_location_code, batch_no, quantity, moved_by_name, created_at')
        .in('move_type', ['putaway', 'receipt']).order('created_at', { ascending: false }).limit(30),
      supabase.from('wms_order_lines').select('id, item_code, no_stock_qty, order_id').eq('no_stock', true).gt('no_stock_qty', 0),
    ])
    setItems(it); setLocs(lo); setStock(st); setRecent((mv.data as Move[]) || [])
    const dem: Record<string, { qty: number; lines: string[]; orders: Set<string> }> = {}
    ;((nos as { id: string; item_code: string; no_stock_qty: number; order_id: string | null }[]) || []).forEach(l => {
      const d = (dem[l.item_code] ||= { qty: 0, lines: [], orders: new Set() })
      d.qty = clean(d.qty + Number(l.no_stock_qty || 0)); d.lines.push(l.id); if (l.order_id) d.orders.add(l.order_id)
    })
    setDemand(dem)
    // Flags still waiting for the office (table may not exist yet — ignore if so).
    const { data: fl } = await supabase.from('wms_correction_requests').select('stock_id').in('kind', ['batch_flag', 'stock_flag']).eq('status', 'Pending')
    setFlagged(new Set(((fl as { stock_id: string | null }[]) || []).map(f => f.stock_id).filter(Boolean) as string[]))

    // Where each pending line was received from — so the list is searchable by document no /
    // supplier / production. Receipt moves carry the document (GRN for supplier, "DO …" for
    // production); GRNs carry the supplier name.
    const [{ data: rcpt }, { data: grns }, { data: pos }] = await Promise.all([
      supabase.from('wms_stock_moves').select('item_code, batch_no, reference, created_at').eq('move_type', 'receipt').order('created_at', { ascending: false }).limit(5000),
      supabase.from('wms_grns').select('grn_no, supplier_name, po_id'),
      supabase.from('wms_purchase_orders').select('id, supplier_name'),
    ])
    const poSup = new Map((((pos as { id: string; supplier_name: string | null }[]) || [])).map(p => [p.id, p.supplier_name || '']))
    const grnSup = new Map<string, string>()
    ;((grns as { grn_no: string | null; supplier_name: string | null; po_id: string | null }[]) || []).forEach(g => { if (g.grn_no) grnSup.set(g.grn_no, g.supplier_name || (g.po_id ? poSup.get(g.po_id) || '' : '')) })
    const src = new Map<string, { ref: string; supplier: string; kind: string }>()
    ;((rcpt as { item_code: string; batch_no: string | null; reference: string | null }[]) || []).forEach(m => {
      const key = `${m.item_code}|${m.batch_no || ''}`
      if (src.has(key)) return   // list is newest-first, so the first hit is the latest receipt
      const ref = (m.reference || '').trim()
      const isProd = /^DO\b/i.test(ref)
      let supplier = grnSup.get(ref) || ''
      if (!supplier) { const g = ref.match(/GRN\s+(\S+)/i); if (g) supplier = grnSup.get(g[1]) || '' }
      src.set(key, { ref, supplier, kind: isProd ? 'Production' : supplier ? 'Supplier' : '' })
    })
    setSourceByKey(src)
  }

  const locByCode = useMemo(() => new Map(locs.map(l => [l.code.toUpperCase(), l])), [locs])
  const occupied = useMemo(() => new Set(stock.filter(s => s.quantity > 0).map(s => s.location_id)), [stock])
  const goodsIn = useMemo(() => locs.find(l => l.code === 'GOODS-IN'), [locs])
  const pending = useMemo(() => stock.filter(s => s.location_code === 'GOODS-IN' && s.quantity > 0)
    .sort((a, b) => a.item_code.localeCompare(b.item_code)), [stock])
  const pendingShown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return pending.filter(s => passWh(wh, s.description)).filter(s => {
      if (!needle) return true
      const src = sourceByKey.get(`${s.item_code}|${s.batch_no || ''}`)
      return [s.item_code, s.description, s.batch_no, src?.ref, src?.supplier, src?.kind]
        .filter(Boolean).join(' ').toLowerCase().includes(needle)
    })
  }, [pending, wh, q, sourceByKey])

  // Suggest a shelf bin for an item: SL bin already holding it → empty SL → empty XS overflow.
  const suggestBin = useCallback((itemCode: string) => {
    const active = locs.filter(l => l.active && l.location_type !== 'STAGE' && l.code !== 'PENDING')
    const sl = active.filter(l => l.location_type === 'SL').sort((a, b) => seqKey(a).localeCompare(seqKey(b)))
    const xs = active.filter(l => l.location_type === 'XS').sort((a, b) => seqKey(a).localeCompare(seqKey(b)))
    const itemLocIds = new Set(stock.filter(s => s.item_code === itemCode && s.quantity > 0 && s.location_code !== 'GOODS-IN').map(s => s.location_id))
    const holdingSL = sl.find(l => itemLocIds.has(l.id))
    if (holdingSL) return { code: holdingSL.code, why: 'already holds this item' }
    const emptySL = sl.find(l => !occupied.has(l.id))
    if (emptySL) return { code: emptySL.code, why: 'empty pick bin' }
    const emptyXS = xs.find(l => !occupied.has(l.id))
    if (emptyXS) return { code: emptyXS.code, why: 'overflow (excess)' }
    return null
  }, [locs, stock, occupied])

  const suggestion = form.itemCode ? suggestBin(form.itemCode) : null
  const binValue = binTouched ? form.bin : (suggestion?.code || form.bin)

  function startPutaway(row: Stock) {
    const toCode = (binEdits[row.id] ?? suggestBin(row.item_code)?.code ?? '').toUpperCase()
    if (!locByCode.get(toCode)) { setErr(`Choose a valid bin for ${row.item_code}.`); return }
    setErr(''); setScanFor({ row, bin: toCode })
  }

  async function putAwayPending(row: Stock, toCode: string) {
    if (!canEdit || !goodsIn) return
    const to = locByCode.get(toCode.toUpperCase())
    if (!to) { setErr(`Choose a valid bin for ${row.item_code}.`); return }
    // Put away a chosen quantity (default = all). A partial amount leaves the rest in GOODS-IN,
    // so the same item can be split across several bins in a few taps.
    const q = qtyEdits[row.id] != null && qtyEdits[row.id] !== '' ? Number(qtyEdits[row.id]) : row.quantity
    if (!(q > 0)) { setErr('Enter a quantity greater than zero.'); return }
    if (q > row.quantity + 1e-9) { setErr(`Only ${fmtQty(row.quantity)} of ${row.item_code} is in GOODS-IN.`); return }
    setBusy(row.id); setErr(''); setOk('')
    const { error } = await supabase.rpc('wms_transfer', {
      p_item_code: row.item_code, p_from_location_id: goodsIn.id, p_from_batch: row.batch_no,
      p_to_location_id: to.id, p_qty: q, p_reference: 'putaway',
    })
    setBusy('')
    if (error) { setErr(error.message); return }
    setOk(`Put ${fmtQty(q)} of ${row.item_code} away into ${to.code}${q < row.quantity ? ` · ${fmtQty(clean(row.quantity - q))} still in GOODS-IN to place` : ''}.`)
    setBinEdits(b => { const n = { ...b }; delete n[row.id]; return n })
    setQtyEdits(m => { const n = { ...m }; delete n[row.id]; return n })
    load()
  }

  // Stock arrived for an item orders are waiting on → move the needed quantity into the PENDING
  // area (kept apart from general stock), re-open those orders for picking, and leave the rest in
  // GOODS-IN to shelf normally. One tap does the whole "stage the pending, release to picking".
  async function stageToPending(row: Stock) {
    const d = demand[row.item_code]; if (!d || !d.lines.length || !goodsIn) return
    const pend = locByCode.get('PENDING')
    if (!pend) { setErr('No PENDING area yet — run db/2026-07-wms-pending-area.sql in Supabase (it creates a bin coded PENDING).'); return }
    const q = Math.min(clean(d.qty), row.quantity)
    if (!(q > 0)) return
    if (!confirm(`Move ${fmtQty(q)} of ${row.item_code} into the PENDING area for ${d.orders.size} waiting order(s), and tell pickers stock has arrived?\n\nPut the remaining ${fmtQty(clean(row.quantity - q))} onto normal shelves.`)) return
    setBusy('pend' + row.id); setErr(''); setOk('')
    const { error } = await supabase.rpc('wms_transfer', {
      p_item_code: row.item_code, p_from_location_id: goodsIn.id, p_from_batch: row.batch_no,
      p_to_location_id: pend.id, p_qty: q, p_reference: 'pending',
    })
    if (error) { setErr(error.message); setBusy(''); return }
    for (const id of d.lines) {
      const { error: e } = await supabase.rpc('wms_reopen_line', { p_line_id: id })
      if (e) { setErr(/wms_reopen_line/.test(e.message) && /does not exist|schema cache|could not find/i.test(e.message) ? 'Staged to PENDING, but re-opening picking needs db/2026-07-wms-repick-outstanding.sql in Supabase.' : e.message); setBusy(''); load(); return }
    }
    setBusy(''); setOk(`Staged ${fmtQty(q)} of ${row.item_code} to PENDING and re-opened ${d.orders.size} order(s) for picking.`); load()
  }

  // Open the flag panel for a row — warehouse marks what looks wrong (item name / quantity /
  // batch) and, if known, the correct value. It notifies the office under Approvals to revise it.
  function openFlag(row: Stock) {
    if (!canEdit) return
    setErr('')
    setFlagForm({ item: false, qty: false, batch: false, correctItem: '', correctQty: '', correctBatch: row.batch_no || '', note: '' })
    setFlagFor(row)
  }

  async function submitFlag() {
    const row = flagFor; if (!row) return
    const fields = [flagForm.item && 'item', flagForm.qty && 'qty', flagForm.batch && 'batch'].filter(Boolean) as string[]
    if (!fields.length) { setErr('Tick what looks wrong — item, quantity or batch.'); return }
    setBusy('flag' + row.id); setErr(''); setOk('')
    const { error } = await supabase.rpc('flag_stock_issue', {
      p_stock_id: row.id, p_fields: fields.join(','),
      p_correct_item: flagForm.item ? (flagForm.correctItem.trim() || null) : null,
      p_correct_qty: flagForm.qty && flagForm.correctQty.trim() !== '' ? Number(flagForm.correctQty) : null,
      p_correct_batch: flagForm.batch ? (flagForm.correctBatch.trim() || null) : null,
      p_reason: flagForm.note.trim() || null,
    })
    setBusy('')
    if (error) {
      setErr(/flag_stock_issue|wms_correction_requests|flag_fields/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message)
        ? 'This needs a database update — run db/2026-07-wms-stock-flag.sql in Supabase.' : error.message)
      return
    }
    setFlagFor(null)
    setOk(`Flagged ${row.item_code} (${fields.join(', ')}) — the office will revise it under Approvals.`); load()
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    const code = binValue.trim().toUpperCase()
    const loc = locByCode.get(code)
    const qty = Number(form.qty)
    if (!form.itemCode) { setErr('Pick an item.'); return }
    if (!loc) { setErr(`Bin "${code}" is not in the Location Map.`); return }
    if (!(qty > 0)) { setErr('Enter a quantity greater than zero.'); return }
    setBusy('manual'); setErr(''); setOk('')
    const { error } = await supabase.rpc('wms_putaway', {
      p_item_code: form.itemCode, p_location_id: loc.id, p_qty: qty,
      p_batch: form.batch.trim(), p_exp_date: form.exp_date || null, p_reference: form.reference.trim() || null,
    })
    setBusy('')
    if (error) { setErr(error.message); return }
    setOk(`Put ${fmtQty(qty)} ${form.uom || ''} of ${form.itemCode} into ${code}.`)
    setForm(f => ({ ...EMPTY, reference: f.reference })); setBinTouched(false); load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Putaway</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">Move received goods onto shelves. The system suggests the best bin; you confirm.</p>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access, so you can’t book putaways.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {ok && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {ok}</p>}

        {/* Pending putaway = stock sitting in GOODS-IN */}
        <div className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-600">Pending putaway <span className="text-gray-400 font-normal">— just received, in GOODS-IN ({pendingShown.length})</span></h2>
            <WarehouseTabs value={wh} onChange={setWh} />
          </div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Search item, description, batch, document no, supplier, production…"
            className="w-full border rounded-lg px-3 py-2 text-sm mb-2" />
          {pendingShown.length === 0
            ? <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">{pending.length ? 'Nothing in this warehouse.' : 'Nothing waiting. Received goods appear here.'}</div>
            : <div className="space-y-2">
                {pendingShown.map(row => {
                  const sug = suggestBin(row.item_code)
                  const bin = binEdits[row.id] ?? sug?.code ?? ''
                  return (
                    <div key={row.id} className="bg-white rounded-xl border shadow-sm p-3 flex flex-wrap items-center gap-3">
                      <div className="flex-1 min-w-[180px]">
                        <div className="font-mono font-medium text-sm">{row.item_code} <span className="text-gray-400">×{fmtQty(row.quantity)}</span></div>
                        <div className="text-xs text-gray-500">{row.description}{row.batch_no ? ` · b:${row.batch_no}` : ''}{row.exp_date ? ` · exp ${fmtDate(row.exp_date)}` : ''}</div>
                        {(() => { const src = sourceByKey.get(`${row.item_code}|${row.batch_no || ''}`); if (!src?.ref) return null; return <div className="text-[11px] text-gray-400 mt-0.5">📄 {src.ref}{src.supplier ? ` · ${src.supplier}` : src.kind ? ` · ${src.kind}` : ''}</div> })()}
                        {flagged.has(row.id) && <div className="text-[11px] text-rose-600 mt-0.5">⚑ Flagged — waiting for the office to revise.</div>}
                      </div>
                      {canEdit && <>
                        <input value={qtyEdits[row.id] ?? String(clean(row.quantity))} onChange={e => setQtyEdits(m => ({ ...m, [row.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                          className="w-16 border rounded-lg px-2 py-1.5 text-sm text-right tabular-nums" inputMode="decimal" title="Qty for this bin — put the rest into another bin to split across locations" />
                        <input list="wms-bins" value={bin} onChange={e => setBinEdits(b => ({ ...b, [row.id]: e.target.value.toUpperCase() }))}
                          className="w-28 border rounded-lg px-2 py-1.5 text-sm font-mono" placeholder="bin" />
                        <button onClick={() => startPutaway(row)} disabled={busy === row.id}
                          className="bg-emerald-700 text-white px-4 py-1.5 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">{busy === row.id ? '…' : '📷 Scan & put away'}</button>
                        <button onClick={() => putAwayPending(row, bin)} disabled={busy === row.id}
                          title="Put away without scanning — just confirm the bin."
                          className="border border-emerald-600 text-emerald-700 px-4 py-1.5 rounded-lg hover:bg-emerald-50 disabled:opacity-50 text-sm font-medium">{busy === row.id ? '…' : '✓ Put away'}</button>
                        <button onClick={() => openFlag(row)} disabled={busy === 'flag' + row.id || flagged.has(row.id)}
                          title="Item name, quantity or batch wrong? Flag it for the office to revise."
                          className="border border-rose-300 text-rose-700 px-3 py-1.5 rounded-lg hover:bg-rose-50 disabled:opacity-50 text-sm font-medium">{busy === 'flag' + row.id ? '…' : flagged.has(row.id) ? '⚑ Flagged' : '⚑ Flag issue'}</button>
                        {sug && !binEdits[row.id] && <span className="text-[11px] text-emerald-700 basis-full sm:basis-auto">→ {sug.code} ({sug.why})</span>}
                      </>}
                      {demand[row.item_code] && (
                        <div className="basis-full flex flex-wrap items-center gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 text-amber-800 mt-1">
                          <span>⚠ <b>{fmtQty(Math.min(demand[row.item_code].qty, row.quantity))}</b> needed for <b>{demand[row.item_code].orders.size}</b> outstanding order(s) — move this to PENDING, shelf the rest.</span>
                          {canEdit && <button onClick={() => stageToPending(row)} disabled={busy === 'pend' + row.id}
                            className="ml-auto border border-amber-400 bg-white text-amber-800 rounded px-2 py-1 hover:bg-amber-100 disabled:opacity-50 font-medium whitespace-nowrap">
                            {busy === 'pend' + row.id ? '…' : `📦 Stage ${fmtQty(Math.min(demand[row.item_code].qty, row.quantity))} to PENDING & tell pickers`}</button>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>}
        </div>

        {/* Manual putaway (ad-hoc: add stock straight to a bin) */}
        {canEdit && (
          <details className="bg-white rounded-xl shadow-sm border mb-6">
            <summary className="px-6 py-3 text-sm font-medium cursor-pointer text-gray-700">Add stock straight to a bin (manual)</summary>
            <form onSubmit={submitManual} className="p-6 pt-2 space-y-4">
              <div><label className="block text-sm font-medium mb-1">Item</label><ItemPicker items={items} value={form.itemCode ? `${form.itemCode} — ${form.description}` : ''} onPick={it => { setForm(f => ({ ...f, itemCode: it.code, description: it.description, uom: it.unit })); setBinTouched(false) }} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div><label className="block text-sm font-medium mb-1">Quantity</label><input value={form.qty} onChange={e => setForm({ ...form, qty: e.target.value.replace(/[^0-9.]/g, '') })} className="w-full border rounded-lg px-3 py-2 text-sm" inputMode="decimal" placeholder="0" /></div>
                <div><label className="block text-sm font-medium mb-1">Batch</label><input value={form.batch} onChange={e => setForm({ ...form, batch: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm font-mono" /></div>
                <div><label className="block text-sm font-medium mb-1">Expiry</label><input type="date" value={form.exp_date} onChange={e => setForm({ ...form, exp_date: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
              </div>
              <div><label className="block text-sm font-medium mb-1">Bin</label>
                <input list="wms-bins" value={binValue} onChange={e => { setBinTouched(true); setForm({ ...form, bin: e.target.value.toUpperCase() }) }} className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="A105" />
                {suggestion && !binTouched && <p className="text-xs text-emerald-700 mt-1">Suggested: <b>{suggestion.code}</b> — {suggestion.why}.</p>}
              </div>
              <button type="submit" disabled={busy === 'manual'} className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">{busy === 'manual' ? 'Saving…' : 'Add to bin'}</button>
            </form>
          </details>
        )}

        <datalist id="wms-bins">{locs.filter(l => l.active && l.location_type !== 'STAGE').slice(0, 2000).map(l => <option key={l.id} value={l.code} />)}</datalist>

        <h2 className="text-sm font-semibold text-gray-600 mb-2">Recent goods-in &amp; putaways</h2>
        {/* Desktop: table */}
        <div className="hidden sm:block bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Item', 'To bin', 'Batch', 'Qty', 'By', 'When'].map(h => <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {recent.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">Nothing yet.</td></tr>}
              {recent.map(m => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5"><span className="font-mono font-medium">{m.item_code}</span> <span className="text-gray-400 text-xs">{m.description}</span></td>
                  <td className="px-4 py-2.5 font-mono">{m.to_location_code}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{m.batch_no || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 font-medium tabular-nums">{fmtQty(m.quantity)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{m.moved_by_name}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtTime(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one card per move */}
        <div className="sm:hidden space-y-2">
          {recent.length === 0 && <div className="bg-white rounded-xl border p-6 text-center text-gray-400 text-sm">Nothing yet.</div>}
          {recent.map(m => (
            <div key={m.id} className="bg-white rounded-xl border shadow-sm p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono font-semibold text-sm">{m.item_code}</div>
                  <div className="text-xs text-gray-500 leading-snug">{m.description}</div>
                </div>
                <div className="font-medium tabular-nums shrink-0">{fmtQty(m.quantity)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
                <span>To bin: <span className="font-mono">{m.to_location_code}</span></span>
                <span>Batch: <span className="font-mono">{m.batch_no || '—'}</span></span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-gray-500">
                {m.moved_by_name && <span>{m.moved_by_name}</span>}
                <span>{fmtTime(m.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {flagFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setFlagFor(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h2 className="font-semibold text-lg">Flag an issue</h2>
              <button onClick={() => setFlagFor(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              <span className="font-mono">{flagFor.item_code}</span> · {flagFor.description || '—'} · ×{fmtQty(flagFor.quantity)}{flagFor.batch_no ? ` · b:${flagFor.batch_no}` : ''}
            </p>
            <p className="text-sm text-gray-600 mb-3">Tick what looks wrong. Add the correct value if you know it — the office is notified to revise it.</p>

            <div className="space-y-3">
              {/* Item name */}
              <div className={`border rounded-lg p-3 ${flagForm.item ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={flagForm.item} onChange={e => setFlagForm(f => ({ ...f, item: e.target.checked }))} />
                  Item name / code is wrong
                </label>
                {flagForm.item && <input value={flagForm.correctItem} onChange={e => setFlagForm(f => ({ ...f, correctItem: e.target.value }))}
                  placeholder="What should it be? (optional)" className="w-full border rounded-lg px-3 py-2 text-sm mt-2" />}
              </div>
              {/* Quantity */}
              <div className={`border rounded-lg p-3 ${flagForm.qty ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={flagForm.qty} onChange={e => setFlagForm(f => ({ ...f, qty: e.target.checked }))} />
                  Quantity is wrong <span className="text-gray-400 font-normal">(now ×{fmtQty(flagFor.quantity)})</span>
                </label>
                {flagForm.qty && <input value={flagForm.correctQty} onChange={e => setFlagForm(f => ({ ...f, correctQty: e.target.value.replace(/[^0-9.]/g, '') }))}
                  inputMode="decimal" placeholder="Correct quantity (optional)" className="w-full border rounded-lg px-3 py-2 text-sm mt-2" />}
              </div>
              {/* Batch */}
              <div className={`border rounded-lg p-3 ${flagForm.batch ? 'border-rose-300 bg-rose-50/40' : ''}`}>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" checked={flagForm.batch} onChange={e => setFlagForm(f => ({ ...f, batch: e.target.checked }))} />
                  Batch number is wrong <span className="text-gray-400 font-normal">(now {flagFor.batch_no || '—'})</span>
                </label>
                {flagForm.batch && <input value={flagForm.correctBatch} onChange={e => setFlagForm(f => ({ ...f, correctBatch: e.target.value }))}
                  placeholder="Correct batch (optional — fixed on approval)" className="w-full border rounded-lg px-3 py-2 text-sm font-mono mt-2" />}
              </div>
              <textarea value={flagForm.note} onChange={e => setFlagForm(f => ({ ...f, note: e.target.value }))} rows={2}
                placeholder="Note for the office (optional)" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setFlagFor(null)} className="px-4 py-2 rounded-lg border text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={submitFlag} disabled={busy === 'flag' + flagFor.id}
                className="bg-rose-600 text-white px-4 py-2 rounded-lg hover:bg-rose-700 disabled:opacity-50 text-sm font-medium">{busy === 'flag' + flagFor.id ? 'Sending…' : '⚑ Send flag to office'}</button>
            </div>
          </div>
        </div>
      )}

      {scanFor && (
        <ScanGate
          title={`Put ${scanFor.row.item_code} into ${scanFor.bin}`}
          steps={[
            { label: 'bin', expectText: scanFor.bin, match: raw => matchBin(raw, scanFor.bin) },
            { label: 'item / batch', expectText: `${scanFor.row.item_code}${scanFor.row.batch_no ? ' · ' + scanFor.row.batch_no : ''}`, match: raw => matchItem(raw, scanFor.row.item_code, scanFor.row.batch_no) },
          ]}
          onComplete={() => { const s = scanFor; setScanFor(null); if (s) putAwayPending(s.row, s.bin) }}
          onCancel={() => setScanFor(null)}
        />
      )}
    </div>
  )
}
