'use client'
import { useCallback, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

// Warehouse receiving: production sends a delivery order (finished goods and/or
// raw-material returns); once its lorry is out, the warehouse confirms EACH item
// with a photo (like Goods Received), and records their own GRN number to
// cross-reference the DO. When every item is confirmed the DO is marked received.

interface Line { id: string; item_code: string; description: string | null; quantity: number; batch_no: string | null; received_at: string | null; received_by_name: string | null; photo_path: string | null }
interface Ret extends Line { reason: string | null }
interface DO {
  id: string; do_number: string | null; factory_code: string; created_at: string; departed_at: string | null
  vehicle: string | null; driver_name: string | null; warehouse_grn: string | null; received_at: string | null
  dispatch_order_lines: Line[]; material_returns: Ret[]
}
type Item = Line & { kind: 'fg' | 'return'; reason?: string | null }
const itemsOf = (o: DO): Item[] => [
  ...(o.dispatch_order_lines || []).map(l => ({ ...l, kind: 'fg' as const })),
  ...(o.material_returns || []).map(r => ({ ...r, kind: 'return' as const })),
]

function compressImage(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const max = 1280
      let { width, height } = img
      if (width > max || height > max) { const s = max / Math.max(width, height); width = Math.round(width * s); height = Math.round(height * s) }
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d'); if (!ctx) return reject(new Error('Canvas unavailable'))
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Compress failed')), 'image/jpeg', 0.6)
    }
    img.onerror = () => reject(new Error('Could not read image'))
    img.src = url
  })
}
const needsDbMsg = (m: string) => /confirm_do_line|confirm_do_return|set_do_grn|function|column|received_at|photo_path/i.test(m)
  ? 'This needs a database update — run db/2026-07-do-return-receipt.sql (and db/2026-07-do-line-receipt.sql) in the Supabase SQL editor.' : m

