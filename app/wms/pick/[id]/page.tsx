'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ScanGate from '@/components/ScanGate'
import { matchBin, matchItem } from '@/lib/qr'

interface Order { id: string; order_no: string | null; customer_name: string | null; status: string; delivery_date: string | null; source: string | null; pick_checked_by_name: string | null; pick_checked_at: string | null; pick_check_note: string | null; assigned_to_name: string | null; pick_started_at: string | null; pick_completed_at: string | null }
interface Line { id: string; line_no: number | null; item_id: string | null; item_code: string; description: string | null; quantity: number; qty_picked: number; uom: string | null; source_hint: string | null; remarks: string | null; no_stock?: boolean; no_stock_qty?: number | null; no_stock_by_name?: string | null }
interface Stock { id: string; item_code: string; location_id: string; location_code: string; batch_no: string; exp_date: string | null; quantity: number; created_at: string }
interface Loc { id: string; code: string; location_type: string; pick_sequence: number | null; pickable: boolean }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
// FEFO effective expiry: real expiry, else (batch date YYMMDD + 1 year), else
// (received date + 1 year). Used only to sort; never stored or shown.
const plusYear = (ymd: string) => { const d = new Date(ymd + 'T00:00:00'); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10) }
const batchDate = (batch: string): string | null => {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(batch || ''); if (!m) return null
  const mo = Number(m[2]), d = Number(m[3]); if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `20${m[1]}-${m[2]}-${m[3]}`
}
const effExp = (s: { exp_date: string | null; batch_no: string; created_at: string }) => {
  if (s.exp_date) return s.exp_date
  const bd = batchDate(s.batch_no); return bd ? plusYear(bd) : plusYear(s.created_at.slice(0, 10))
}
const STATUS_CHIP: Record<string, string> = {
  Review: 'bg-amber-100 text-amber-700', Released: 'bg-emerald-100 text-emerald-700',
  Picking: 'bg-emerald-100 text-emerald-700', Picked: 'bg-emerald-100 text-emerald-700',
  Checked: 'bg-teal-100 text-teal-700',
}

