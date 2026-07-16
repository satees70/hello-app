'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import ItemPicker from '@/components/ItemPicker'
import WarehouseTabs, { passWh, WhFilter } from '@/components/WarehouseTabs'
import { downloadCsv } from '@/lib/csv'

// Stock Card (qty) — the running ledger for one item: every movement in/out with a
// running balance, like SQL Accounting's Stock Card. Filter by stock group (narrows the
// item list), item, location, batch and date range. Balance is whole-warehouse on-hand;
// internal bin-to-bin transfers net to zero. Filtered to a location, In/Out are relative
// to that location.

interface Item { code: string; description: string; unit: string; stock_group: string | null }
interface Loc { code: string }
interface Move { id: string; move_type: string; item_code: string; description: string | null; from_location_code: string | null; to_location_code: string | null; batch_no: string; exp_date: string | null; quantity: number; reference: string | null; moved_by_name: string | null; created_at: string }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => n === 0 ? '' : clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtBal = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const dOnly = (iso: string) => iso.slice(0, 10)
const TYPE_LABEL: Record<string, string> = { receipt: 'Receipt', putaway: 'Putaway', pick: 'Pick', transfer: 'Transfer', adjust: 'Adjustment', dispatch: 'Dispatch' }

export default function StockCardPage() {
  const { profile, loading } = useProfile()
  const [items, setItems] = useState<Item[]>([])
  const [locs, setLocs] = useState<Loc[]>([])
  const [moves, setMoves] = useState<Move[]>([])
  const [busy, setBusy] = useState(false)

  const [group, setGroup] = useState('')
  const [wh, setWh] = useState<WhFilter>('all')
  const [itemCode, setItemCode] = useState(''); const [itemLabel, setItemLabel] = useState('')
  const [loc, setLoc] = useState(''); const [batch, setBatch] = useState('')
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')

  useEffect(() => { if (profile) init() }, [profile])
  const init = useCallback(async () => {
    const [it, lo] = await Promise.all([
      fetchAll<Item>('items', 'code, description, unit, stock_group', 'code'),
      fetchAll<Loc>('wms_locations', 'code', 'code'),
    ])
    setItems(it); setLocs(lo)
  }, [])

  // Item list narrowed by stock group + warehouse, for the picker.
  const pickItems = useMemo(() => items.filter(i => (!group || i.stock_group === group) && passWh(wh, i.description)), [items, group, wh])
  const groups = useMemo(() => [...new Set(items.map(i => i.stock_group).filter(Boolean) as string[])].sort(), [items])

  async function loadMoves(code: string) {
    setBusy(true)
    const { data } = await supabase.from('wms_stock_moves')
      .select('id, move_type, item_code, description, from_location_code, to_location_code, batch_no, exp_date, quantity, reference, moved_by_name, created_at')
      .eq('item_code', code).order('created_at', { ascending: true }).limit(5000)
    setMoves((data as Move[]) || [])
    setBusy(false)
  }
  function pickItem(it: { code: string; description: string }) {
    setItemCode(it.code); setItemLabel(`${it.code} — ${it.description}`); loadMoves(it.code)
  }

  const L = loc.trim().toUpperCase()
  const B = batch.trim()
  // In / Out for a move given the location scope.
  const inOut = useCallback((m: Move): { inQ: number; outQ: number } => {
    const q = Number(m.quantity)
    if (L) return { inQ: (m.to_location_code || '').toUpperCase() === L ? q : 0, outQ: (m.from_location_code || '').toUpperCase() === L ? q : 0 }
    return { inQ: m.to_location_code ? q : 0, outQ: m.from_location_code ? q : 0 }
  }, [L])

  // Ledger: opening balance (everything before `from`) + the in-range rows with a running balance.
  const card = useMemo(() => {
    const scoped = moves
      .filter(m => !B || m.batch_no === B)
      .filter(m => !L || (m.from_location_code || '').toUpperCase() === L || (m.to_location_code || '').toUpperCase() === L)
    let bal = 0, opening = 0
    const rows: (Move & { inQ: number; outQ: number; balance: number })[] = []
    for (const m of scoped) {
      const { inQ, outQ } = inOut(m)
      bal = clean(bal + inQ - outQ)
      const d = dOnly(m.created_at)
      if (from && d < from) { opening = bal; continue }
      if (to && d > to) continue
      rows.push({ ...m, inQ, outQ, balance: bal })
    }
    const totIn = clean(rows.reduce((s, r) => s + r.inQ, 0))
    const totOut = clean(rows.reduce((s, r) => s + r.outQ, 0))
    const closing = rows.length ? rows[rows.length - 1].balance : opening
    return { rows, opening, totIn, totOut, closing }
  }, [moves, from, to, L, B, inOut])

  const unit = useMemo(() => items.find(i => i.code === itemCode)?.unit || '', [items, itemCode])

  function exportCsv() {
    const head = ['Date', 'Type', 'Reference', 'From', 'To', 'Batch', 'In', 'Out', 'Balance']
    const body: (string | number)[][] = []
    if (from) body.push(['', 'Opening balance', '', '', '', '', '', '', fmtBal(card.opening)])
    card.rows.forEach(r => body.push([fmtTime(r.created_at), TYPE_LABEL[r.move_type] || r.move_type, r.reference || '', r.from_location_code || '', r.to_location_code || '', r.batch_no || '', fmtQty(r.inQ), fmtQty(r.outQ), fmtBal(r.balance)]))
    body.push(['', 'Closing balance', '', '', '', '', fmtQty(card.totIn), fmtQty(card.totOut), fmtBal(card.closing)])
    downloadCsv(`StockCard_${itemCode.replace(/[\/\s]/g, '-')}.csv`, head, body)
  }
  async function exportPdf() {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape' })
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS SDN BHD', 14, 15)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal'); doc.text('STOCK CARD (QTY)', 14, 22)
    doc.setFontSize(10)
    doc.text(`Item: ${itemLabel || itemCode}`, 14, 30)
    doc.text([L ? `Location: ${L}` : 'Location: all', B ? `Batch: ${B}` : 'Batch: all', (from || to) ? `Period: ${from || '…'} → ${to || '…'}` : 'Period: all'].join('    '), 14, 36)
    const body: (string | number)[][] = []
    if (from) body.push(['', 'Opening balance', '', '', '', '', '', '', fmtBal(card.opening)])
    card.rows.forEach(r => body.push([fmtTime(r.created_at), TYPE_LABEL[r.move_type] || r.move_type, r.reference || '', r.from_location_code || '', r.to_location_code || '', r.batch_no || '', fmtQty(r.inQ), fmtQty(r.outQ), fmtBal(r.balance)]))
    body.push(['', 'Closing balance', '', '', '', '', fmtQty(card.totIn), fmtQty(card.totOut), fmtBal(card.closing)])
    autoTable(doc, {
      startY: 42,
      head: [['Date', 'Type', 'Reference', 'From', 'To', 'Batch', 'In', 'Out', 'Balance']],
      body,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [4, 120, 87] },
      columnStyles: { 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
    })
    doc.save(`StockCard_${itemCode.replace(/[\/\s]/g, '-')}.pdf`)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold">Stock Card</h1>
            <p className="text-gray-500 text-sm mt-1">Every movement for one item with a running balance. <Link href="/wms/reports" className="text-emerald-700 underline">Stock Reports</Link> · <Link href="/wms/reports/activity" className="text-emerald-700 underline">Activity</Link></p>
          </div>
          {itemCode && <div className="flex gap-2">
            <button onClick={exportCsv} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button>
            <button onClick={exportPdf} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ PDF</button>
          </div>}
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-4 mb-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Stock group</label>
            <select value={group} onChange={e => setGroup(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="">All groups</option>{groups.map(g => <option key={g} value={g}>{g}</option>)}</select>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Item</label>
            <ItemPicker items={pickItems} value={itemLabel} onPick={pickItem} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Warehouse</label>
            <WarehouseTabs value={wh} onChange={setWh} className="w-full" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Location <span className="text-gray-400">(optional)</span></label>
            <input list="sc-locs" value={loc} onChange={e => setLoc(e.target.value)} placeholder="all bins" className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
            <datalist id="sc-locs">{locs.map(l => <option key={l.code} value={l.code} />)}</datalist>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Batch <span className="text-gray-400">(optional)</span></label>
            <input value={batch} onChange={e => setBatch(e.target.value)} placeholder="all batches" className="w-full border rounded-lg px-3 py-2 text-sm font-mono" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>

        {!itemCode ? <div className="bg-white rounded-xl border p-10 text-center text-gray-400 text-sm">Pick an item to see its stock card.</div>
          : busy ? <div className="text-gray-400 py-16 text-center">Loading…</div>
          : <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold tabular-nums">{fmtBal(card.opening)}</div><div className="text-xs text-gray-500 mt-0.5">Opening{unit ? ` (${unit})` : ''}</div></div>
                <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-emerald-600 tabular-nums">{fmtBal(card.totIn)}</div><div className="text-xs text-gray-500 mt-0.5">Total in</div></div>
                <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-amber-600 tabular-nums">{fmtBal(card.totOut)}</div><div className="text-xs text-gray-500 mt-0.5">Total out</div></div>
                <div className="bg-white rounded-xl border shadow-sm px-4 py-3"><div className="text-2xl font-bold text-emerald-700 tabular-nums">{fmtBal(card.closing)}</div><div className="text-xs text-gray-500 mt-0.5">Closing{unit ? ` (${unit})` : ''}</div></div>
              </div>

              <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b"><tr>{['Date', 'Type', 'Reference', 'From', 'To', 'Batch', 'In', 'Out', 'Balance'].map(h => <th key={h} className={`px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap ${['In', 'Out', 'Balance'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
                  <tbody>
                    {from && <tr className="border-b bg-gray-50/60"><td className="px-3 py-2 text-gray-500 italic" colSpan={8}>Opening balance{(from ? ` as of ${from}` : '')}</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtBal(card.opening)}</td></tr>}
                    {card.rows.length === 0 && !from && <tr><td colSpan={9} className="text-center py-10 text-gray-400">No movements for this item{L ? ` in ${L}` : ''}{B ? ` · batch ${B}` : ''}.</td></tr>}
                    {card.rows.map(r => (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtTime(r.created_at)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{TYPE_LABEL[r.move_type] || r.move_type}</td>
                        <td className="px-3 py-2 text-gray-500 text-xs">{r.reference || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.from_location_code || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.to_location_code || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.batch_no || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmtQty(r.inQ)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-amber-700">{fmtQty(r.outQ)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtBal(r.balance)}</td>
                      </tr>
                    ))}
                    {card.rows.length > 0 && <tr className="border-t-2 bg-gray-50 font-semibold"><td className="px-3 py-2" colSpan={6}>Closing balance</td><td className="px-3 py-2 text-right tabular-nums text-emerald-700">{fmtBal(card.totIn)}</td><td className="px-3 py-2 text-right tabular-nums text-amber-700">{fmtBal(card.totOut)}</td><td className="px-3 py-2 text-right tabular-nums">{fmtBal(card.closing)}</td></tr>}
                  </tbody>
                </table>
              </div>
            </>}
      </div>
    </div>
  )
}
