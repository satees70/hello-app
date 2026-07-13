'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'

interface Stock {
  id: string
  item_id: string | null
  item_code: string
  description: string | null
  location_id: string
  location_code: string
  batch_no: string
  exp_date: string | null
  quantity: number
  uom: string | null
}
interface Item { code: string; description: string; unit: string }
interface Loc { id: string; code: string; location_type: string; active: boolean }

const WAREHOUSE = '8BT'
const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''

const EMPTY = { itemCode: '', description: '', uom: '', locationCode: '', batch: '', exp_date: '', quantity: '' }

export default function WmsStockPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')

  const [rows, setRows] = useState<Stock[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // filters
  const [q, setQ] = useState('')
  const [sortBy, setSortBy] = useState<'item' | 'bin'>('item')

  // add / edit
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Stock | null>(null)
  const [form, setForm] = useState(EMPTY)

  // import
  const [showImport, setShowImport] = useState(false)
  const [pasteText, setPasteText] = useState('')

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const [s, it, lo] = await Promise.all([
      fetchAll<Stock>('wms_stock', '*', 'item_code'),
      fetchAll<Item>('items', 'code, description, unit', 'code'),
      fetchAll<Loc>('wms_locations', 'id, code, location_type, active', 'code'),
    ])
    setRows(s); setItems(it); setLocs(lo)
  }

  const locByCode = useMemo(() => new Map(locs.map(l => [l.code.toUpperCase(), l])), [locs])
  const itemByCode = useMemo(() => new Map(items.map(i => [i.code.toUpperCase(), i])), [items])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = rows.filter(r => !needle || [r.item_code, r.description, r.location_code, r.batch_no].some(v => (v || '').toLowerCase().includes(needle)))
    out.sort((a, b) => sortBy === 'bin'
      ? a.location_code.localeCompare(b.location_code) || a.item_code.localeCompare(b.item_code)
      : a.item_code.localeCompare(b.item_code) || a.location_code.localeCompare(b.location_code))
    return out
  }, [rows, q, sortBy])

  const stats = useMemo(() => ({
    lines: rows.length,
    items: new Set(rows.map(r => r.item_code)).size,
    bins: new Set(rows.map(r => r.location_code)).size,
    qty: clean(rows.reduce((s, r) => s + Number(r.quantity || 0), 0)),
  }), [rows])

  function openCreate() { setEditing(null); setForm(EMPTY); setErr(''); setShowForm(true) }
  function openEdit(r: Stock) {
    setEditing(r)
    setForm({ itemCode: r.item_code, description: r.description || '', uom: r.uom || '', locationCode: r.location_code, batch: r.batch_no, exp_date: r.exp_date || '', quantity: r.quantity.toString() })
    setErr(''); setShowForm(true)
  }

  async function saveOne(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    const itemCode = form.itemCode.trim().toUpperCase()
    const locCode = form.locationCode.trim().toUpperCase()
    const loc = locByCode.get(locCode)
    if (!itemCode) { setErr('Pick an item.'); return }
    if (!loc) { setErr(`Location "${locCode}" is not in the Location Map.`); return }
    const qty = Number(form.quantity)
    if (!isFinite(qty)) { setErr('Enter a valid quantity.'); return }
    setBusy(true); setErr('')
    const it = itemByCode.get(itemCode)
    const item_id = await itemIdFor(itemCode)   // link to Items master by code (null if unknown)
    const payload = {
      warehouse_code: WAREHOUSE,
      item_id,
      item_code: itemCode,
      description: form.description.trim() || it?.description || null,
      location_id: loc.id,
      location_code: loc.code,
      batch_no: form.batch.trim(),
      exp_date: form.exp_date || null,
      quantity: qty,
      uom: form.uom.trim() || it?.unit || null,
    }
    const res = editing
      ? await supabase.from('wms_stock').update(payload).eq('id', editing.id)
      : await supabase.from('wms_stock').upsert(payload, { onConflict: 'warehouse_code,item_code,location_id,batch_no' })
    setBusy(false)
    if (res.error) { setErr(res.error.message); return }
    setShowForm(false); load()
  }

  async function itemIdFor(code: string): Promise<string | null> {
    const { data } = await supabase.from('items').select('id').eq('code', code).maybeSingle()
    return data?.id ?? null
  }

  async function remove(r: Stock) {
    if (!canEdit) return
    if (!confirm(`Remove ${fmtQty(r.quantity)} of ${r.item_code} from ${r.location_code}?`)) return
    const { error } = await supabase.from('wms_stock').delete().eq('id', r.id)
    if (error) { alert(error.message); return }
    load()
  }

  // --- Import current on-hand: Item Code | Location | Quantity | Batch? | Expiry? ---
  const parsed = useMemo(() => parseStock(pasteText, locByCode), [pasteText, locByCode])
  const importSummary = useMemo(() => {
    const unknownLoc = new Set<string>(), unknownItem = new Set<string>()
    let ok = 0
    for (const p of parsed.rows) {
      if (!p.location_id) unknownLoc.add(p.locationRaw)
      else { ok++; if (!itemByCode.has(p.item_code)) unknownItem.add(p.item_code) }
    }
    return { ok, unknownLoc: [...unknownLoc], unknownItem: [...unknownItem], bad: parsed.bad }
  }, [parsed, itemByCode])

  async function runImport() {
    if (!canEdit) return
    setBusy(true); setErr('')
    const good = parsed.rows.filter(p => p.location_id)
    // resolve item ids in one shot
    const idByCode = new Map(items.map(i => [i.code.toUpperCase(), null as string | null]))
    const codes = [...new Set(good.map(g => g.item_code))]
    for (let i = 0; i < codes.length; i += 500) {
      const chunk = codes.slice(i, i + 500)
      const { data } = await supabase.from('items').select('id, code').in('code', chunk)
      for (const d of (data as { id: string; code: string }[] || [])) idByCode.set(d.code.toUpperCase(), d.id)
    }
    const payloads = good.map(g => ({
      warehouse_code: WAREHOUSE, item_id: idByCode.get(g.item_code) ?? null, item_code: g.item_code,
      description: itemByCode.get(g.item_code)?.description ?? null,
      location_id: g.location_id, location_code: g.location_code,
      batch_no: g.batch, exp_date: g.exp_date, quantity: g.quantity,
      uom: itemByCode.get(g.item_code)?.unit ?? null,
    }))
    for (let i = 0; i < payloads.length; i += 500) {
      const chunk = payloads.slice(i, i + 500)
      const { error } = await supabase.from('wms_stock').upsert(chunk, { onConflict: 'warehouse_code,item_code,location_id,batch_no' })
      if (error) { setErr(error.message); setBusy(false); return }
    }
    setBusy(false); setShowImport(false); setPasteText(''); load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Warehouse Stock</h1>
            <p className="text-gray-500 text-sm mt-1">On-hand by item, bin and batch in the 8BT warehouse.</p>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              <button onClick={() => { setShowImport(true); setErr('') }}
                className="border border-emerald-600 text-emerald-700 px-4 py-2 rounded-lg hover:bg-emerald-50 text-sm font-medium">
                ⇪ Import stock
              </button>
              <button onClick={openCreate}
                className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 text-sm font-medium">
                + Add / adjust stock
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Stat label="Total quantity" value={fmtQty(stats.qty)} accent="text-emerald-700" />
          <Stat label="Distinct items" value={stats.items.toString()} />
          <Stat label="Bins used" value={stats.bins.toString()} />
          <Stat label="Stock lines" value={stats.lines.toString()} accent="text-gray-400" />
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item / description / bin / batch…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'item' | 'bin')} className="border rounded-lg px-3 py-2 text-sm">
            <option value="item">Sort by item</option>
            <option value="bin">Sort by bin</option>
          </select>
        </div>

        {showForm && (
          <form onSubmit={saveOne} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{editing ? 'Adjust stock' : 'Add / set stock in a bin'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Item</label>
                {editing
                  ? <input value={`${form.itemCode}  ${form.description}`} disabled className="w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-500 text-sm" />
                  : <ItemPicker items={items} value={form.itemCode ? `${form.itemCode} — ${form.description}` : ''}
                      onPick={it => setForm(f => ({ ...f, itemCode: it.code, description: it.description, uom: it.unit }))} />}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Bin / location</label>
                <input list="wms-locs" value={form.locationCode} onChange={e => setForm({ ...form, locationCode: e.target.value.toUpperCase() })}
                  className="w-full border rounded-lg px-3 py-2 font-mono text-sm disabled:bg-gray-100" placeholder="A105" disabled={!!editing} required />
                <datalist id="wms-locs">{locs.slice(0, 2000).map(l => <option key={l.id} value={l.code} />)}</datalist>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Batch <span className="text-gray-400 font-normal">(blank = none)</span></label>
                <input value={form.batch} onChange={e => setForm({ ...form, batch: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 font-mono text-sm disabled:bg-gray-100" disabled={!!editing} placeholder="260606" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Expiry <span className="text-gray-400 font-normal">(optional)</span></label>
                <input type="date" value={form.exp_date} onChange={e => setForm({ ...form, exp_date: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Quantity</label>
                <input value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value.replace(/[^0-9.]/g, '') })}
                  className="w-full border rounded-lg px-3 py-2 text-sm" inputMode="decimal" placeholder="0" required />
              </div>
            </div>
            {editing && <p className="text-xs text-gray-500">Editing sets the on-hand for <b>{editing.item_code}</b> · bin <b>{editing.location_code}</b> · batch <b>{editing.batch_no || '—'}</b>.</p>}
            {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{err}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={busy}
                className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </form>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {['Item', 'Description', 'Bin', 'Batch', 'Expiry', 'Qty', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400">
                  No stock {rows.length ? 'matches the search' : 'yet — use “Import stock” or “Add / adjust stock”'}.
                </td></tr>
              )}
              {filtered.map(r => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono font-medium">{r.item_code}</td>
                  <td className="px-4 py-2.5 text-gray-600 max-w-[240px] truncate">{r.description}</td>
                  <td className="px-4 py-2.5 font-mono">{r.location_code}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{r.batch_no || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-xs">{fmtDate(r.exp_date) || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 font-medium tabular-nums">{fmtQty(r.quantity)}{r.uom ? <span className="text-gray-400 text-xs"> {r.uom}</span> : ''}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {canEdit ? (
                      <div className="flex gap-3">
                        <button onClick={() => openEdit(r)} className="text-emerald-700 hover:underline text-xs">Adjust</button>
                        <button onClick={() => remove(r)} className="text-red-500 hover:underline text-xs">Remove</button>
                      </div>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">Showing {filtered.length} of {stats.lines} stock lines.</p>
      </div>

      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowImport(false)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">Import current stock from SQL Account</h2>
            <p className="text-sm text-gray-500 mb-2">
              Paste rows in this column order (tab or spaces between):
            </p>
            <p className="text-xs font-mono bg-gray-50 border rounded p-2 mb-3">Item&nbsp;Code &nbsp; Location &nbsp; Quantity &nbsp; Batch(optional) &nbsp; Expiry(optional)</p>
            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={9}
              placeholder={'S104-1\tA105\t420\t260606\t2027-06-06\nSUGAR-50\tA106\t1200'}
              className="w-full border rounded-lg px-3 py-2 font-mono text-xs" />
            {parsed.rows.length > 0 && (
              <div className="mt-3 text-sm bg-gray-50 border rounded-lg p-3 space-y-1">
                <p><b>{importSummary.ok}</b> stock lines ready to import.</p>
                {importSummary.unknownLoc.length > 0 && <p className="text-red-600 text-xs">⚠ {importSummary.unknownLoc.length} row(s) skipped — bin not in Location Map: <span className="font-mono">{importSummary.unknownLoc.slice(0, 8).join(', ')}{importSummary.unknownLoc.length > 8 ? '…' : ''}</span></p>}
                {importSummary.unknownItem.length > 0 && <p className="text-amber-600 text-xs">⚠ {importSummary.unknownItem.length} item code(s) not in Items master (imported anyway, unlinked): <span className="font-mono">{importSummary.unknownItem.slice(0, 8).join(', ')}{importSummary.unknownItem.length > 8 ? '…' : ''}</span></p>}
                {importSummary.bad > 0 && <p className="text-gray-500 text-xs">{importSummary.bad} line(s) ignored (missing item/qty).</p>}
                <p className="text-gray-500 text-xs">Preview: {parsed.rows.slice(0, 3).map(p => `${p.item_code}→${p.locationRaw}=${p.quantity}`).join('  ·  ')}</p>
              </div>
            )}
            {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded mt-3">{err}</p>}
            <div className="flex gap-3 mt-4">
              <button onClick={runImport} disabled={busy || importSummary.ok === 0}
                className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
                {busy ? 'Importing…' : `Import ${importSummary.ok} line${importSummary.ok === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setShowImport(false)} className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm px-4 py-3">
      <div className={`text-2xl font-bold ${accent || 'text-gray-800'}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  )
}

// Positional parse: Item Code | Location | Quantity | Batch? | Expiry?
// Location may be a bare code (A105) or a full path (8BT/Stock/SL/A105) — we take the
// last segment and match it to the Location Map. Rows with an unknown bin are flagged.
type Row = { item_code: string; locationRaw: string; location_code: string; location_id: string | null; quantity: number; batch: string; exp_date: string | null }
function parseStock(text: string, locByCode: Map<string, { id: string; code: string }>) {
  const rows: Row[] = []
  let bad = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const t = line.split(/\t|\s{2,}/).map(x => x.trim()).filter(Boolean)
    if (t.length < 3) { if (line) bad++; continue }
    const item_code = t[0].toUpperCase()
    const locationRaw = t[1]
    const location_code = locationRaw.split('/').pop()!.trim().toUpperCase()
    const quantity = Number(String(t[2]).replace(/[, ]/g, ''))
    const batch = (t[3] || '').trim()
    const exp = (t[4] || '').trim()
    const exp_date = /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : null
    if (!item_code || !isFinite(quantity)) { bad++; continue }
    const loc = locByCode.get(location_code)
    rows.push({ item_code, locationRaw, location_code, location_id: loc?.id ?? null, quantity, batch, exp_date })
  }
  return { rows, bad }
}
