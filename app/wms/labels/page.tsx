'use client'
import { useEffect, useMemo, useState } from 'react'
import { fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import ItemPicker from '@/components/ItemPicker'
import { encodeBin, encodeItem } from '@/lib/qr'
import { LABEL_SIZES, downloadLabels, type LabelItem } from '@/lib/wmsLabel'

interface Loc { id: string; code: string; location_type: string; aisle: string | null; active: boolean }
interface Item { code: string; description: string; unit: string }
const TYPE_LABEL: Record<string, string> = { SL: 'Pick', XS: 'Excess', STAGE: 'Staging' }

export default function WmsLabelsPage() {
  const { profile, loading } = useProfile()
  const [locs, setLocs] = useState<Loc[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false); const [prog, setProg] = useState('')

  const [aisle, setAisle] = useState(''); const [type, setType] = useState(''); const [size, setSize] = useState('55x35')
  const [bItem, setBItem] = useState(''); const [bDesc, setBDesc] = useState(''); const [bBatch, setBBatch] = useState(''); const [bExp, setBExp] = useState(''); const [bSize, setBSize] = useState('55x35'); const [bCopies, setBCopies] = useState('1')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [lo, it] = await Promise.all([
      fetchAll<Loc>('wms_locations', 'id, code, location_type, aisle, active', 'code'),
      fetchAll<Item>('items', 'code, description, unit', 'code'),
    ])
    setLocs(lo); setItems(it)
  }

  const aisles = useMemo(() => Array.from(new Set(locs.map(l => l.aisle || '').filter(Boolean))).sort(), [locs])
  const selected = useMemo(() => locs.filter(l => l.active && l.location_type !== 'STAGE')
    .filter(l => (aisle ? (l.aisle || '') === aisle : true))
    .filter(l => (type ? l.location_type === type : true)), [locs, aisle, type])

  async function printBins() {
    if (!selected.length) return
    setBusy(true); setProg('Preparing…')
    const items: LabelItem[] = selected.map(l => ({ qrText: encodeBin(l.code), title: l.code, subs: [`${TYPE_LABEL[l.location_type] || l.location_type}${l.aisle ? ' · aisle ' + l.aisle : ''}`] }))
    await downloadLabels(items, size, `BinLabels_${size}${aisle ? '_' + aisle : ''}${type ? '_' + type : ''}.pdf`, (i, n) => setProg(`Building label ${i + 1} of ${n}…`))
    setBusy(false); setProg('')
  }

  async function printBatch() {
    if (!bItem.trim()) return
    setBusy(true)
    const n = Math.max(1, Math.min(500, Math.round(Number(bCopies) || 1)))
    const name = bDesc ? (bDesc.length > 24 ? bDesc.slice(0, 23) + '…' : bDesc) : ''
    const expLine = bExp ? `Exp ${new Date(bExp + 'T00:00:00').toLocaleDateString('en-GB')}` : ''
    const width = String(n).length
    const items = Array.from({ length: n }, (_, i) => {
      const seq = String(i + 1).padStart(width, '0')
      const subs = [name, `Batch ${bBatch || '—'}  #${seq}`, expLine].filter(Boolean)
      return { qrText: encodeItem(bItem, bBatch, bExp, seq), title: bItem, subs }
    })
    await downloadLabels(items, bSize, `BatchLabels_${bItem.replace(/[^a-zA-Z0-9]/g, '-')}_x${n}.pdf`)
    setBusy(false)
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold">Print Labels</h1>
        <p className="text-gray-500 text-sm mt-1 mb-6">QR labels for bins and batches. Each label is one page sized for your thermal roll — print to your label printer.</p>

        <div className="bg-white rounded-xl shadow-sm border p-6 mb-6">
          <h2 className="font-semibold mb-1">Bin labels</h2>
          <p className="text-sm text-gray-500 mb-3">One QR label per bin (encodes the bin code). Filter to print a batch of shelves, or leave filters empty for all.</p>
          <div className="flex flex-wrap gap-2 mb-3">
            <select value={aisle} onChange={e => setAisle(e.target.value)} className="border rounded-lg px-3 py-2 text-sm"><option value="">All aisles</option>{aisles.map(a => <option key={a} value={a}>Aisle {a}</option>)}</select>
            <select value={type} onChange={e => setType(e.target.value)} className="border rounded-lg px-3 py-2 text-sm"><option value="">All types</option><option value="SL">Pick (SL)</option><option value="XS">Excess (XS)</option></select>
            <select value={size} onChange={e => setSize(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">{Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          </div>
          <button onClick={printBins} disabled={busy || !selected.length} className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">
            {busy ? (prog || 'Working…') : `Generate ${selected.length} bin label${selected.length === 1 ? '' : 's'} (PDF)`}
          </button>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h2 className="font-semibold mb-1">Batch label</h2>
          <p className="text-sm text-gray-500 mb-3">A QR label for received stock (item + batch + expiry) to stick on the goods. These also print from the <b>Receive</b> screen as goods arrive.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div><label className="block text-xs text-gray-500 mb-1">Item</label><ItemPicker items={items} value={bItem ? `${bItem} — ${bDesc}` : ''} onPick={it => { setBItem(it.code); setBDesc(it.description) }} /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Batch</label><input value={bBatch} onChange={e => setBBatch(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm font-mono" placeholder="260630" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Expiry</label><input type="date" value={bExp} onChange={e => setBExp(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm" /></div>
            <div><label className="block text-xs text-gray-500 mb-1">Size</label><select value={bSize} onChange={e => setBSize(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm">{Object.entries(LABEL_SIZES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
            <div><label className="block text-xs text-gray-500 mb-1">Copies <span className="text-gray-400">(one per package)</span></label><input value={bCopies} onChange={e => setBCopies(e.target.value.replace(/[^0-9]/g, ''))} className="w-full border rounded-lg px-3 py-2 text-sm text-right tabular-nums" inputMode="numeric" /></div>
          </div>
          <button onClick={printBatch} disabled={busy || !bItem.trim()} className="bg-emerald-700 text-white px-5 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 text-sm font-medium">Print {Math.max(1, Math.min(500, Math.round(Number(bCopies) || 1)))} label{Math.max(1, Math.round(Number(bCopies) || 1)) > 1 ? 's' : ''} (PDF)</button>
        </div>
      </div>
    </div>
  )
}
