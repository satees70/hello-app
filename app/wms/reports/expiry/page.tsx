'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { downloadCsv } from '@/lib/csv'

interface Stock { item_code: string; description: string | null; location_code: string; batch_no: string; exp_date: string | null; quantity: number; uom: string | null }
interface Loc { code: string; aisle: string | null }

const clean = (n: number) => Number(n.toPrecision(12))
const fmtQty = (n: number) => clean(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
const fmtDate = (d: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB') : ''
const todayMid = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t }
const daysTo = (exp: string) => Math.round((new Date(exp + 'T00:00:00').getTime() - todayMid().getTime()) / 86400000)

export default function ExpiryReportPage() {
  const { profile, loading } = useProfile()
  const [rows, setRows] = useState<Stock[]>([])
  const [aisleByCode, setAisleByCode] = useState<Map<string, string>>(new Map())
  const [win, setWin] = useState<[number, number, number]>([30, 60, 90])
  const [q, setQ] = useState(''); const [zone, setZone] = useState(''); const [bucketF, setBucketF] = useState('')

  useEffect(() => {
    try { const s = localStorage.getItem('wmsExpiryWindows'); if (s) setWin(JSON.parse(s)) } catch { /* ignore */ }
  }, [])
  useEffect(() => { try { localStorage.setItem('wmsExpiryWindows', JSON.stringify(win)) } catch { /* ignore */ } }, [win])
  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [st, lo] = await Promise.all([
      fetchAll<Stock>('wms_stock', 'item_code, description, location_code, batch_no, exp_date, quantity, uom'),
      fetchAll<Loc>('wms_locations', 'code, aisle'),
    ])
    setRows(st.filter(s => s.exp_date && s.quantity > 0))
    setAisleByCode(new Map(lo.map(l => [l.code.toUpperCase(), l.aisle || ''])))
  }

  const [w1, w2, w3] = win
  const bucketOf = (d: number) => d < 0 ? 'Expired' : d <= w1 ? `≤${w1}d` : d <= w2 ? `≤${w2}d` : d <= w3 ? `≤${w3}d` : 'Later'
  const bucketChip = (b: string) => b === 'Expired' ? 'bg-red-100 text-red-700' : b === `≤${w1}d` ? 'bg-amber-100 text-amber-700' : b === `≤${w2}d` ? 'bg-yellow-100 text-yellow-700' : b === `≤${w3}d` ? 'bg-sky-100 text-sky-700' : 'bg-gray-100 text-gray-500'

  const zones = useMemo(() => Array.from(new Set([...aisleByCode.values()].filter(Boolean))).sort(), [aisleByCode])
  const enriched = useMemo(() => rows.map(r => {
    const d = daysTo(r.exp_date!); return { ...r, days: d, zone: aisleByCode.get(r.location_code.toUpperCase()) || '', bucket: bucketOf(d) }
  }).sort((a, b) => a.days - b.days), [rows, aisleByCode, w1, w2, w3])

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return enriched
      .filter(r => (zone ? r.zone === zone : true))
      .filter(r => (bucketF ? r.bucket === bucketF : true))
      .filter(r => !n || [r.item_code, r.description, r.location_code, r.batch_no].some(v => (v || '').toLowerCase().includes(n)))
  }, [enriched, q, zone, bucketF])

  const counts = useMemo(() => {
    const c = { Expired: 0, w1: 0, w2: 0, w3: 0 }
    for (const r of enriched) {
      if (r.days < 0) c.Expired++
      else if (r.days <= w1) c.w1++
      else if (r.days <= w2) c.w2++
      else if (r.days <= w3) c.w3++
    }
    return c
  }, [enriched, w1, w2, w3])

  function exportCsv() {
    downloadCsv('Expiry_alerts.csv', ['Item', 'Description', 'Bin', 'Zone', 'Batch', 'Expiry', 'Days', 'Qty', 'Status'],
      filtered.map(r => [r.item_code, r.description, r.location_code, r.zone, r.batch_no, fmtDate(r.exp_date), r.days, fmtQty(r.quantity), r.bucket]))
  }
  async function exportPdf() {
    const { default: jsPDF } = await import('jspdf'); const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape' })
    doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.text('SRRI EASWARI MILLS — Warehouse Expiry Alerts', 14, 14)
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.text(`Printed ${new Date().toLocaleString('en-GB')} · windows ${w1}/${w2}/${w3} days`, 14, 20)
    autoTable(doc, { startY: 24, head: [['Item', 'Description', 'Bin', 'Batch', 'Expiry', 'Days', 'Qty', 'Status']],
      body: filtered.map(r => [r.item_code, r.description || '', r.location_code, r.batch_no, fmtDate(r.exp_date), String(r.days), fmtQty(r.quantity), r.bucket]),
      styles: { fontSize: 8, cellPadding: 1.5 }, headStyles: { fillColor: [4, 120, 87] } })
    doc.save('Expiry_alerts.pdf')
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
          <div><h1 className="text-2xl font-bold">Expiry Alerts</h1><p className="text-gray-500 text-sm mt-1">Stock nearing or past expiry — soonest first.</p></div>
          <div className="flex gap-2"><button onClick={exportCsv} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ CSV</button><button onClick={exportPdf} className="border px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇ PDF</button></div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm mb-4 text-gray-600">Warning windows (days):
          {([0, 1, 2] as const).map(i => (
            <input key={i} value={win[i]} onChange={e => { const v = [...win] as [number, number, number]; v[i] = Number(e.target.value.replace(/[^0-9]/g, '')) || 0; setWin(v) }}
              className="w-16 border rounded-lg px-2 py-1 text-sm text-center" inputMode="numeric" />
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Tile n={counts.Expired} label="Expired" accent="text-red-600" onClick={() => setBucketF('Expired')} />
          <Tile n={counts.w1} label={`≤ ${w1} days`} accent="text-amber-600" onClick={() => setBucketF(`≤${w1}d`)} />
          <Tile n={counts.w2} label={`≤ ${w2} days`} accent="text-yellow-600" onClick={() => setBucketF(`≤${w2}d`)} />
          <Tile n={counts.w3} label={`≤ ${w3} days`} accent="text-sky-600" onClick={() => setBucketF(`≤${w3}d`)} />
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item / bin / batch…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          <select value={zone} onChange={e => setZone(e.target.value)} className="border rounded-lg px-3 py-2 text-sm"><option value="">All zones</option>{zones.map(z => <option key={z} value={z}>Zone {z}</option>)}</select>
          <select value={bucketF} onChange={e => setBucketF(e.target.value)} className="border rounded-lg px-3 py-2 text-sm"><option value="">All</option><option value="Expired">Expired</option><option value={`≤${w1}d`}>≤{w1}d</option><option value={`≤${w2}d`}>≤{w2}d</option><option value={`≤${w3}d`}>≤{w3}d</option><option value="Later">Later</option></select>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b"><tr>{['Item', 'Bin', 'Zone', 'Batch', 'Expiry', 'Days', 'Qty', 'Status'].map(h => <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-gray-400">No stock matches.</td></tr>}
              {filtered.map((r, i) => (
                <tr key={i} className={`border-b last:border-0 hover:bg-gray-50 ${r.days < 0 ? 'bg-red-50/40' : ''}`}>
                  <td className="px-3 py-2"><span className="font-mono font-medium">{r.item_code}</span> <span className="text-gray-400 text-xs">{r.description}</span></td>
                  <td className="px-3 py-2 font-mono text-xs">{r.location_code}</td>
                  <td className="px-3 py-2 text-xs">{r.zone}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.batch_no || '—'}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtDate(r.exp_date)}</td>
                  <td className={`px-3 py-2 tabular-nums font-medium ${r.days < 0 ? 'text-red-600' : r.days <= w1 ? 'text-amber-600' : 'text-gray-600'}`}>{r.days}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtQty(r.quantity)}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${bucketChip(r.bucket)}`}>{r.bucket}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">Showing {filtered.length} lots. <Link href="/wms/reports" className="text-emerald-700 underline">Other reports</Link></p>
      </div>
    </div>
  )
}

function Tile({ n, label, accent, onClick }: { n: number; label: string; accent: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="bg-white rounded-xl border shadow-sm px-4 py-3 text-left hover:border-emerald-300">
      <div className={`text-2xl font-bold tabular-nums ${accent}`}>{n}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </button>
  )
}