export default function WarehouseReceivingPage() {
  const { profile, loading: pLoading, error: pErr } = useProfile()
  const [orders, setOrders] = useState<DO[]>([])
  const [facs, setFacs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busyLine, setBusyLine] = useState('')
  const [grnEdits, setGrnEdits] = useState<Record<string, string>>({})
  const [showDone, setShowDone] = useState(false)
  const [q, setQ] = useState('')

  const canReceive = !!profile && (!!profile.warehouse_user || profile.factory_code === 'HEAD_OFFICE' || profile.role === 'admin')
  const facName = (c: string) => facs[c] || c
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const [{ data: f }, { data, error: e }] = await Promise.all([
      supabase.from('factories').select('code, name'),
      supabase.from('dispatch_orders')
        .select('id, do_number, factory_code, created_at, departed_at, vehicle, driver_name, warehouse_grn, received_at, dispatch_order_lines(id, item_code, description, quantity, batch_no, received_at, received_by_name, photo_path), material_returns(id, item_code, description, quantity, batch_no, reason, received_at, received_by_name, photo_path)')
        .not('departed_at', 'is', null).order('created_at', { ascending: false }).limit(150),
    ])
    setFacs(Object.fromEntries(((f as { code: string; name: string }[]) || []).map(x => [x.code, x.name])))
    if (e) setError(e.message)
    setOrders((data as unknown as DO[]) || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function takePhoto(item: Item, doId: string, file: File) {
    setBusyLine(item.id); setError(null); setSuccess(null)
    try {
      const blob = await compressImage(file)
      const path = `do-receipts/${doId}/${item.kind}-${item.id}.jpg`
      const { error: up } = await supabase.storage.from('delivery-orders').upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
      if (up) throw up
      const { error: e } = item.kind === 'return'
        ? await supabase.rpc('confirm_do_return', { p_return_id: item.id, p_photo_path: path })
        : await supabase.rpc('confirm_do_line', { p_line_id: item.id, p_photo_path: path })
      if (e) throw e
      await load()
    } catch (err) { setError(needsDbMsg(err instanceof Error ? err.message : String(err))) }
    setBusyLine('')
  }
  async function undoItem(item: Item) {
    setError(null); setSuccess(null)
    const { error: e } = item.kind === 'return'
      ? await supabase.rpc('unconfirm_do_return', { p_return_id: item.id })
      : await supabase.rpc('unconfirm_do_line', { p_line_id: item.id })
    if (e) { setError(needsDbMsg(e.message)); return }
    load()
  }
  async function viewPhoto(path: string) {
    const { data } = await supabase.storage.from('delivery-orders').createSignedUrl(path, 120)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  async function saveGrn(o: DO) {
    const grn = (grnEdits[o.id] ?? o.warehouse_grn ?? '').trim()
    setError(null); setSuccess(null)
    const { error: e } = await supabase.rpc('set_do_grn', { p_do_id: o.id, p_grn: grn || null })
    if (e) { setError(needsDbMsg(e.message)); return }
    setSuccess(`GRN saved for ${o.do_number}.`); load()
  }

  if (pLoading && !pErr) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (pErr) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{pErr}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const rq = q.trim().toLowerCase()
  const visible = orders
    .filter(o => showDone || !o.received_at)
    .filter(o => !rq || `${o.do_number || ''} ${facName(o.factory_code)} ${o.vehicle || ''} ${o.warehouse_grn || ''} ${itemsOf(o).map(l => `${l.item_code} ${l.description || ''}`).join(' ')}`.toLowerCase().includes(rq))

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Warehouse Receiving</h1>
        <p className="text-gray-500 text-sm mb-4">Delivery orders sent from production (finished goods and raw-material returns). Take a photo of <strong>each item</strong> to confirm it, and enter your GRN number to cross-reference the DO.</p>

        {!canReceive && <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">You have view-only access. Only warehouse staff or Head Office can confirm items — ask an admin to tick <strong>Warehouse user</strong> on your profile.</div>}
        {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2">{error}</div>}
        {success && <div className="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm px-3 py-2">{success}</div>}

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 DO no., item, GRN…" className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[12rem]" />
          <label className="flex items-center gap-1.5 text-sm text-gray-600"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> Show received</label>
        </div>

        {loading ? <div className="text-gray-400 py-16 text-center">Loading…</div>
          : visible.length === 0 ? <div className="text-gray-400 py-16 text-center bg-white border rounded-xl">{showDone ? 'No delivery orders.' : 'Nothing waiting to receive 🎉'}</div>
          : <div className="space-y-4">
              {visible.map(o => {
                const items = itemsOf(o)
                const done = items.filter(l => l.received_at).length
                const grnVal = grnEdits[o.id] ?? o.warehouse_grn ?? ''
                return (
                  <div key={o.id} className={`bg-white rounded-xl border shadow-sm ${o.received_at ? 'border-green-300' : ''}`}>
                    <div className="px-4 py-3 border-b flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-semibold">{o.do_number || '—'}</span>
                      <span className="text-gray-500 text-sm">· {facName(o.factory_code)}</span>
                      {o.vehicle && <span className="text-gray-500 text-sm">· 🚚 {o.vehicle}</span>}
                      <span className="text-gray-400 text-xs">· sent {fmt(o.departed_at)}</span>
                      <span className={`ml-auto text-xs font-medium ${o.received_at ? 'text-green-700' : 'text-amber-700'}`}>
                        {o.received_at ? `✅ Received ${fmt(o.received_at)}` : `${done}/${items.length} items confirmed`}
                      </span>
                    </div>

                    <div className="px-4 py-2 border-b flex flex-wrap items-center gap-2 text-sm bg-gray-50/60">
                      <label className="text-gray-600">Your GRN no.</label>
                      <input value={grnVal} disabled={!canReceive} onChange={e => setGrnEdits(m => ({ ...m, [o.id]: e.target.value }))}
                        placeholder="e.g. GRN-00123" className="border rounded-lg px-2 py-1 text-sm w-44 disabled:bg-gray-100" />
                      {canReceive && (grnEdits[o.id] ?? o.warehouse_grn ?? '') !== (o.warehouse_grn ?? '') &&
                        <button onClick={() => saveGrn(o)} className="bg-blue-600 text-white px-3 py-1 rounded-lg text-xs hover:bg-blue-700">Save GRN</button>}
                    </div>

                    <div className="divide-y">
                      {items.map(l => (
                        <div key={`${l.kind}-${l.id}`} className={`flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm ${l.received_at ? 'bg-green-50/50' : ''}`}>
                          <div className="min-w-0 flex-1">
                            <span title={l.kind === 'return' ? 'Raw-material return' : 'Finished goods'}>{l.kind === 'return' ? '↩ ' : '📦 '}</span>
                            <span className="font-mono font-medium">{l.item_code}</span>
                            {l.description && <span className="text-gray-500"> — {l.description}</span>}
                            <span className="block text-gray-400 text-xs ml-5">× {l.quantity}{l.batch_no ? ` · batch ${l.batch_no}` : ''}{l.reason ? ` · ${l.reason}` : ''}{l.received_at ? ` · ✓ ${l.received_by_name || ''} ${fmt(l.received_at)}` : ''}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {l.photo_path && <button onClick={() => viewPhoto(l.photo_path!)} className="text-blue-600 hover:underline text-xs">📷 photo</button>}
                            {canReceive && (l.received_at
                              ? <button onClick={() => undoItem(l)} className="text-gray-400 hover:underline text-xs">undo</button>
                              : <label className={`cursor-pointer text-xs px-3 py-1.5 rounded-lg font-medium ${busyLine === l.id ? 'bg-gray-200 text-gray-500' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                                  {busyLine === l.id ? 'Saving…' : '📷 Photo + confirm'}
                                  <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busyLine === l.id}
                                    onChange={e => { const f = e.target.files?.[0]; if (f) takePhoto(l, o.id, f); e.target.value = '' }} />
                                </label>)}
                          </div>
                        </div>
                      ))}
                      {items.length === 0 && <div className="px-4 py-3 text-gray-400 text-sm">No items on this delivery order.</div>}
                    </div>
                  </div>
                )
              })}
            </div>}
      </div>
    </div>
  )
}
