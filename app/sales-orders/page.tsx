'use client'
import { useEffect, useRef, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import MultiFilter from '@/components/MultiFilter'

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
  'Partially Confirmed': 'bg-teal-100 text-teal-700',
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
  useRequireView(profile, 'sales')
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
  const [confirmations, setConfirmations] = useState<{ factory_code: string; confirmed_by_name: string | null }[]>([])
  const [confirmingFactory, setConfirmingFactory] = useState('')
  const [dupKeys, setDupKeys] = useState<Set<string>>(new Set()) // "so_number||item_code" that appear >1 across all lines
  const [dupImports, setDupImports] = useState<Record<string, string[]>>({}) // key -> import ids that contain it
  const [docSummary, setDocSummary] = useState<Record<string, { pending: number; dup: number; locations: string[] }>>({})

  // Factory display + valid location codes (for the location dropdown)
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [locationCodes, setLocationCodes] = useState<string[]>([])
  const [locationMap, setLocationMap] = useState<Record<string, string>>({}) // location_code -> factory_code
  const [remapping, setRemapping] = useState(false)

  // Change-request form
  const [reqLine, setReqLine] = useState<SalesLine | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkField, setBulkField] = useState<keyof SalesLine>('location_code')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkReason, setBulkReason] = useState('')
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [colFilters, setColFilters] = useState<Record<string, Set<string>>>({})
  const [onlyUnmapped, setOnlyUnmapped] = useState(false)
  const [reqField, setReqField] = useState<keyof SalesLine>('customer_name')
  const [reqValue, setReqValue] = useState('')
  const [reqReason, setReqReason] = useState('')
  const [reqMode, setReqMode] = useState<'edit' | 'delete'>('edit')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (profile) { loadImports(); loadRefs(); loadSummary() }
  }, [profile])

  async function loadImports() {
    const { data } = await supabase
      .from('sales_imports')
      .select('*')
      .order('created_at', { ascending: false })
    setImports(data || [])
  }

  // Per-document overview: open change requests + duplicate SO+item lines
  async function loadSummary() {
    const [{ data: crs }, { data: allLines }] = await Promise.all([
      supabase.from('change_requests').select('import_id, status'),
      supabase.from('sales_order_lines').select('import_id, so_number, item_code, location_code'),
    ])
    const pending: Record<string, number> = {}
    ;(crs || []).forEach(c => { if (c.status === 'Pending') pending[c.import_id] = (pending[c.import_id] || 0) + 1 })
    const keyImports: Record<string, Set<string>> = {}
    ;(allLines || []).forEach(l => { if (l.so_number) { const k = `${l.so_number}||${l.item_code}`; if (!keyImports[k]) keyImports[k] = new Set(); keyImports[k].add(l.import_id) } })
    const dup: Record<string, number> = {}
    const locs: Record<string, Set<string>> = {}
    ;(allLines || []).forEach(l => {
      if (l.so_number && keyImports[`${l.so_number}||${l.item_code}`].size > 1) dup[l.import_id] = (dup[l.import_id] || 0) + 1
      if (l.location_code) { if (!locs[l.import_id]) locs[l.import_id] = new Set(); locs[l.import_id].add(l.location_code) }
    })
    const summary: Record<string, { pending: number; dup: number; locations: string[] }> = {}
    new Set([...Object.keys(pending), ...Object.keys(dup), ...Object.keys(locs)]).forEach(id => {
      summary[id] = { pending: pending[id] || 0, dup: dup[id] || 0, locations: locs[id] ? [...locs[id]].sort() : [] }
    })
    setDocSummary(summary)
  }

  async function loadRefs() {
    const [{ data: f }, { data: lm }] = await Promise.all([
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('location_map').select('location_code, factory_code').order('location_code'),
    ])
    setFactories(f || [])
    setLocationCodes((lm || []).map(r => r.location_code))
    const m: Record<string, string> = {}; (lm || []).forEach(r => { if (r.factory_code) m[r.location_code] = r.factory_code }); setLocationMap(m)
  }

  // Re-apply the current Location Map to lines still showing Unmapped (after a new
  // mapping is added in Setup → Location Map), without re-uploading the document.
  async function remapUnmapped() {
    if (!linesFor) return
    setRemapping(true); setError(''); setSuccess('')
    // Server-side re-map (case/space-insensitive, bypasses line RLS)
    const { data: count, error: e } = await supabase.rpc('remap_unmapped_lines', { p_import_id: linesFor.id })
    setRemapping(false)
    if (e) { setError(e.message); return }
    if (!count) {
      const missing = [...new Set(lines.filter(l => !l.factory_code).map(l => l.location_code || '(blank)'))]
      setError(`Still unmapped. These locations have no matching factory in the Location Map: ${missing.join(', ')}. Check the spelling matches exactly in Setup → Location Map.`)
      return
    }
    setSuccess(`Re-mapped ${count} line(s) to their factory.`)
    viewLines(linesFor)
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
    loadSummary()
  }

  async function viewLines(doc: SalesImport) {
    setLinesFor(doc)
    setLinesLoading(true)
    setLines([])
    setReqLine(null)
    const [{ data: lineData }, { data: crData }, { data: allLines }, { data: confData }] = await Promise.all([
      supabase.from('sales_order_lines').select('*').eq('import_id', doc.id).order('customer_name'),
      supabase.from('change_requests').select('id, line_id, field, status').eq('import_id', doc.id),
      supabase.from('sales_order_lines').select('so_number, item_code, import_id'),
      supabase.from('document_confirmations').select('factory_code, confirmed_by_name').eq('import_id', doc.id),
    ])
    setLines(lineData || [])
    setChangeReqs(crData || [])
    setConfirmations(confData || [])
    // Flag SO number + item that appears across MORE THAN ONE document (a re-upload).
    // Repeats within the same document are legitimate separate order lines.
    const byKey: Record<string, Set<string>> = {}
    ;(allLines || []).forEach(r => {
      if (!r.so_number) return
      const k = `${r.so_number}||${r.item_code}`
      if (!byKey[k]) byKey[k] = new Set()
      byKey[k].add(r.import_id)
    })
    setDupKeys(new Set(Object.keys(byKey).filter(k => byKey[k].size > 1)))
    const di: Record<string, string[]> = {}
    Object.keys(byKey).forEach(k => { di[k] = [...byKey[k]] })
    setDupImports(di)
    setLinesLoading(false)
  }

  const isDuplicate = (l: SalesLine) => !!l.so_number && dupKeys.has(`${l.so_number}||${l.item_code}`)

  // Where else this line's SO number + item appears (for the duplicate warning)
  function dupWhere(l: SalesLine): string {
    const ids = dupImports[`${l.so_number}||${l.item_code}`] || []
    const otherNames = [...new Set(ids.filter(id => id !== linesFor?.id)
      .map(id => imports.find(i => i.id === id)?.file_name).filter(Boolean))]
    return otherNames.length ? `also in ${otherNames.join(', ')}` : 'appears more than once in this document'
  }

  async function loadChangeReqs(importId: string) {
    const { data } = await supabase.from('change_requests').select('id, line_id, field, status').eq('import_id', importId)
    setChangeReqs(data || [])
  }

  const pendingForLine = (lineId: string) => changeReqs.filter(c => c.line_id === lineId && c.status === 'Pending').length
  const pendingForDoc = changeReqs.filter(c => c.status === 'Pending').length

  // Per-factory confirmation helpers
  const factoriesInDoc = [...new Set(lines.map(l => l.factory_code).filter(Boolean))].sort()
  const hasUnmapped = lines.some(l => !l.factory_code)
  // One filterable column per data field (drives the header labels + the filter row)
  const COLS: { key: string; label: string; get: (l: SalesLine) => string }[] = [
    { key: 'customer_name', label: 'Customer', get: l => l.customer_name || '' },
    { key: 'so_number', label: 'SO No', get: l => l.so_number || '' },
    { key: 'item_code', label: 'Item Code', get: l => l.item_code || '' },
    { key: 'description', label: 'Description', get: l => l.description || '' },
    { key: 'quantity', label: 'Qty', get: l => String(l.quantity ?? '') },
    { key: 'outstanding_qty', label: 'Outstanding', get: l => String(l.outstanding_qty ?? '') },
    { key: 'delivery_date', label: 'Delivery Date', get: l => l.delivery_date || '' },
    { key: 'location_code', label: 'Location', get: l => l.location_code || '' },
    { key: 'factory', label: 'Factory', get: l => `${l.factory_code || ''} ${factoryName(l.factory_code) || ''}` },
  ]
  const anyFilter = onlyUnmapped || COLS.some(c => (colFilters[c.key]?.size || 0) > 0)
  const colValues = (key: string) => { const g = COLS.find(c => c.key === key)!.get; return [...new Set(lines.map(g))].filter(Boolean).sort() }
  const visibleLines = lines.filter(l => {
    if (onlyUnmapped && l.factory_code) return false
    for (const c of COLS) { const sel = colFilters[c.key]; if (sel && sel.size > 0 && !sel.has(c.get(l))) return false }
    return true
  })
  const allSelected = visibleLines.length > 0 && visibleLines.every(l => selectedIds.has(l.id))
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(visibleLines.map(l => l.id)))
  const factoryOfLine = (lineId: string) => lines.find(l => l.id === lineId)?.factory_code
  const pendingForFactory = (f: string) => changeReqs.filter(c => c.status === 'Pending' && factoryOfLine(c.line_id) === f).length
  const dupForFactory = (f: string) => lines.filter(l => l.factory_code === f && isDuplicate(l)).length
  const isFactoryConfirmed = (f: string) => confirmations.some(c => c.factory_code === f)
  const confirmedByName = (f: string) => confirmations.find(c => c.factory_code === f)?.confirmed_by_name

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

  // ---- bulk select + bulk change request ----
  const toggleSel = (id: string) => setSelectedIds(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  function openBulk() { setBulkField('location_code'); setBulkValue(''); setBulkReason(''); setError(''); setBulkOpen(true) }
  async function submitBulk() {
    if (!profile || !linesFor) return
    if (selectedIds.size === 0) { setError('Select at least one line.'); return }
    if (!bulkReason.trim()) { setError('Please give a reason.'); return }
    if (!bulkValue.trim()) { setError('Enter the new value.'); return }
    setBulkSubmitting(true); setError(''); setSuccess('')
    const sel = lines.filter(l => selectedIds.has(l.id) && pendingForLine(l.id) === 0)
    const skipped = selectedIds.size - sel.length
    if (sel.length === 0) { setError('All selected lines already have a pending request — wait for those to be approved first.'); setBulkSubmitting(false); return }
    const rows = sel.map(l => ({
      line_id: l.id, import_id: linesFor.id, reason: bulkReason.trim(), status: 'Pending',
      requested_by: profile.id, requested_by_email: profile.email, requested_by_name: profile.full_name || profile.email,
      factory_code: l.factory_code || profile.factory_code,
      request_type: 'edit', field: bulkField, old_value: String(l[bulkField] ?? ''), new_value: bulkValue.trim(),
    }))
    const { error: insErr } = await supabase.from('change_requests').insert(rows)
    if (insErr) { setError(`Could not submit: ${insErr.message}`); setBulkSubmitting(false); return }
    setSuccess(`Bulk change submitted for ${rows.length} line(s)${skipped ? ` (${skipped} skipped — already pending)` : ''} — awaiting Head Office approval.`)
    setBulkSubmitting(false); setBulkOpen(false); setSelectedIds(new Set())
    loadChangeReqs(linesFor.id); loadSummary()
  }
  async function submitBulkDelete() {
    if (!profile || !linesFor || selectedIds.size === 0) return
    const reason = window.prompt(`Request to DELETE ${selectedIds.size} selected line(s).\nReason (sent to Head Office):`)
    if (reason === null) return
    if (!reason.trim()) { setError('Please give a reason.'); return }
    setBulkSubmitting(true); setError(''); setSuccess('')
    const sel = lines.filter(l => selectedIds.has(l.id) && pendingForLine(l.id) === 0)
    const skipped = selectedIds.size - sel.length
    if (sel.length === 0) { setError('All selected lines already have a pending request — wait for those first.'); setBulkSubmitting(false); return }
    const rows = sel.map(l => ({
      line_id: l.id, import_id: linesFor.id, reason: reason.trim(), status: 'Pending',
      requested_by: profile.id, requested_by_email: profile.email, requested_by_name: profile.full_name || profile.email,
      factory_code: l.factory_code || profile.factory_code,
      request_type: 'delete', field: '__line__', old_value: `${l.item_code} — ${l.description}`, new_value: '(delete line)',
    }))
    const { error: insErr } = await supabase.from('change_requests').insert(rows)
    if (insErr) { setError(`Could not submit: ${insErr.message}`); setBulkSubmitting(false); return }
    setSuccess(`Delete requested for ${rows.length} line(s)${skipped ? ` (${skipped} skipped — already pending)` : ''} — awaiting Head Office approval.`)
    setBulkSubmitting(false); setBulkOpen(false); setSelectedIds(new Set())
    loadChangeReqs(linesFor.id); loadSummary()
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
    loadSummary()
  }

  async function loadConfirmations(importId: string) {
    const { data } = await supabase.from('document_confirmations').select('factory_code, confirmed_by_name').eq('import_id', importId)
    setConfirmations(data || [])
  }

  async function confirmFactory(factory: string) {
    if (!linesFor) return
    setConfirmingFactory(factory); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('confirm_document_factory', { p_import_id: linesFor.id, p_factory: factory })
    if (rpcErr) { setError(rpcErr.message); setConfirmingFactory(''); return }
    setSuccess(`${factory} lines confirmed and pushed to production planning.`)
    setConfirmingFactory('')
    loadConfirmations(linesFor.id)
    loadImports()
    loadSummary()
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
    loadSummary()
  }

  function formatDate(iso: string) { return new Date(iso).toLocaleString() }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const currentDoc = linesFor ? (imports.find(i => i.id === linesFor.id) || linesFor) : null

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
              <tr>{['File', 'Locations', 'Status', 'Issues', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>))}</tr>
            </thead>
            <tbody>
              {imports.length === 0 && (<tr><td colSpan={6} className="text-center py-8 text-gray-400">No documents uploaded yet</td></tr>)}
              {imports.map(doc => (
                <tr key={doc.id} className={`border-b last:border-0 hover:bg-gray-50 ${linesFor?.id === doc.id ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3 font-medium">{doc.file_name}</td>
                  <td className="px-4 py-3 text-xs text-gray-600 max-w-[200px]">
                    {docSummary[doc.id]?.locations?.length
                      ? docSummary[doc.id].locations.join(', ')
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>{doc.status}</span></td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap space-x-2">
                    {docSummary[doc.id]?.dup ? <span className="text-amber-600" title="Duplicate SO+item lines">⚠ {docSummary[doc.id].dup} dup</span> : null}
                    {docSummary[doc.id]?.pending ? <span className="text-amber-600" title="Open change requests">⏳ {docSummary[doc.id].pending} pending</span> : null}
                    {!docSummary[doc.id]?.dup && !docSummary[doc.id]?.pending && <span className="text-gray-300">—</span>}
                  </td>
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
              <div className="text-amber-700 text-sm bg-amber-50 border border-amber-200 p-3 rounded mb-3">
                <p className="font-medium mb-1">⚠ Possible duplicate line(s) — same SO number + item appears elsewhere:</p>
                <ul className="list-disc ml-5 space-y-0.5">
                  {lines.filter(isDuplicate).map(l => (
                    <li key={l.id}><span className="font-mono">{l.item_code}</span> ({l.so_number}) — {dupWhere(l)}</li>
                  ))}
                </ul>
              </div>
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

            <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
              <span className="text-gray-500">Filter each column below.</span>
              {hasUnmapped && <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={onlyUnmapped} onChange={e => setOnlyUnmapped(e.target.checked)} className="h-4 w-4" /> ⚠ Unmapped only</label>}
              {hasUnmapped && <button onClick={remapUnmapped} disabled={remapping} className="bg-amber-500 text-white px-3 py-1 rounded-lg hover:bg-amber-600 disabled:opacity-50 text-xs font-medium">{remapping ? 'Re-mapping…' : '🔄 Re-map unmapped lines'}</button>}
              <span className="text-gray-400 text-xs">{visibleLines.length} of {lines.length} line(s)</span>
              {anyFilter && <button onClick={() => { setColFilters({}); setOnlyUnmapped(false) }} className="text-blue-600 hover:underline text-xs">Clear filters</button>}
            </div>

            {hasUnmapped && (
              <div className="mb-3 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-800">
                ⚠ <strong>{lines.filter(l => !l.factory_code).length} line(s) are unmapped</strong> — locations not linked to a factory: <strong>{[...new Set(lines.filter(l => !l.factory_code).map(l => l.location_code || '(blank)'))].join(', ')}</strong>. They won't be confirmed to production until mapped. Add the location in <strong>Setup → Location Map</strong>, then click <strong>🔄 Re-map unmapped lines</strong>.
              </div>
            )}

            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
                <span className="font-medium text-blue-800">{selectedIds.size} line(s) selected</span>
                <button onClick={openBulk} className="bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 text-sm font-medium">Request bulk change</button>
                <button onClick={submitBulkDelete} disabled={bulkSubmitting} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm font-medium">Request delete</button>
                <button onClick={() => setSelectedIds(new Set())} className="text-gray-500 hover:underline">Clear</button>
              </div>
            )}

            {bulkOpen && (
              <div className="bg-white rounded-xl shadow-sm border p-5 mb-4">
                <h3 className="font-semibold mb-1">Request a change for {selectedIds.size} line(s)</h3>
                <p className="text-gray-500 text-xs mb-4">The same change is proposed for every selected line; Head Office approves it.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Field to change</label>
                    <select value={bulkField} onChange={e => { setBulkField(e.target.value as keyof SalesLine); setBulkValue('') }} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                      {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">New value (applied to all selected)</label>
                    {bulkField === 'location_code' ? (
                      <select value={bulkValue} onChange={e => setBulkValue(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                        <option value="">Select location…</option>
                        {locationCodes.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <input value={bulkValue} onChange={e => setBulkValue(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm bg-white" />
                    )}
                  </div>
                </div>
                <label className="block text-xs font-medium mb-1">Reason</label>
                <textarea value={bulkReason} onChange={e => setBulkReason(e.target.value)} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm bg-white mb-4" placeholder="Why does this need to change?" />
                {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
                <div className="flex gap-3">
                  <button onClick={submitBulk} disabled={bulkSubmitting} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{bulkSubmitting ? 'Submitting…' : `Submit for ${selectedIds.size} line(s)`}</button>
                  <button onClick={() => setBulkOpen(false)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-3 py-2"><input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4" /></th>
                    {COLS.map(c => (<th key={c.key} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{c.label}</th>))}
                    <th className="px-3 py-2"></th>
                  </tr>
                  <tr className="border-b">
                    <th className="px-2 py-1"></th>
                    {COLS.map(c => (
                      <th key={c.key} className="px-2 py-1 min-w-[110px]">
                        <MultiFilter values={colValues(c.key)} selected={colFilters[c.key] || new Set()} onChange={s => setColFilters(p => ({ ...p, [c.key]: s }))} />
                      </th>
                    ))}
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {linesLoading && (<tr><td colSpan={11} className="text-center py-8 text-gray-400">Loading…</td></tr>)}
                  {!linesLoading && lines.length === 0 && (<tr><td colSpan={11} className="text-center py-8 text-gray-400">No lines for this document.</td></tr>)}
                  {!linesLoading && lines.length > 0 && visibleLines.length === 0 && (<tr><td colSpan={11} className="text-center py-8 text-gray-400">No lines match the filter.</td></tr>)}
                  {visibleLines.map(line => {
                    const pend = pendingForLine(line.id)
                    return (
                      <tr key={line.id} className={`border-b last:border-0 align-top ${selectedIds.has(line.id) ? 'bg-blue-50' : isDuplicate(line) ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                        <td className="px-3 py-2"><input type="checkbox" checked={selectedIds.has(line.id)} onChange={() => toggleSel(line.id)} className="h-4 w-4" /></td>
                        <td className="px-3 py-2 text-gray-700 min-w-[160px]">{line.customer_name}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {line.so_number}
                          {isDuplicate(line) && <span className="ml-1.5 inline-block align-middle bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded text-[11px] font-bold" title={dupWhere(line)}>⚠ DUP</span>}
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
                          {pend > 0
                            ? <span className="text-amber-600" title="Waiting for Head Office to approve/reject before another change can be raised">⏳ pending — wait for approval</span>
                            : <>
                                <button onClick={() => openRequest(line)} className="text-blue-600 hover:underline">Request change</button>
                                <button onClick={() => openDelete(line)} className="text-red-600 hover:underline ml-3">Request delete</button>
                              </>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {factoriesInDoc.length > 0 && (
              <div className="mt-5 mb-12">
                <h3 className="font-semibold mb-1">Confirm to production</h3>
                <p className="text-gray-500 text-sm mb-3">Each factory confirms its own lines. Confirmed lines are pushed to that factory&apos;s production planning.</p>
                <div className="space-y-2">
                  {factoriesInDoc.map(f => {
                    const pend = pendingForFactory(f)
                    const dup = dupForFactory(f)
                    const confirmed = isFactoryConfirmed(f)
                    const ready = !confirmed && pend === 0 && dup === 0
                    return (
                      <div key={f} className="flex items-center justify-between border rounded-lg bg-white px-4 py-3">
                        <div className="text-sm">
                          <span className="font-medium">{factoryName(f)}</span>
                          {confirmed
                            ? <span className="ml-2 text-green-600">✓ Confirmed{confirmedByName(f) ? ` by ${confirmedByName(f)}` : ''}</span>
                            : pend > 0
                              ? <span className="ml-2 text-amber-600">⏳ {pend} pending change(s) — resolve first</span>
                              : dup > 0
                                ? <span className="ml-2 text-amber-600">⚠ {dup} duplicate line(s) — resolve first</span>
                                : <span className="ml-2 text-green-600">Ready to confirm</span>}
                        </div>
                        {!confirmed && (
                          <button onClick={() => confirmFactory(f)} disabled={!ready || confirmingFactory === f}
                            className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium whitespace-nowrap">
                            {confirmingFactory === f ? 'Confirming…' : `Confirm ${f} lines`}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
