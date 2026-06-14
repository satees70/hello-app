'use client'
import { useEffect, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface SalesImport {
  id: string
  file_name: string
  file_path: string
  status: string
  factory_code: string
  created_at: string
}

interface SalesLine {
  id: string
  customer_name: string
  so_number: string
  item_code: string
  description: string
  quantity: number
  outstanding_qty: number
  delivery_date: string
  location_code: string
  factory_code: string
}

interface ChangeRequest {
  id: string
  line_id: string
  field: string
  status: string
}

const STATUS_STYLES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Processing: 'bg-blue-100 text-blue-700',
  Review: 'bg-purple-100 text-purple-700',
  Processed: 'bg-green-100 text-green-700',
  Confirmed: 'bg-green-100 text-green-700',
  Error: 'bg-red-100 text-red-700',
}

const FIELDS: { value: keyof SalesLine; label: string }[] = [
  { value: 'customer_name', label: 'Customer' },
  { value: 'so_number', label: 'SO No' },
  { value: 'item_code', label: 'Item Code' },
  { value: 'description', label: 'Description' },
  { value: 'quantity', label: 'Qty' },
  { value: 'outstanding_qty', label: 'Outstanding' },
  { value: 'delivery_date', label: 'Delivery Date' },
  { value: 'location_code', label: 'Location' },
]

