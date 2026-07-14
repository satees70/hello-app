'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase, fetchAll } from '@/lib/supabase'
import { apiFetch } from '@/lib/api'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import {
  IMPORT_STATUSES, STATUS_STYLE, fmtDate,
  type ImportShipment, type ImportSupplier, type ContainerCharge,
} from '@/lib/import'

export default function ImportShipmentsPage() {
  const { profile, loading, error: profileError } = useProfile()
  const router = useRouter()
  const canEdit = can(profile, 'import', 'edit')

  const [shipments, setShipments] = useState<ImportShipment[]>([])
  const [suppliers, setSuppliers] = useState<ImportSupplier[]>([])
  const [charges, setCharges] = useState<ContainerCharge[]>([])
  // filters
  const [q, setQ] = useState('')
  const [statusF, setStatusF] = useState('')
  const [supplierF, setSupplierF] = useState('')
  // new-shipment modal
  const [showNew, setShowNew] = useState(false)
  const [nRef, setNRef] = useState('')
  const [nSupplier, setNSupplier] = useState('')
  const [nOrderDate, setNOrderDate] = useState('')
  const [nNotes, setNNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Start-from-a-document upload
  const fileRef = useRef<HTMLInputElement>(null)
  const [docBusy, setDocBusy] = useState('')

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const [ship, sup, chg] = await Promise.all([
      fetchAll<ImportShipment>('import_shipments', '*', q => q.order('created_at', { ascending: false })),
      fetchAll<ImportSupplier>('import_suppliers', '*', 'name'),
      fetchAll<ContainerCharge>('import_container_charges', '*'),
    ])
    setShipments(ship); setSuppliers(sup); setCharges(chg)
  }

  const supplierName = useMemo(() => {
    const m: Record<string, string> = {}
    suppliers.forEach(s => { m[s.id] = s.name })
    return m
  }, [suppliers])

  // Per-shipment container count + whether any demurrage/detention is running.
  const byShipment = useMemo(() => {
    const m: Record<string, { containers: number; dem: number; det: number }> = {}
    charges.forEach(c => {
      const e = (m[c.shipment_id] = m[c.shipment_id] || { containers: 0, dem: 0, det: 0 })
      e.containers += 1; e.dem += c.demurrage_days; e.det += c.detention_days
    })
    return m
  }, [charges])

  async function createShipment(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return
    if (!nRef.trim()) { setError('Enter a reference.'); return }
    if (!nSupplier) { setError('Pick a supplier.'); return }
    setSaving(true); setError('')
    const { data, error: err } = await supabase.from('import_shipments').insert({
      reference: nRef.trim(), supplier_id: nSupplier,
      order_date: nOrderDate || null, notes: nNotes.trim() || null,
      created_by: profile.id, created_by_name: profile.full_name || null,
    }).select('id').single()
    setSaving(false)
    if (err || !data) { setError(err?.message || 'Could not create shipment.'); return }
    router.push(`/import/${data.id}`)
  }

  // Start a shipment straight from a PDF: create a blank draft, upload the file,
  // read it with Claude, then open the shipment with the review panel ready.
  // Unknown supplier is auto-created when you Apply the review.
  async function startFromDocument(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !profile) return
    if (file.type !== 'application/pdf') { setError('Please choose a PDF file.'); return }
    setError(''); setDocBusy('Creating shipment…')
    // 1) blank draft (reference filled in from the document on Apply)
    const { data: ship, error: e1 } = await supabase.from('import_shipments').insert({
      reference: '', status: 'Ordered', created_by: profile.id, created_by_name: profile.full_name || null,
    }).select('id').single()
    if (e1 || !ship) { setDocBusy(''); setError(e1?.message || 'Could not create shipment.'); return }
    // 2) upload the PDF
    setDocBusy('Uploading…')
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${ship.id}/${Date.now()}-${safe}`
    const { error: e2 } = await supabase.storage.from('import-docs').upload(path, file)
    if (e2) { setDocBusy(''); setError(`Upload failed: ${e2.message}`); return }
    // 3) record + read
    const { data: doc, error: e3 } = await supabase.from('import_documents').insert({
      shipment_id: ship.id, file_name: file.name, file_path: path, status: 'Processing',
      uploaded_by: profile.id, uploaded_by_name: profile.full_name || null,
    }).select('id').single()
    if (e3 || !doc) { setDocBusy(''); setError(`Saving failed: ${e3?.message}`); return }
    setDocBusy('Reading the document with Claude…')
    try {
      await apiFetch('/api/extract-import-document', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id, filePath: path }),
      })
    } catch { /* fall through — the detail page can re-read if needed */ }
    // 4) open the shipment with this document's review panel open
    router.push(`/import/${ship.id}?review=${doc.id}`)
  }

  if (loading && !profileError) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (profileError) return <div className="p-8 text-sm text-red-600">{profileError}</div>
  if (!profile) return null

  const term = q.trim().toLowerCase()
  const list = shipments.filter(s => {
    if (statusF && s.status !== statusF) return false
    if (supplierF && s.supplier_id !== supplierF) return false
    if (term) {
      const hay = `${s.reference} ${supplierName[s.supplier_id || ''] || ''} ${s.notes || ''}`.toLowerCase()
      if (!hay.includes(term)) return false
    }
    return true
  })

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h1 className="text-2xl font-bold">Import shipments</h1>
          {canEdit && (
            <div className="flex items-center gap-2">
              <label className={`text-sm font-medium px-4 py-2 rounded-lg border cursor-pointer ${docBusy ? 'bg-gray-100 text-gray-400 border-gray-200' : 'border-emerald-600 text-emerald-600 hover:bg-emerald-50'}`}>
                {docBusy || '⬆ Start from a document'}
                <input ref={fileRef} type="file" accept="application/pdf" onChange={startFromDocument} disabled={!!docBusy} className="hidden" />
              </label>
              <button onClick={() => { setShowNew(true); setError('') }} className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 text-sm font-medium">+ New shipment</button>
            </div>
          )}
        </div>
        <p className="text-gray-500 text-sm mb-5">Track goods coming in from overseas suppliers — from order through to received. No supplier yet? Upload a PDF and it will be created for you.</p>
        {error && !showNew && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search reference, supplier, notes…" className="w-full sm:w-72 border rounded-lg px-3 py-2 text-sm" />
          <select value={statusF} onChange={e => setStatusF(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">All statuses</option>
            {IMPORT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={supplierF} onChange={e => setSupplierF(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span className="text-gray-400 text-xs">{list.length} shipment(s)</span>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Reference', 'Supplier', 'Status', 'Order date', 'Containers', 'Charges running', 'Updated'].map(h => (
                <th key={h} className="text-left px-4 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-gray-400">No shipments{term || statusF || supplierF ? ' match the filters' : ' yet'}.</td></tr>}
              {list.map(s => {
                const agg = byShipment[s.id]
                const running = agg && (agg.dem > 0 || agg.det > 0)
                return (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-emerald-50/40 cursor-pointer" onClick={() => router.push(`/import/${s.id}`)}>
                    <td className="px-4 py-2 font-medium whitespace-nowrap">{s.reference || <span className="text-gray-400 italic">(from document…)</span>}</td>
                    <td className="px-4 py-2 text-gray-700">{supplierName[s.supplier_id || ''] || <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[s.status] || 'bg-gray-100 text-gray-700'}`}>{s.status}</span></td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDate(s.order_date)}</td>
                    <td className="px-4 py-2 text-right">{agg?.containers || 0}</td>
                    <td className="px-4 py-2">{running
                      ? <span className="text-xs font-semibold text-red-600">⚠ {agg.dem > 0 ? `${agg.dem}d demurrage` : ''}{agg.dem > 0 && agg.det > 0 ? ' · ' : ''}{agg.det > 0 ? `${agg.det}d detention` : ''}</span>
                      : <span className="text-gray-300 text-xs">—</span>}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs whitespace-nowrap">{new Date(s.updated_at).toLocaleDateString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* New shipment modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={() => setShowNew(false)}>
          <form onClick={e => e.stopPropagation()} onSubmit={createShipment} className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold mb-4">New shipment</h2>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
            <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Reference *</span>
              <input value={nRef} onChange={e => setNRef(e.target.value)} placeholder="e.g. PI-2026-014" className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" autoFocus /></label>
            <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Supplier *</span>
              <select value={nSupplier} onChange={e => setNSupplier(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm">
                <option value="">Choose a supplier…</option>
                {suppliers.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {suppliers.filter(s => s.active).length === 0 && <span className="text-xs text-amber-600">No suppliers yet — add one under Suppliers first.</span>}
            </label>
            <label className="block mb-3"><span className="text-xs font-medium text-gray-600">Order date</span>
              <input type="date" value={nOrderDate} onChange={e => setNOrderDate(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
            <label className="block mb-4"><span className="text-xs font-medium text-gray-600">Notes</span>
              <textarea value={nNotes} onChange={e => setNNotes(e.target.value)} rows={2} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" /></label>
            <div className="flex items-center justify-end gap-3">
              <button type="button" onClick={() => setShowNew(false)} className="text-gray-500 hover:underline text-sm">Cancel</button>
              <button type="submit" disabled={saving} className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Creating…' : 'Create'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