export default function WmsPickPage() {
  const { id } = useParams<{ id: string }>()
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const isAdmin = profile?.role === 'admin'

  const [order, setOrder] = useState<Order | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [stock, setStock] = useState<Stock[]>([])
  const [resd, setResd] = useState<Map<string, number>>(new Map())   // reserved by OTHER orders
  const [locMeta, setLocMeta] = useState<Map<string, Loc>>(new Map())
  const [chosen, setChosen] = useState<Record<string, string>>({})   // lineId -> stock.id
  const [qtyInput, setQtyInput] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [scanFor, setScanFor] = useState<{ line: Line; stock: Stock; qty: number } | null>(null)
  const [pickMode, setPickMode] = useState<'manual' | 'scan'>('manual')
  const [checkNote, setCheckNote] = useState('')
  const [checkedQty, setCheckedQty] = useState<Record<string, string>>({})   // lineId → verified qty
  const [pendingCorr, setPendingCorr] = useState(false)                       // a qty correction awaits HO
  const [manualPending, setManualPending] = useState<Set<string>>(new Set())  // line ids with a manual fill awaiting HO
  const [manualFor, setManualFor] = useState<Line | null>(null)   // manual-fill modal target
  const [mfLoc, setMfLoc] = useState(''); const [mfBatch, setMfBatch] = useState(''); const [mfQty, setMfQty] = useState('')
  const [issueFor, setIssueFor] = useState<Line | null>(null)     // raise-issue modal target
  const [issueFlags, setIssueFlags] = useState<{ qty: boolean; batch: boolean; damaged: boolean; other: boolean }>({ qty: false, batch: false, damaged: false, other: false })
  const [issueNote, setIssueNote] = useState('')
  useEffect(() => { const m = localStorage.getItem('wmsPickMode'); if (m === 'scan' || m === 'manual') setPickMode(m) }, [])
  const setMode = (m: 'manual' | 'scan') => { setPickMode(m); try { localStorage.setItem('wmsPickMode', m) } catch { /* ignore */ } }

  const load = useCallback(async () => {
    const { data: o } = await supabase.from('wms_orders').select('id, order_no, customer_name, status, delivery_date, source, pick_checked_by_name, pick_checked_at, pick_check_note, assigned_to_name, pick_started_at, pick_completed_at').eq('id', id).single()
    const { data: ls } = await supabase.from('wms_order_lines').select('*').eq('order_id', id).order('line_no')
    const lineList = (ls as Line[]) || []
    const codes = [...new Set(lineList.map(l => l.item_code))]
    const st = codes.length
      ? (await supabase.from('wms_stock').select('id, item_code, location_id, location_code, batch_no, exp_date, quantity, created_at').in('item_code', codes)).data as Stock[]
      : []
    const locs = await fetchAll<Loc>('wms_locations', 'id, code, location_type, pick_sequence, pickable')
    // stock reserved for OTHER orders — not available to this one
    const rmap = new Map<string, number>()
    if (codes.length) {
      const { data: res } = await supabase.from('wms_reservations').select('item_code, location_id, batch_no, qty').eq('status', 'active').neq('order_id', id).in('item_code', codes)
      for (const r of (res as { item_code: string; location_id: string; batch_no: string; qty: number }[] || [])) {
        const k = `${r.item_code.toUpperCase()}|${r.location_id}|${r.batch_no}`
        rmap.set(k, (rmap.get(k) || 0) + Number(r.qty))
      }
    }
    const { count: pc } = await supabase.from('wms_check_qty_requests').select('id', { count: 'exact', head: true }).eq('order_id', id).eq('status', 'Pending')
    setPendingCorr((pc || 0) > 0)
    const { data: mp } = await supabase.from('wms_manual_pick_requests').select('line_id').eq('order_id', id).eq('status', 'Pending')
    setManualPending(new Set(((mp as { line_id: string }[]) || []).map(x => x.line_id)))
    setOrder((o as Order) || null); setLines(lineList); setStock(st || []); setResd(rmap)
    setLocMeta(new Map(locs.map(l => [l.id, l])))
    setChosen({}); setQtyInput({})
  }, [id])

  useEffect(() => { if (profile) load() }, [profile, load])

  // On-hand minus what OTHER orders have reserved at that exact bin/batch.
  const availQty = useCallback((s: Stock) => clean(s.quantity - (resd.get(`${s.item_code.toUpperCase()}|${s.location_id}|${s.batch_no}`) || 0)), [resd])

  // Available stock for an item, best-first: SL bins, then earliest expiry, then walking order.
  const availFor = useCallback((itemCode: string) => {
    return stock.filter(s => s.item_code === itemCode && availQty(s) > 0 && locMeta.get(s.location_id)?.location_type !== 'STAGE' && locMeta.get(s.location_id)?.pickable !== false).slice().sort((a, b) => {
      const la = locMeta.get(a.location_id), lb = locMeta.get(b.location_id)
      const slA = la?.location_type === 'SL' ? 0 : 1, slB = lb?.location_type === 'SL' ? 0 : 1
      if (slA !== slB) return slA - slB
      const ea = effExp(a), eb = effExp(b)   // no expiry → treated as received + 1 year (FEFO only)
      if (ea !== eb) return ea < eb ? -1 : 1
      return (la?.pick_sequence ?? 999999) - (lb?.pick_sequence ?? 999999) || a.location_code.localeCompare(b.location_code)
    })
  }, [stock, locMeta, availQty])

  const remainingOf = (l: Line) => clean(l.quantity - l.qty_picked)

  // FEFO allocation (which bins/batches to pull) for the printed pick list.
  const allocate = useCallback((itemCode: string, need: number) => {
    const rows = availFor(itemCode)
    const allocs: { bin: string; batch: string; exp: string | null; qty: number }[] = []
    let left = need
    for (const r of rows) {
      if (left <= 0) break
      const take = Math.min(r.quantity, left)
      allocs.push({ bin: r.location_code, batch: r.batch_no, exp: r.exp_date, qty: take })
      left = clean(left - take)
    }
    return { allocs, shortfall: Math.max(clean(left), 0) }
  }, [availFor])

  // Outstanding (no-stock) qty for a line: what still can't be fulfilled. A line confirmed
  // "no stock" is short by its recorded shortfall (or the whole remaining); otherwise it's
  // whatever the FEFO allocation can't cover.
  const shortOf = useCallback((l: Line): number => {
    const rem = remainingOf(l)
    if (rem <= 0) return 0
    if (l.no_stock) return clean(Number(l.no_stock_qty ?? rem))
    return allocate(l.item_code, rem).shortfall
  }, [allocate])

  async function downloadPickList() {
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape' })
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN BHD', 14, 15)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal')
    doc.text('WAREHOUSE PICKING LIST', 14, 22)
    doc.setFontSize(10)
    doc.text(`Order: ${order?.order_no || '-'}`, 14, 30)
    doc.text(`Customer: ${order?.customer_name || '-'}`, 14, 36)
    if (order?.delivery_date) doc.text(`Delivery: ${order.delivery_date}`, 150, 30)
    doc.text(`Printed: ${new Date().toLocaleString('en-GB')}`, 150, 36)
    const body: string[][] = []
    let n = 1
    for (const l of lines) {
      const rem = remainingOf(l)
      if (rem <= 0) continue
      const { allocs, shortfall } = allocate(l.item_code, rem)
      if (allocs.length === 0) {
        body.push([String(n++), l.item_code, l.description || '', l.uom || '', '— no stock —', '', '', fmtQty(rem), '☐'])
      } else {
        allocs.forEach((a, i) => body.push([
          i === 0 ? String(n) : '', i === 0 ? l.item_code : '', i === 0 ? (l.description || '') : '', i === 0 ? (l.uom || '') : '',
          a.bin, a.batch || '', a.exp ? fmtDate(a.exp) : '', fmtQty(a.qty), '☐',
        ]))
        if (shortfall > 0) body.push(['', '', `(short by ${fmtQty(shortfall)} — not enough stock)`, '', '', '', '', '', ''])
        n++
      }
    }
    autoTable(doc, {
      startY: 42,
      head: [['#', 'Item Code', 'Description', 'Unit', 'Bin', 'Batch', 'Exp', 'Qty', '✓']],
      body,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [4, 120, 87] },
      columnStyles: { 7: { halign: 'right' }, 8: { halign: 'center' } },
    })
    const endY = ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY) + 14
    doc.text('Picked by: ______________  Date: ________', 14, endY)
    doc.text('Checked by: _____________  Date: ________', 150, endY)
    doc.save(`PickList_${(order?.order_no || 'order').replace(/[\/\s]/g, '-')}.pdf`)
  }

  // Print only the items that have no stock (outstanding / short) — for procurement / production.
  async function downloadOutstanding() {
    const short = lines.map(l => ({ l, s: shortOf(l) })).filter(x => x.s > 0)
    if (short.length === 0) { setMsg('Nothing outstanding — every item has stock.'); return }
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF()
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text('SRRI EASWARI MILLS SDN BHD', 14, 15)
    doc.setFontSize(11); doc.setFont('helvetica', 'normal')
    doc.text('OUTSTANDING (NO STOCK) LIST', 14, 22)
    doc.setFontSize(10)
    doc.text(`Order: ${order?.order_no || '-'}`, 14, 30)
    doc.text(`Customer: ${order?.customer_name || '-'}`, 14, 36)
    if (order?.delivery_date) doc.text(`Delivery: ${order.delivery_date}`, 140, 30)
    doc.text(`Printed: ${new Date().toLocaleString('en-GB')}`, 140, 36)
    autoTable(doc, {
      startY: 42,
      head: [['#', 'Item Code', 'Description', 'Unit', 'Ordered', 'Picked', 'Outstanding']],
      body: short.map((x, i) => [String(i + 1), x.l.item_code, x.l.description || '', x.l.uom || '', fmtQty(x.l.quantity), fmtQty(x.l.qty_picked), fmtQty(x.s)]),
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [180, 83, 9] },
      columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    })
    doc.save(`Outstanding_${(order?.order_no || 'order').replace(/[\/\s]/g, '-')}.pdf`)
  }

  async function pickFromBin(l: Line, s: Stock, qty: number) {
    if (!canEdit || qty <= 0) return
    setBusy(l.id); setErr(''); setMsg('')
    const { data, error } = await supabase.rpc('wms_pick_from_bin', {
      p_line_id: l.id, p_location_id: s.location_id, p_batch: s.batch_no, p_qty: qty, p_reference: order?.order_no ?? null,
    })
    setBusy('')
    if (error) { setErr(error.message); return }
    const res = data as { picked: number; requested: number }
    setMsg(res.picked < res.requested
      ? `Picked ${fmtQty(res.picked)} of ${l.item_code} from ${s.location_code} (bin only had that much).`
      : `Picked ${fmtQty(res.picked)} of ${l.item_code} from ${s.location_code}.`)
    load()
  }

  // Picker confirms there's no stock for the remaining qty — records the shortfall and lets
  // the order move on (ships only what's picked). Works for partial (pick what's there first).
  async function confirmNoStock(l: Line) {
    if (!canEdit) return
    const rem = remainingOf(l)
    if (!confirm(`Confirm there is NO stock for ${l.item_code}?\n\nThe remaining ${fmtQty(rem)} ${l.uom || ''} will be marked short, and the order can move on with only what's picked.`)) return
    setBusy(l.id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_confirm_no_stock', { p_line_id: l.id, p_note: null })
    setBusy('')
    if (error) { setErr(/wms_confirm_no_stock|no_stock|function|column/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-no-stock.sql in the Supabase SQL editor.' : error.message); return }
    setMsg(`${l.item_code} marked as no stock (short ${fmtQty(rem)}).`); load()
  }

  // Not enough in the system, but the stock is physically there: the picker says which bin + batch
  // and how much; it's sent to Head Office (HOD). On approval it books a real pick OUT of that bin.
  function openManual(l: Line) {
    if (!canEdit) return
    const rem = remainingOf(l)
    if (rem <= 0) return
    const sug = availFor(l.item_code)[0]
    setManualFor(l); setMfLoc(sug?.location_id || ''); setMfBatch(sug?.batch_no || ''); setMfQty(String(clean(rem))); setErr(''); setMsg('')
  }
  async function submitManual() {
    if (!manualFor) return
    const l = manualFor
    const rem = remainingOf(l)
    const qty = Number(mfQty)
    if (!mfLoc) { setErr('Choose the bin you are filling from.'); return }
    if (!(qty > 0)) { setErr('Enter a quantity greater than zero.'); return }
    if (qty > rem) { setErr(`Only ${fmtQty(rem)} is still outstanding on this line.`); return }
    setBusy(l.id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('request_wms_manual_pick', { p_line_id: l.id, p_qty: qty, p_location_id: mfLoc, p_batch: mfBatch.trim() || null, p_note: null })
    setBusy('')
    if (error) { setErr(/request_wms_manual_pick|wms_manual_pick_requests|location_id/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-manual-pick.sql then db/2026-07-wms-manual-pick-v2.sql in the Supabase SQL editor.' : error.message); return }
    setManualFor(null)
    setMsg(`Manual fill of ${fmtQty(qty)} ${l.item_code} sent to Head Office for approval.`); load()
  }

  // Picker flags that the info or the physical stock is wrong (qty / batch inaccurate, or the stock
  // is damaged). Posts to the order's discussion thread; Head Office is notified to act.
  function openIssue(l: Line) {
    if (!canEdit) return
    setIssueFor(l); setIssueFlags({ qty: false, batch: false, damaged: false, other: false }); setIssueNote(''); setErr(''); setMsg('')
  }
  async function submitIssue() {
    if (!issueFor || !order?.order_no) return
    const l = issueFor
    const picked = (['qty', 'batch', 'damaged', 'other'] as const).filter(k => issueFlags[k])
    if (picked.length === 0) { setErr('Pick what is wrong.'); return }
    const label: Record<'qty' | 'batch' | 'damaged' | 'other', string> = {
      qty: 'QTY inaccurate', batch: 'BATCH inaccurate', damaged: 'STOCK DAMAGED (bag/gunny)', other: 'OTHER',
    }
    const body = `⚠ Pick issue on ${l.item_code}${l.description ? ` (${l.description})` : ''} — ${picked.map(k => label[k]).join(', ')}.${issueNote.trim() ? ` ${issueNote.trim()}` : ''}`
    setBusy(l.id); setErr(''); setMsg('')
    const { error } = await supabase.from('discussions').insert({
      channel: 'wms', topic: order.order_no, author_id: profile?.id, author_name: profile?.full_name || null,
      body, mention_factories: ['HEAD_OFFICE'],
    })
    setBusy('')
    if (error) { setErr(error.message); return }
    setIssueFor(null)
    setMsg(`Issue raised on ${l.item_code} — Head Office notified. See it in the WMS Discussion (topic ${order.order_no}).`)
  }
  // Stock arrived for a line that was marked no-stock — restore the outstanding qty and re-open
  // the order for picking, so the balance can be picked and dispatched in a later run.
  async function reopenLine(l: Line) {
    if (!canEdit) return
    const out = Number(l.no_stock_qty ?? 0)
    if (!confirm(`Stock has arrived for ${l.item_code}?\n\nThis re-opens the outstanding ${fmtQty(out)} ${l.uom || ''} so you can pick it now.`)) return
    setBusy(l.id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_reopen_line', { p_line_id: l.id })
    setBusy('')
    if (error) { setErr(/wms_reopen_line/.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-repick-outstanding.sql in the Supabase SQL editor.' : error.message); return }
    setMsg(`${l.item_code} re-opened — pick the outstanding ${fmtQty(out)}.`); load()
  }

  // Undo a pick already made (wrong bag / wrong batch / over-picked) — returns the stock to its
  // bin and re-opens the line. Only before the order is checked/dispatched.
  async function undoPick(l: Line) {
    if (!canEdit) return
    const picked = Number(l.qty_picked || 0)
    if (picked <= 0) return
    const ans = window.prompt(`Undo pick for ${l.item_code}?\n\n${fmtQty(picked)} ${l.uom || ''} was picked. How many to put back to its bin?\n(the stock is returned and the line re-opens for picking)`, String(picked))
    if (ans === null) return
    const qty = Number(String(ans).replace(/[^0-9.]/g, ''))
    if (!(qty > 0)) { setErr('Enter a quantity greater than zero to undo.'); return }
    if (qty > picked) { setErr(`Only ${fmtQty(picked)} was picked — you can’t undo more than that.`); return }
    setBusy(l.id); setErr(''); setMsg('')
    const { error } = await supabase.rpc('wms_unpick', { p_line_id: l.id, p_qty: qty })
    setBusy('')
    if (error) { setErr(/wms_unpick|function/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-unpick.sql in the Supabase SQL editor.' : error.message); return }
    setMsg(`Undid ${fmtQty(qty)} of ${l.item_code} — stock returned to its bin.`); load()
  }

  // Optional explicit start (so the timer can include walk time). Otherwise it auto-starts
  // on the first pick.
  async function startPicking() {
    if (!canEdit) return
    setBusy('start'); setErr('')
    const { error } = await supabase.rpc('wms_start_picking', { p_order_id: id })
    setBusy('')
    if (error) { setErr(/wms_start_picking|function/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-pickers.sql in the Supabase SQL editor.' : error.message); return }
    setMsg('Picking started.'); load()
  }
  // Explicit stop — end time; duration = stop − start.
  async function stopPicking() {
    if (!canEdit) return
    setBusy('stop'); setErr('')
    const { error } = await supabase.rpc('wms_stop_picking', { p_order_id: id })
    setBusy('')
    if (error) { setErr(/wms_stop_picking|function/i.test(error.message) && /does not exist|schema cache|could not find/i.test(error.message) ? 'This needs a database update — run db/2026-07-wms-pickable-stop.sql in the Supabase SQL editor.' : error.message); return }
    setMsg('Picking stopped.'); load()
  }
  const pickTaken = () => {
    if (!order?.pick_started_at) return ''
    const end = order.pick_completed_at ? new Date(order.pick_completed_at).getTime() : Date.now()
    const m = Math.max(0, Math.round((end - new Date(order.pick_started_at).getTime()) / 60000))
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
  }

  function startPick(l: Line, s: Stock, qty: number) {
    if (!canEdit || !(qty > 0)) return
    setErr(''); setScanFor({ line: l, stock: s, qty })
  }

  // All bins (for the manual-fill picker) — sorted by code.
  const allLocs = useMemo(() => [...locMeta.values()].filter(l => l.code).sort((a, b) => a.code.localeCompare(b.code)), [locMeta])

  const totals = useMemo(() => ({
    lines: lines.length,
    done: lines.filter(l => remainingOf(l) <= 0).length,
    remaining: clean(lines.reduce((s, l) => s + Math.max(remainingOf(l), 0), 0)),
  }), [lines])
  // A no-stock-only order got flipped to "Picked" even though nothing was actually picked —
  // show it as "Pending — No stock" and don't offer the check step (there's nothing to check).
  const anyPicked = useMemo(() => lines.some(l => Number(l.qty_picked) > 0), [lines])
  const noStockOnly = useMemo(() => lines.length > 0 && !anyPicked && lines.some(l => l.no_stock), [lines, anyPicked])
  const displayStatus = order && order.status === 'Picked' && noStockOnly ? 'Pending — No stock' : order?.status || ''

  // Checker sign-off — a second person approves the picked order before dispatch.
  // A clean check signs off directly; a quantity change is sent to HO for approval
  // (auto-applied if the checker is HO/admin).
  async function confirmCheck() {
    if (!canEdit) return
    setBusy('check'); setErr(''); setMsg('')
    const corrections = lines.map(l => {
      const cq = checkedQty[l.id]
      const checked = cq === undefined || cq === '' ? l.qty_picked : Number(cq)
      return { line_id: l.id, item_code: l.item_code, description: l.description, picked_qty: l.qty_picked, checked_qty: checked }
    }).filter(c => Number(c.checked_qty) !== Number(c.picked_qty))

    if (corrections.length === 0) {
      const { error } = await supabase.rpc('wms_check_pick', { p_order_id: id, p_note: checkNote || null })
      setBusy('')
      if (error) { setErr(needsCheckDb(error.message)); return }
      setMsg('Order checked — it can now be dispatched.'); setCheckNote(''); setCheckedQty({}); load(); return
    }
    const { data, error } = await supabase.rpc('wms_submit_check_correction', { p_order_id: id, p_note: checkNote || null, p_corrections: corrections })
    if (error) { setBusy(''); setErr(needsCheckDb(error.message)); return }
    if (isHO || isAdmin) {
      const { error: e2 } = await supabase.rpc('approve_wms_check_correction', { p_id: data })
      setBusy('')
      if (e2) { setErr(e2.message); return }
      setMsg('Quantities corrected and approved — order checked.'); setCheckNote(''); setCheckedQty({}); load(); return
    }
    setBusy(''); setMsg('Quantity change sent to Head Office for approval. Dispatch stays locked until it’s approved.'); setCheckNote(''); setCheckedQty({}); load()
  }
  const needsCheckDb = (m: string) => /wms_check_pick|pick_checked|Checked|function|column/i.test(m) && /does not exist|schema cache|could not find/i.test(m)
    ? 'This needs a database update — run db/2026-07-wms-order-check.sql in the Supabase SQL editor.' : m

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (!order) return <div className="p-8 text-sm text-gray-500">Order not found. <Link href="/wms/orders" className="text-emerald-700 underline">Back to orders</Link></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <Link href="/wms/orders" className="text-sm text-emerald-700 hover:underline">← Orders to Pick</Link>
        <div className="flex flex-wrap items-center gap-3 mt-2 mb-1">
          <h1 className="text-2xl font-bold">Pick {order.order_no || '(no number)'}</h1>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${noStockOnly && order.status === 'Picked' ? 'bg-amber-100 text-amber-700' : STATUS_CHIP[order.status] || 'bg-gray-100 text-gray-600'}`}>{displayStatus}</span>
        </div>
        <p className="text-gray-500 text-sm mb-1">{order.customer_name || 'Customer ?'}{order.delivery_date ? ` · deliver ${order.delivery_date}` : ''} · {totals.done}/{totals.lines} lines done · {fmtQty(totals.remaining)} still to pick</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400 mb-6">
          <span>{order.assigned_to_name ? `👤 Picker: ${order.assigned_to_name}` : '👤 Unassigned'}</span>
          {order.pick_started_at
            ? <span>· started {new Date(order.pick_started_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            : canEdit && ['Reserved', 'Released', 'Picking'].includes(order.status) && <button onClick={startPicking} disabled={busy === 'start'} className="border border-emerald-600 text-emerald-700 rounded px-2 py-0.5 hover:bg-emerald-50 font-medium">▶ Start picking</button>}
          {order.pick_started_at && !order.pick_completed_at && canEdit && <button onClick={stopPicking} disabled={busy === 'stop'} className="border border-red-500 text-red-600 rounded px-2 py-0.5 hover:bg-red-50 font-medium">■ Stop picking</button>}
          {order.pick_started_at && order.pick_completed_at && <span className="text-gray-500">· ⏱ took {pickTaken()}</span>}
        </div>

        {!canEdit && <p className="text-sm bg-amber-50 text-amber-700 border border-amber-200 rounded-lg p-3 mb-4">You have view-only warehouse access, so you can’t book picks.</p>}
        {err && <p className="text-red-600 text-sm bg-red-50 border border-red-200 p-3 rounded-lg mb-4">{err}</p>}
        {msg && <p className="text-emerald-700 text-sm bg-emerald-50 border border-emerald-200 p-3 rounded-lg mb-4">✓ {msg}</p>}

        <div className="flex flex-wrap items-center gap-2 mb-5">
          <button onClick={downloadPickList} className="border px-4 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium">⬇ Print pick list (PDF)</button>
          {lines.some(l => shortOf(l) > 0) && <button onClick={downloadOutstanding} className="border border-amber-300 text-amber-800 bg-amber-50 px-4 py-2 rounded-lg hover:bg-amber-100 text-sm font-medium">⬇ Print outstanding (no stock)</button>}
          {canEdit && (
            <div className="inline-flex rounded-lg border bg-white p-1 text-sm ml-auto">
              <span className="px-2 py-1 text-gray-400 text-xs self-center">Pick by:</span>
              {(['manual', 'scan'] as const).map(m => (
                <button key={m} onClick={() => setMode(m)} className={`px-3 py-1 rounded-md font-medium ${pickMode === m ? 'bg-emerald-700 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>{m === 'manual' ? 'Manual' : '📷 Scan'}</button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          {lines.map(l => {
            const rem = remainingOf(l)
            const done = rem <= 0
            const avail = availFor(l.item_code)
            const totalAvail = clean(avail.reduce((s, a) => s + availQty(a), 0))
            const chosenId = chosen[l.id] ?? avail[0]?.id ?? ''
            const chosenStock = avail.find(a => a.id === chosenId) || avail[0]
            const defQty = chosenStock ? Math.min(rem, availQty(chosenStock)) : rem
            const input = qtyInput[l.id] ?? (rem > 0 ? String(clean(defQty)) : '')
            return (
              <div key={l.id} className={`bg-white rounded-xl border shadow-sm p-4 ${done ? 'opacity-70' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-mono font-semibold">{l.item_code}{!l.item_id && <span className="ml-1 text-amber-600" title="Not in Items master">⚠</span>}</div>
                    <div className="text-sm text-gray-500 max-w-[440px]">{l.description}</div>
                    <div className="text-xs text-gray-500 mt-1 tabular-nums">
                      Ordered <b>{fmtQty(l.quantity)}</b>{l.uom ? ' ' + l.uom : ''} · Picked <b className="text-emerald-700">{fmtQty(l.qty_picked)}</b> · Remaining <b className={rem > 0 ? 'text-amber-600' : 'text-gray-400'}>{fmtQty(rem)}</b>
                    </div>
                    {(l.source_hint || l.remarks) && (
                      <div className="text-[11px] text-gray-400 mt-0.5">From SQL Account: {l.source_hint || '—'}{l.remarks ? ` · note “${l.remarks}”` : ''}</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    {l.no_stock
                      ? <>
                          <span className="text-amber-600 text-sm font-medium whitespace-nowrap" title={l.no_stock_by_name ? `by ${l.no_stock_by_name}` : ''}>⚠ No stock{l.no_stock_qty ? ` · short ${fmtQty(l.no_stock_qty)}` : ''}</span>
                          {canEdit && Number(l.no_stock_qty) > 0 && <button onClick={() => reopenLine(l)} disabled={busy === l.id}
                            title="Stock has arrived — re-open the outstanding quantity so you can pick it."
                            className="text-xs border border-emerald-500 text-emerald-700 rounded px-2 py-1 hover:bg-emerald-50 disabled:opacity-50 whitespace-nowrap">🔄 Stock arrived — pick outstanding</button>}
                        </>
                      : done && <span className="text-emerald-700 text-sm font-medium">✓ Picked</span>}
                    {canEdit && Number(l.qty_picked) > 0 && ['Picking', 'Picked', 'Reserved'].includes(order.status) && (
                      <button onClick={() => undoPick(l)} disabled={busy === l.id}
                        className="text-xs border border-gray-300 text-gray-600 rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap" title="Put picked stock back to its bin (wrong bag / batch / over-picked)">↩ Undo pick</button>
                    )}
                    {canEdit && !done && (
                      <div className="flex items-center gap-2">
                        {!l.no_stock && !manualPending.has(l.id) && (
                          <button onClick={() => confirmNoStock(l)} disabled={busy === l.id}
                            title="Declare there is no stock for this item (even if the system shows some) — records it short so the order can move on."
                            className="text-xs border border-amber-400 text-amber-700 rounded px-2 py-1 hover:bg-amber-50 disabled:opacity-50 whitespace-nowrap">⚠ No stock</button>
                        )}
                        <button onClick={() => openIssue(l)} disabled={busy === l.id}
                          title="Info wrong (qty / batch) or stock damaged? Raise an issue to Head Office."
                          className="text-xs border border-red-300 text-red-600 rounded px-2 py-1 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap">⚠ Issue</button>
                      </div>
                    )}
                  </div>
                </div>

                {!done && canEdit && (
                  <div className="mt-3 border-t pt-3">
                    {avail.length === 0
                      ? <div className="flex flex-wrap items-center gap-3">
                          <span className="text-xs text-red-600">No stock in the warehouse for this item.</span>
                          {manualPending.has(l.id)
                            ? <span className="text-xs text-sky-600 font-medium">⏳ Manual fill pending Head Office approval</span>
                            : <>
                                <button onClick={() => confirmNoStock(l)} disabled={busy === l.id}
                                  className="text-xs border border-amber-500 text-amber-700 rounded px-3 py-1.5 hover:bg-amber-50 font-medium disabled:opacity-50">{busy === l.id ? '…' : 'Confirm no stock'}</button>
                                <button onClick={() => openManual(l)} disabled={busy === l.id}
                                  title="You physically have the stock but it isn't in the system — enter the quantity; Head Office approves before it's booked."
                                  className="text-xs border border-sky-500 text-sky-700 rounded px-3 py-1.5 hover:bg-sky-50 font-medium disabled:opacity-50">🖐 Manual fill (needs HOD approval)</button>
                              </>}
                        </div>
                      : (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex-1 min-w-[240px]">
                            <label className="block text-xs text-gray-500 mb-1">Pick from bin / batch <span className="text-gray-400">(earliest expiry first)</span></label>
                            <select value={chosenId} onChange={e => { setChosen(c => ({ ...c, [l.id]: e.target.value })); setQtyInput(q => { const nq = { ...q }; delete nq[l.id]; return nq }) }}
                              className="w-full border rounded-lg px-3 py-2 text-sm">
                              {avail.map((a, i) => (
                                <option key={a.id} value={a.id}>
                                  {a.location_code}{a.batch_no ? ` · b:${a.batch_no}` : ' · no batch'}{a.exp_date ? ` · exp ${fmtDate(a.exp_date)}` : ''} — {fmtQty(availQty(a))} available{i === 0 ? '  (suggested)' : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Qty</label>
                            <input value={input} onChange={e => setQtyInput(q => ({ ...q, [l.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                              className="w-24 border rounded-lg px-3 py-2 text-sm text-right tabular-nums" inputMode="decimal" />
                          </div>
                          <button onClick={() => chosenStock && (pickMode === 'manual' ? pickFromBin(l, chosenStock, Number(input)) : startPick(l, chosenStock, Number(input)))}
                            disabled={busy === l.id || !chosenStock || !(Number(input) > 0)}
                            className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium whitespace-nowrap">
                            {busy === l.id ? 'Picking…' : pickMode === 'manual' ? 'Pick' : '📷 Scan & pick'}
                          </button>
                        </div>
                      )}
                    {avail.length > 0 && totalAvail < rem && (
                      <div className="text-xs text-amber-600 mt-1.5 flex flex-wrap items-center gap-2">
                        <span>⚠ Only {fmtQty(totalAvail)} in the warehouse across all bins — short by {fmtQty(rem - totalAvail)}.</span>
                        {manualPending.has(l.id)
                          ? <span className="text-sky-600 font-medium">⏳ Manual fill pending Head Office approval</span>
                          : <>
                              <button onClick={() => confirmNoStock(l)} disabled={busy === l.id} className="underline text-amber-700 hover:text-amber-800">Confirm short (no more stock)</button>
                              <button onClick={() => openManual(l)} disabled={busy === l.id}
                                title="You physically have the stock but it isn't in the system — enter the quantity; Head Office approves before it's booked."
                                className="underline text-sky-700 hover:text-sky-800">🖐 Manual fill (needs HOD approval)</button>
                            </>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {lines.length === 0 && <div className="bg-white rounded-xl border p-8 text-center text-gray-400 text-sm">This order has no lines.</div>}
        </div>

        {noStockOnly && (
          <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
            ⚠ No stock could be picked for this order — it stays <b>Pending — No stock</b>. There is nothing to check or dispatch until stock arrives.
          </div>
        )}
        {/* Checker sign-off — appears once everything is picked (not for a no-stock-only order). */}
        {lines.length > 0 && totals.remaining <= 0 && anyPicked && (
          <div className="mt-6 bg-white rounded-xl border shadow-sm p-4">
            {order.status === 'Checked' || order.pick_checked_at ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-teal-700 font-semibold text-sm">✓ Checked</span>
                <span className="text-sm text-gray-500">by {order.pick_checked_by_name || 'staff'}{order.pick_checked_at ? ` · ${new Date(order.pick_checked_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                {order.pick_check_note && <span className="text-xs text-gray-400">· “{order.pick_check_note}”</span>}
                <Link href={`/wms/dispatch/${order.id}`} className="ml-auto text-emerald-700 font-medium text-sm hover:underline">Dispatch →</Link>
              </div>
            ) : order.status === 'Picked' && pendingCorr ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-amber-600 font-semibold">⏳ Quantity change awaiting Head Office approval</span>
                <span className="text-gray-500">— dispatch stays locked until it&apos;s approved.</span>
              </div>
            ) : order.status === 'Picked' ? (
              <div>
                <h2 className="font-semibold text-sm mb-1">Check &amp; approve this pick</h2>
                <p className="text-xs text-gray-500 mb-3">Confirm the picked quantities. Only change a number if it&apos;s wrong — a change is <b>sent to Head Office to approve</b>{isHO || isAdmin ? ' (applied straight away for you)' : ''}. The person who picked can&apos;t check their own order.</p>
                {/* Desktop: table */}
                <div className="hidden sm:block overflow-x-auto border rounded-lg mb-3">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b text-xs text-gray-500"><tr>
                      <th className="text-left px-3 py-1.5 font-medium">Item</th>
                      <th className="text-right px-3 py-1.5 font-medium">Picked</th>
                      <th className="text-right px-3 py-1.5 font-medium">Checked qty</th>
                    </tr></thead>
                    <tbody>
                      {lines.map(l => {
                        const cq = checkedQty[l.id] ?? String(clean(l.qty_picked))
                        const diff = Number(cq) !== Number(l.qty_picked)
                        return (
                          <tr key={l.id} className="border-b last:border-0">
                            <td className="px-3 py-1.5"><span className="font-mono">{l.item_code}</span> <span className="text-gray-400 text-xs">{l.description}</span></td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmtQty(l.qty_picked)}{l.uom ? ' ' + l.uom : ''}</td>
                            <td className="px-3 py-1.5 text-right">
                              <input value={cq} onChange={e => setCheckedQty(q => ({ ...q, [l.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                                className={`w-24 border rounded px-2 py-1 text-sm text-right tabular-nums ${diff ? 'border-amber-400 bg-amber-50' : ''}`} inputMode="decimal" />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: one card per line */}
                <div className="sm:hidden space-y-2 mb-3">
                  {lines.map(l => {
                    const cq = checkedQty[l.id] ?? String(clean(l.qty_picked))
                    const diff = Number(cq) !== Number(l.qty_picked)
                    return (
                      <div key={l.id} className="bg-white rounded-xl border shadow-sm p-3">
                        <div className="font-mono font-semibold text-sm">{l.item_code}</div>
                        {l.description && <div className="text-xs text-gray-500 leading-snug">{l.description}</div>}
                        <div className="flex items-center justify-between gap-3 mt-2">
                          <span className="text-xs text-gray-500">Picked <span className="tabular-nums text-gray-600">{fmtQty(l.qty_picked)}{l.uom ? ' ' + l.uom : ''}</span></span>
                          <label className="flex items-center gap-2 text-xs text-gray-500">Checked qty
                            <input value={cq} onChange={e => setCheckedQty(q => ({ ...q, [l.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                              className={`w-24 border rounded px-2 py-1 text-sm text-right tabular-nums ${diff ? 'border-amber-400 bg-amber-50' : ''}`} inputMode="decimal" />
                          </label>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[220px]">
                    <label className="block text-xs text-gray-500 mb-1">Note <span className="text-gray-400">(optional)</span></label>
                    <input value={checkNote} onChange={e => setCheckNote(e.target.value)} placeholder="e.g. all counts verified" className="w-full border rounded-lg px-3 py-2 text-sm" />
                  </div>
                  {canEdit && <button onClick={confirmCheck} disabled={busy === 'check'} className="bg-teal-700 text-white px-5 py-2 rounded-lg hover:bg-teal-800 disabled:opacity-50 text-sm font-medium">{busy === 'check' ? 'Saving…' : 'Confirm check'}</button>}
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">This order is <b>{order.status}</b>.</p>
            )}
          </div>
        )}
      </div>

      {scanFor && (
        <ScanGate
          title={`Pick ${scanFor.line.item_code} from ${scanFor.stock.location_code}`}
          steps={[
            { label: 'bin', expectText: scanFor.stock.location_code, match: raw => matchBin(raw, scanFor.stock.location_code) },
            { label: 'item / batch', expectText: `${scanFor.line.item_code}${scanFor.stock.batch_no ? ' · ' + scanFor.stock.batch_no : ''}`, match: raw => matchItem(raw, scanFor.line.item_code, scanFor.stock.batch_no) },
          ]}
          onComplete={() => { const s = scanFor; setScanFor(null); if (s) pickFromBin(s.line, s.stock, s.qty) }}
          onCancel={() => setScanFor(null)}
        />
      )}

      {/* Manual fill — pick a bin + batch + qty; Head Office approves; books a real OUT of that bin. */}
      {manualFor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setManualFor(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-1">🖐 Manual fill</h2>
            <p className="text-gray-500 text-sm mb-4">
              <span className="font-mono">{manualFor.item_code}</span>{manualFor.description ? ` — ${manualFor.description}` : ''}
              <span className="block text-xs mt-0.5">The stock isn&apos;t in the system but you physically have it. Say which bin + batch and how much — Head Office approves, then it&apos;s booked as a pick OUT of that bin.</span>
            </p>
            <label className="block text-xs text-gray-500 mb-1">Bin you are filling from</label>
            <select value={mfLoc} onChange={e => setMfLoc(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mb-3">
              <option value="">Choose bin…</option>
              {allLocs.map(l => <option key={l.id} value={l.id}>{l.code}</option>)}
            </select>
            <div className="flex gap-2 mb-4">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">Batch <span className="text-gray-400">(optional)</span></label>
                <input value={mfBatch} onChange={e => setMfBatch(e.target.value)} placeholder="e.g. 240708" className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="w-28">
                <label className="block text-xs text-gray-500 mb-1">Qty{manualFor.uom ? ` (${manualFor.uom})` : ''}</label>
                <input value={mfQty} onChange={e => setMfQty(e.target.value.replace(/[^0-9.]/g, ''))} className="w-full border rounded-lg px-3 py-2 text-sm text-right tabular-nums" inputMode="decimal" />
              </div>
            </div>
            <p className="text-[11px] text-amber-600 mb-4">If this bin holds less than you fill, its stock will show negative by exactly the amount that wasn&apos;t in the system — for inventory to reconcile with a stock count.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setManualFor(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 font-medium text-sm">Cancel</button>
              <button onClick={submitManual} disabled={busy === manualFor.id || !mfLoc || !(Number(mfQty) > 0)}
                className="bg-sky-700 text-white px-5 py-2 rounded-lg hover:bg-sky-800 disabled:opacity-50 font-medium text-sm">Send to Head Office</button>
            </div>
          </div>
        </div>
      )}

      {/* Raise issue — qty / batch inaccurate, or stock damaged. Posts to the order's discussion. */}
      {issueFor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={() => setIssueFor(null)}>
          <div className="bg-white rounded-xl shadow-xl border w-full max-w-md my-8 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-1">⚠ Raise issue</h2>
            <p className="text-gray-500 text-sm mb-4">
              <span className="font-mono">{issueFor.item_code}</span>{issueFor.description ? ` — ${issueFor.description}` : ''}
              <span className="block text-xs mt-0.5">on {order.order_no} · ordered {fmtQty(issueFor.quantity)}{issueFor.uom ? ' ' + issueFor.uom : ''}</span>
            </p>
            <label className="block text-xs text-gray-500 mb-1.5">What&apos;s wrong? <span className="text-gray-400">(pick one or more)</span></label>
            <div className="flex flex-wrap gap-2 mb-4">
              {([['qty', 'Quantity inaccurate'], ['batch', 'Batch inaccurate'], ['damaged', 'Stock damaged (bag/gunny)'], ['other', 'Other']] as const).map(([k, lbl]) => (
                <button key={k} type="button" onClick={() => setIssueFlags(f => ({ ...f, [k]: !f[k] }))}
                  className={`px-3 py-1.5 rounded-lg border text-sm font-medium ${issueFlags[k] ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                  {issueFlags[k] ? '✓ ' : ''}{lbl}
                </button>
              ))}
            </div>
            <label className="block text-xs text-gray-500 mb-1">Details</label>
            <textarea value={issueNote} onChange={e => setIssueNote(e.target.value)} rows={3}
              placeholder="e.g. 3 bags torn, spilled · batch on bag is 260603 not 260708 · counted 8 not 10"
              className="w-full border rounded-lg px-3 py-2 text-sm mb-4" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setIssueFor(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 font-medium text-sm">Cancel</button>
              <button onClick={submitIssue} disabled={busy === issueFor.id || !(issueFlags.qty || issueFlags.batch || issueFlags.damaged || issueFlags.other)}
                className="bg-red-600 text-white px-5 py-2 rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium text-sm">Raise issue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