export default function SalesOrdersPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [imports, setImports] = useState<SalesImport[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Lines / review state
  const [lines, setLines] = useState<SalesLine[]>([])
  const [linesFor, setLinesFor] = useState<SalesImport | null>(null)
  const [linesLoading, setLinesLoading] = useState(false)
  const [changeReqs, setChangeReqs] = useState<ChangeRequest[]>([])
  const [confirming, setConfirming] = useState(false)
  const [dupKeys, setDupKeys] = useState<Set<string>>(new Set()) // "so_number||item_code" that appear >1 across all lines

  // Factory display + valid location codes (for the location dropdown)
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [locationCodes, setLocationCodes] = useState<string[]>([])

  // Change-request form
  const [reqLine, setReqLine] = useState<SalesLine | null>(null)
  const [reqField, setReqField] = useState<keyof SalesLine>('customer_name')
  const [reqValue, setReqValue] = useState('')
  const [reqReason, setReqReason] = useState('')
  const [reqMode, setReqMode] = useState<'edit' | 'delete'>('edit')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (profile) { loadImports(); loadRefs() }
  }, [profile])

  async function loadImports() {
    const { data } = await supabase
      .from('sales_imports')
      .select('*')
      .order('created_at', { ascending: false })
    setImports(data || [])
  }

  async function loadRefs() {
    const [{ data: f }, { data: lm }] = await Promise.all([
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('location_map').select('location_code').order('location_code'),
    ])
    setFactories(f || [])
    setLocationCodes((lm || []).map(r => r.location_code))
  }

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !profile) return
    if (file.type !== 'application/pdf') {
      setError('Please choose a PDF file.')
      return
    }
    setUploading(true); setError(''); setSuccess('')

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${profile.factory_code}/${Date.now()}-${safeName}`

    const { error: uploadError } = await supabase.storage.from('sales-orders').upload(path, file)
    if (uploadError) { setError(`Upload failed: ${uploadError.message}`); setUploading(false); return }

    const { data: inserted, error: insertError } = await supabase
      .from('sales_imports')
      .insert({
        file_name: file.name,
        file_path: path,
        status: 'Processing',
        factory_code: profile.factory_code,
        uploaded_by: profile.id,
      })
      .select()
      .single()
    if (insertError || !inserted) { setError(`Saving record failed: ${insertError?.message}`); setUploading(false); return }

    setSuccess(`Uploaded "${file.name}". Reading the document with Claude…`)
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setUploading(false)
    loadImports()

    try {
      const res = await fetch('/api/extract-sales-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importId: inserted.id, filePath: path }),
      })
      const result = await res.json()
      if (!res.ok) { setError(`Extraction failed: ${result.error || 'Unknown error'}`); setSuccess('') }
      else { setSuccess(`Extracted ${result.count} line(s) from "${inserted.file_name}".`); viewLines(inserted) }
    } catch {
      setError('Could not reach the extraction service.'); setSuccess('')
    }
    loadImports()
  }

  async function viewLines(doc: SalesImport) {
    setLinesFor(doc)
    setLinesLoading(true)
    setLines([])
    setReqLine(null)
    const [{ data: lineData }, { data: crData }, { data: allLines }] = await Promise.all([
      supabase.from('sales_order_lines').select('*').eq('import_id', doc.id).order('customer_name'),
      supabase.from('change_requests').select('id, line_id, field, status').eq('import_id', doc.id),
      supabase.from('sales_order_lines').select('so_number, item_code'),
    ])
    setLines(lineData || [])
    setChangeReqs(crData || [])
    // Flag SO number + item code combinations that appear on more than one line anywhere
    const counts: Record<string, number> = {}
    ;(allLines || []).forEach(r => {
      if (!r.so_number) return
      const k = `${r.so_number}||${r.item_code}`
      counts[k] = (counts[k] || 0) + 1
    })
    setDupKeys(new Set(Object.keys(counts).filter(k => counts[k] > 1)))
    setLinesLoading(false)
  }

  const isDuplicate = (l: SalesLine) => !!l.so_number && dupKeys.has(`${l.so_number}||${l.item_code}`)

  async function loadChangeReqs(importId: string) {
    const { data } = await supabase.from('change_requests').select('id, line_id, field, status').eq('import_id', importId)
    setChangeReqs(data || [])
  }

  const pendingForLine = (lineId: string) => changeReqs.filter(c => c.line_id === lineId && c.status === 'Pending').length
  const pendingForDoc = changeReqs.filter(c => c.status === 'Pending').length

  function openRequest(line: SalesLine) {
    setReqMode('edit')
    setReqLine(line)
    setReqField('customer_name')
    setReqValue(String(line.customer_name ?? ''))
    setReqReason('')
    setError('')
  }

  function openDelete(line: SalesLine) {
    setReqMode('delete')
    setReqLine(line)
    setReqReason('')
    setError('')
  }

  function onReqFieldChange(field: keyof SalesLine) {
    setReqField(field)
    if (!reqLine) return
    const current = String(reqLine[field] ?? '')
    // For location, only allow a valid mapped code — blank it if the current
    // value isn't in the list (e.g. a mistyped code) so the user must pick one.
    if (field === 'location_code') setReqValue(locationCodes.includes(current) ? current : '')
    else setReqValue(current)
  }

  async function submitRequest() {
    if (!reqLine || !profile || !linesFor) return
    if (!reqReason.trim()) { setError('Please give a reason.'); return }
    if (reqMode === 'edit' && !reqValue.trim()) { setError('Enter the proposed new value.'); return }
    setSubmitting(true); setError(''); setSuccess('')

    const payload = reqMode === 'delete'
      ? { request_type: 'delete', field: '__line__', old_value: `${reqLine.item_code} — ${reqLine.description}`, new_value: '(delete line)' }
      : { request_type: 'edit', field: reqField, old_value: String(reqLine[reqField] ?? ''), new_value: reqValue.trim() }

    const { error: insErr } = await supabase.from('change_requests').insert({
      line_id: reqLine.id,
      import_id: linesFor.id,
      reason: reqReason.trim(),
      status: 'Pending',
      requested_by: profile.id,
      requested_by_email: profile.email,
      requested_by_name: profile.full_name || profile.email,
      factory_code: reqLine.factory_code || profile.factory_code,
      ...payload,
    })
    if (insErr) { setError(`Could not submit request: ${insErr.message}`); setSubmitting(false); return }

    setSuccess(reqMode === 'delete' ? 'Delete request submitted for Head Office approval.' : 'Change request submitted for Head Office approval.')
    setSubmitting(false)
    setReqLine(null)
    loadChangeReqs(linesFor.id)
  }

  async function handleConfirm() {
    if (!linesFor) return
    setConfirming(true); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('confirm_document', { p_import_id: linesFor.id })
    if (rpcErr) { setError(rpcErr.message); setConfirming(false); return }
    setSuccess(`"${linesFor.file_name}" confirmed and pushed to production planning.`)
    setConfirming(false)
    loadImports()
  }

  async function handleDownload(path: string) {
    const { data, error: signError } = await supabase.storage.from('sales-orders').createSignedUrl(path, 60)
    if (signError || !data) { setError('Could not open file.'); return }
    window.open(data.signedUrl, '_blank')
  }

  async function handleDelete(doc: SalesImport) {
    if (!confirm(`Delete "${doc.file_name}"?\n\nThis removes the PDF, all extracted lines and their change requests. This cannot be undone.`)) return
    setError(''); setSuccess('')
    await supabase.storage.from('sales-orders').remove([doc.file_path])
    const { error: delError } = await supabase.from('sales_imports').delete().eq('id', doc.id)
    if (delError) { setError(`Delete failed: ${delError.message}`); return }
    if (linesFor?.id === doc.id) { setLinesFor(null); setLines([]) }
    setSuccess(`Deleted "${doc.file_name}".`)
    loadImports()
  }

  function formatDate(iso: string) { return new Date(iso).toLocaleString() }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const currentDoc = linesFor ? (imports.find(i => i.id === linesFor.id) || linesFor) : null
  const dupCount = lines.filter(isDuplicate).length
  const canConfirm = currentDoc && currentDoc.status !== 'Confirmed' && lines.length > 0 && pendingForDoc === 0 && dupCount === 0

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Sales Orders</h1>
        <p className="text-gray-500 text-sm mb-6">Upload a sales order PDF. It is read automatically. To correct a line, raise a change request for Head Office to approve.</p>

        <form onSubmit={handleUpload} className="bg-white rounded-xl shadow-sm border p-6 mb-8">
          <label className="block text-sm font-medium mb-2">Sales Order PDF</label>
          <input ref={fileInputRef} type="file" accept="application/pdf"
            onChange={e => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium hover:file:bg-blue-100 mb-4" />
          {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
          {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}
          <button type="submit" disabled={!file || uploading}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </form>

        <h2 className="font-semibold text-lg mb-3">Uploaded Documents</h2>
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden mb-8">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['File', 'Factory', 'Status', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>))}</tr>
            </thead>
            <tbody>
              {imports.length === 0 && (<tr><td colSpan={5} className="text-center py-8 text-gray-400">No documents uploaded yet</td></tr>)}
              {imports.map(doc => (
                <tr key={doc.id} className={`border-b last:border-0 hover:bg-gray-50 ${linesFor?.id === doc.id ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3 font-medium">{doc.file_name}</td>
                  <td className="px-4 py-3 text-gray-600">{doc.factory_code === 'HEAD_OFFICE' ? 'Head Office' : doc.factory_code}</td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>{doc.status}</span></td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(doc.created_at)}</td>
                  <td className="px-4 py-3 space-x-3 whitespace-nowrap">
                    <button onClick={() => viewLines(doc)} className="text-blue-600 hover:underline text-xs">View Lines</button>
                    <button onClick={() => handleDownload(doc.file_path)} className="text-blue-600 hover:underline text-xs">View PDF</button>
                    {isHO && <button onClick={() => handleDelete(doc)} className="text-red-600 hover:underline text-xs">Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {currentDoc && (
          <>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="font-semibold text-lg">Lines — <span className="text-gray-500 font-normal">{currentDoc.file_name}</span></h2>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[currentDoc.status] || 'bg-gray-100 text-gray-700'}`}>{currentDoc.status}</span>
              {pendingForDoc > 0 && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{pendingForDoc} pending change(s)</span>}
            </div>
            <p className="text-gray-500 text-sm mb-3">Lines are read-only. Use <strong>Request change</strong> to propose a correction — Head Office approves it. A document can&apos;t be confirmed while changes are pending.</p>

            {lines.filter(isDuplicate).length > 0 && (
              <p className="text-amber-700 text-sm bg-amber-50 border border-amber-200 p-2 rounded mb-3">
                ⚠ {lines.filter(isDuplicate).length} line(s) have an SO number + item that also appears on another line (possible duplicate order or re-upload). Please review before confirming.
              </p>
            )}

            {reqLine && (
              <div className="bg-white rounded-xl shadow-sm border p-5 mb-4">
                <h3 className="font-semibold mb-1">{reqMode === 'delete' ? 'Request to delete this line' : 'Request a change'}</h3>
                <p className="text-gray-500 text-xs mb-4">Line: <span className="font-mono">{reqLine.item_code}</span> — {reqLine.description}</p>
                {reqMode === 'delete' ? (
                  <p className="text-red-600 text-sm bg-red-50 p-2 rounded mb-4">This asks Head Office to remove this line from the document. Give a reason below.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className="block text-xs font-medium mb-1">Field to change</label>
                      <select value={reqField} onChange={e => onReqFieldChange(e.target.value as keyof SalesLine)}
                        className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                        {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Current value</label>
                      <input value={String(reqLine[reqField] ?? '')} disabled className="w-full border rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Proposed new value</label>
                      {reqField === 'location_code' ? (
                        <select value={reqValue} onChange={e => setReqValue(e.target.value)}
                          className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                          <option value="">Select location…</option>
                          {locationCodes.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <input value={reqValue} onChange={e => setReqValue(e.target.value)}
                          className="w-full border rounded-lg px-3 py-2 text-sm bg-white" />
                      )}
                    </div>
                  </div>
                )}
                <label className="block text-xs font-medium mb-1">Reason</label>
                <textarea value={reqReason} onChange={e => setReqReason(e.target.value)} rows={2}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-white mb-4" placeholder={reqMode === 'delete' ? 'Why should this line be deleted?' : 'Why does this need to change?'} />
                {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
                <div className="flex gap-3">
                  <button onClick={submitRequest} disabled={submitting}
                    className={`text-white px-5 py-2 rounded-lg disabled:opacity-50 text-sm font-medium ${reqMode === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                    {submitting ? 'Submitting…' : (reqMode === 'delete' ? 'Submit delete request' : 'Submit request')}
                  </button>
                  <button onClick={() => setReqLine(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>{['Customer', 'SO No', 'Item Code', 'Description', 'Qty', 'Outstanding', 'Delivery Date', 'Location', 'Factory', ''].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
                </thead>
                <tbody>
                  {linesLoading && (<tr><td colSpan={10} className="text-center py-8 text-gray-400">Loading…</td></tr>)}
                  {!linesLoading && lines.length === 0 && (<tr><td colSpan={10} className="text-center py-8 text-gray-400">No lines for this document.</td></tr>)}
                  {lines.map(line => {
                    const pend = pendingForLine(line.id)
                    return (
                      <tr key={line.id} className="border-b last:border-0 hover:bg-gray-50 align-top">
                        <td className="px-3 py-2 text-gray-700 min-w-[160px]">{line.customer_name}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {line.so_number}
                          {isDuplicate(line) && <span className="ml-1 text-amber-600" title="Same SO number + item appears on another line">⚠</span>}
                        </td>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{line.item_code}</td>
                        <td className="px-3 py-2 text-gray-600 min-w-[200px]">{line.description}</td>
                        <td className="px-3 py-2 text-right">{line.quantity}</td>
                        <td className="px-3 py-2 text-right">{line.outstanding_qty}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{line.delivery_date}</td>
                        <td className="px-3 py-2"><span className="font-mono">{line.location_code}</span></td>
                        <td className="px-3 py-2">
                          {line.factory_code
                            ? <span className="inline-block bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">{factoryName(line.factory_code)}</span>
                            : <span className="text-red-600">⚠ Unmapped</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {pend > 0 && <span className="mr-2 text-amber-600">⏳ {pend}</span>}
                          <button onClick={() => openRequest(line)} className="text-blue-600 hover:underline">Request change</button>
                          <button onClick={() => openDelete(line)} className="text-red-600 hover:underline ml-3">Request delete</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {lines.length > 0 && currentDoc.status !== 'Confirmed' && (
              <div className="flex items-center justify-between mt-4 mb-12">
                <div className="text-sm">
                  {pendingForDoc > 0
                    ? <span className="text-amber-600">⏳ {pendingForDoc} change request(s) pending — resolve them before confirming.</span>
                    : dupCount > 0
                      ? <span className="text-amber-600">⚠ {dupCount} duplicate SO+item line(s) — resolve them before confirming.</span>
                      : <span className="text-green-600">No pending changes. Ready to confirm.</span>}
                </div>
                <button onClick={handleConfirm} disabled={!canConfirm || confirming}
                  className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
                  {confirming ? 'Confirming…' : 'Confirm Document'}
                </button>
              </div>
            )}
            {currentDoc.status === 'Confirmed' && (
              <p className="mt-4 mb-12 text-green-700 text-sm font-medium">✓ This document is confirmed and in production planning.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
