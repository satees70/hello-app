'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can, hasCap } from '@/lib/permissions'
import MultiFilter from '@/components/MultiFilter'

interface SalesImport {
  id: string
  file_name: string
  file_path: string
  status: string
  factory_code: string
  created_at: string
  urgent?: boolean
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

// Where a line's production currently sits — shared by the per-line Status column
// and the per-location done/total counts on the document list.
type BatchLite = { item_code: string; factory_code: string; material_request_id: string | null; pack_date: string | null; produced_qty: number | null; total_quantity: number; dispatched_at: string | null }
function lineStatusOf(b: BatchLite, mrStatus: Record<string, string>): string {
  if (b.dispatched_at) return 'Delivered to warehouse'
  const prod = Number(b.produced_qty || 0), tot = Number(b.total_quantity || 0)
  if (prod > 0 && prod >= tot) return 'Production completed'
  if (prod > 0) return 'Production started'
  if (!b.material_request_id) return 'Pending Material Request'
  const ms = mrStatus[b.material_request_id]
  if (ms === 'Fulfilled') return b.pack_date ? 'Pending Schedule' : 'Material Received Fully'
  if (ms === 'Partially Received') return 'Material Received Partial'
  return 'Pending Material Request'
}
const LINE_DONE = 'Delivered to warehouse'   // a line counts as "completed" once delivered

// Map a line field to the matching edit_unconfirmed_sales_line() parameter
const FIELD_PARAM: Record<string, string> = {
  customer_name: 'p_customer', so_number: 'p_so_number', item_code: 'p_item_code', description: 'p_description',
  quantity: 'p_quantity', outstanding_qty: 'p_outstanding', delivery_date: 'p_delivery_date', location_code: 'p_location',
}
const emptyEditArgs = (id: string): Record<string, string | null> => ({
  p_line_id: id, p_customer: null, p_so_number: null, p_item_code: null, p_description: null,
  p_quantity: null, p_outstanding: null, p_delivery_date: null, p_location: null,
})

const FIELDS: { value: keyof SalesLine; label: string }[] = [
  { value: 'customer_name', label: 'Customer' },
  { value: 'so_number', label: 'SO No' },
  { value: 'item_code', label: 'Item Code (description follows)' },
  { value: 'quantity', label: 'Qty' },
  { value: 'outstanding_qty', label: 'Outstanding' },
  { value: 'delivery_date', label: 'Delivery Date' },
  { value: 'location_code', label: 'Location' },
]

export default function SalesOrdersPage() {
  const { profile, loading, error: profileError } = useProfile()
  const router = useRouter()
  useRequireView(profile, 'sales')
  const [imports, setImports] = useState<SalesImport[]>([])
  const [docFilters, setDocFilters] = useState<Record<string, Set<string>>>({})
  const [docSearch, setDocSearch] = useState('')
  const [docLineText, setDocLineText] = useState<Record<string, string>>({})   // import -> item codes + descriptions inside it
  const [importSos, setImportSos] = useState<Record<string, string[]>>({})   // import -> its SO numbers
  const [discSo, setDiscSo] = useState<Record<string, number>>({})   // SO number -> discussion message count
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
  const [docSummary, setDocSummary] = useState<Record<string, { pending: number; dup: number; locations: string[]; locFactory: Record<string, string>; confirmed: string[]; locStats: Record<string, { total: number; done: number }> }>>({})
  const [docDelPending, setDocDelPending] = useState<Set<string>>(new Set())
  const [lineStatuses, setLineStatuses] = useState<Record<string, string>>({}) // sales line id -> production lifecycle status

  // Trace each confirmed line to its production batch and report where it is.
  async function loadLineStatuses(ls: SalesLine[]) {
    const sos = [...new Set(ls.map(l => l.so_number).filter(Boolean))]
    if (sos.length === 0) { setLineStatuses({}); return }
    const { data: bi } = await supabase.from('production_batch_items')
      .select('so_number, production_batches!batch_id(item_code, factory_code, material_request_id, pack_date, produced_qty, total_quantity, dispatched_at)')
      .in('so_number', sos)
    const rows = (bi || []) as unknown as { so_number: string; production_batches: BatchLite | null }[]
    const mrIds = [...new Set(rows.map(r => r.production_batches?.material_request_id).filter(Boolean) as string[])]
    const mrStatus: Record<string, string> = {}
    if (mrIds.length) { const { data: mrs } = await supabase.from('material_requests').select('id, status').in('id', mrIds); (mrs || []).forEach(m => { mrStatus[m.id] = m.status }) }
    const map: Record<string, string> = {}
    rows.forEach(r => { const b = r.production_batches; if (b) map[`${b.factory_code}|${b.item_code}|${r.so_number}`] = lineStatusOf(b, mrStatus) })
    const out: Record<string, string> = {}
    ls.forEach(l => { out[l.id] = map[`${l.factory_code}|${l.item_code}|${l.so_number}`] || 'Pending Material Request' })
    setLineStatuses(out)
  }
  const LINE_STATUS_STYLE: Record<string, string> = {
    'Pending Material Request': 'bg-gray-100 text-gray-600', 'Material Received Partial': 'bg-amber-100 text-amber-700',
    'Material Received Fully': 'bg-lime-100 text-lime-700', 'Pending Schedule': 'bg-yellow-100 text-yellow-700',
    'Production started': 'bg-blue-100 text-blue-700', 'Production completed': 'bg-teal-100 text-teal-700',
    'Delivered to warehouse': 'bg-green-100 text-green-700',
  }

  // Factory display + valid location codes (for the location dropdown)
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [locationCodes, setLocationCodes] = useState<string[]>([])
  const [locationMap, setLocationMap] = useState<Record<string, string>>({}) // location_code -> factory_code
  const [items, setItems] = useState<{ code: string; description: string }[]>([]) // Items master for item-code lookups
  const itemByCode = (c: string) => items.find(i => i.code.toLowerCase() === c.trim().toLowerCase())
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
  const [lineSearch, setLineSearch] = useState('')   // quick item-code / description search
  const [onlyUnmapped, setOnlyUnmapped] = useState(false)
  const [reqField, setReqField] = useState<keyof SalesLine>('customer_name')
  const [reqValue, setReqValue] = useState('')
  const [reqReason, setReqReason] = useState('')
  const [reqMode, setReqMode] = useState<'edit' | 'delete'>('edit')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (profile) { loadImports(); loadRefs(); loadSummary(); loadDiscCounts() }
  }, [profile])

  async function loadImports() {
    const { data } = await supabase
      .from('sales_imports')
      .select('*')
      .order('created_at', { ascending: false })
    setImports(data || [])
  }

  // Per-document overview: open change requests + duplicate SO+item lines
  async function loadDiscCounts() {
    const { data } = await supabase.from('discussions').select('so_number').eq('channel', 'warehouse')
    const m: Record<string, number> = {}; (data || []).forEach(d => { if (d.so_number) m[d.so_number] = (m[d.so_number] || 0) + 1 })
    setDiscSo(m)
  }
  function openDisc(so: string) { router.push(`/discussion?so=${encodeURIComponent(so)}`) }

  async function loadSummary() {
    const [{ data: crs }, { data: confs }, allLines] = await Promise.all([
      supabase.from('change_requests').select('import_id, status'),
      supabase.from('document_confirmations').select('import_id, factory_code'),
      fetchAll<{ import_id: string; so_number: string | null; item_code: string | null; description: string | null; location_code: string | null; factory_code: string | null }>(
        'sales_order_lines', 'import_id, so_number, item_code, description, location_code, factory_code'),
    ])
    const pending: Record<string, number> = {}
    ;(crs || []).forEach(c => { if (c.status === 'Pending') pending[c.import_id] = (pending[c.import_id] || 0) + 1 })
    const keyImports: Record<string, Set<string>> = {}
    const txt: Record<string, string> = {}   // import -> its item codes + descriptions (for searching documents by content)
    allLines.forEach(l => {
      if (l.so_number) { const k = `${l.so_number}||${l.item_code}`; if (!keyImports[k]) keyImports[k] = new Set(); keyImports[k].add(l.import_id) }
      txt[l.import_id] = (txt[l.import_id] || '') + ' ' + `${l.item_code || ''} ${l.description || ''}`.toLowerCase()
    })
    setDocLineText(txt)
    const isos: Record<string, Set<string>> = {}
    allLines.forEach(l => { if (l.so_number) { (isos[l.import_id] = isos[l.import_id] || new Set()).add(l.so_number) } })
    setImportSos(Object.fromEntries(Object.entries(isos).map(([k, v]) => [k, [...v].sort()])))
    const dup: Record<string, number> = {}
    const locs: Record<string, Set<string>> = {}
    const locFac: Record<string, Record<string, string>> = {}   // import -> location_code -> factory_code
    allLines.forEach(l => {
      if (l.so_number && keyImports[`${l.so_number}||${l.item_code}`].size > 1) dup[l.import_id] = (dup[l.import_id] || 0) + 1
      if (l.location_code) {
        if (!locs[l.import_id]) locs[l.import_id] = new Set(); locs[l.import_id].add(l.location_code)
        if (l.factory_code) { if (!locFac[l.import_id]) locFac[l.import_id] = {}; locFac[l.import_id][l.location_code] = l.factory_code }
      }
    })
    const conf: Record<string, Set<string>> = {}   // import -> set of confirmed factory_codes
    ;(confs || []).forEach(c => { if (!conf[c.import_id]) conf[c.import_id] = new Set(); conf[c.import_id].add(c.factory_code) })
    // Per-location completion (delivered lines / total lines) — trace each line to its batch
    const sos = [...new Set(allLines.map(l => l.so_number).filter(Boolean))] as string[]
    const biRows: { so_number: string; production_batches: BatchLite | null }[] = []
    for (let i = 0; i < sos.length; i += 150) {
      const { data } = await supabase.from('production_batch_items')
        .select('so_number, production_batches!batch_id(item_code, factory_code, material_request_id, pack_date, produced_qty, total_quantity, dispatched_at)')
        .in('so_number', sos.slice(i, i + 150))
      biRows.push(...((data || []) as unknown as { so_number: string; production_batches: BatchLite | null }[]))
    }
    const mrIds2 = [...new Set(biRows.map(r => r.production_batches?.material_request_id).filter(Boolean) as string[])]
    const mrStatus2: Record<string, string> = {}
    for (let i = 0; i < mrIds2.length; i += 150) {
      const { data: mrs } = await supabase.from('material_requests').select('id, status').in('id', mrIds2.slice(i, i + 150))
      ;(mrs || []).forEach(m => { mrStatus2[m.id] = m.status })
    }
    const statusMap: Record<string, string> = {}
    biRows.forEach(r => { const b = r.production_batches; if (b) statusMap[`${b.factory_code}|${b.item_code}|${r.so_number}`] = lineStatusOf(b, mrStatus2) })
    const locStats: Record<string, Record<string, { total: number; done: number }>> = {}
    allLines.forEach(l => {
      if (!l.location_code) return
      const m = (locStats[l.import_id] = locStats[l.import_id] || {})
      const g = (m[l.location_code] = m[l.location_code] || { total: 0, done: 0 })
      g.total++
      if (statusMap[`${l.factory_code}|${l.item_code}|${l.so_number}`] === LINE_DONE) g.done++
    })
    const summary: Record<string, { pending: number; dup: number; locations: string[]; locFactory: Record<string, string>; confirmed: string[]; locStats: Record<string, { total: number; done: number }> }> = {}
    new Set([...Object.keys(pending), ...Object.keys(dup), ...Object.keys(locs), ...Object.keys(conf)]).forEach(id => {
      summary[id] = { pending: pending[id] || 0, dup: dup[id] || 0, locations: locs[id] ? [...locs[id]].sort() : [], locFactory: locFac[id] || {}, confirmed: conf[id] ? [...conf[id]] : [], locStats: locStats[id] || {} }
    })
    setDocSummary(summary)
    const { data: dels } = await supabase.from('doc_delete_requests').select('import_id').eq('status', 'Pending')
    setDocDelPending(new Set((dels || []).map(d => d.import_id).filter(Boolean)))
  }

  async function loadRefs() {
    const [{ data: f }, { data: lm }, { data: it }] = await Promise.all([
      supabase.from('factories').select('code, name').order('code'),
      supabase.from('location_map').select('location_code, factory_code').order('location_code'),
      supabase.from('items').select('code, description').order('code'),
    ])
    setFactories(f || [])
    setLocationCodes((lm || []).map(r => r.location_code))
    const m: Record<string, string> = {}; (lm || []).forEach(r => { if (r.factory_code) m[r.location_code] = r.factory_code }); setLocationMap(m)
    setItems((it as { code: string; description: string }[]) || [])
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
  // Regular users may only change Location & Delivery Date; Head Office may change any field.
  const editableFields = isHO ? FIELDS : FIELDS.filter(f => f.value === 'location_code' || f.value === 'delivery_date')
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
    loadLineStatuses((lineData as SalesLine[]) || [])
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
  const lq = lineSearch.trim().toLowerCase()
  const visibleLines = lines.filter(l => {
    if (onlyUnmapped && l.factory_code) return false
    if (lq && !(l.item_code || '').toLowerCase().includes(lq) && !(l.description || '').toLowerCase().includes(lq)) return false
    for (const c of COLS) { const sel = colFilters[c.key]; if (sel && sel.size > 0 && !sel.has(c.get(l))) return false }
    const ss = colFilters.status; if (ss && ss.size > 0 && !ss.has(lineStatuses[l.id] || '')) return false
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
    const def = (isHO ? 'customer_name' : 'location_code') as keyof SalesLine
    setReqField(def)
    const cur = String(line[def] ?? '')
    setReqValue(def === 'location_code' ? (locationCodes.includes(cur) ? cur : '') : cur)
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
    if (!bulkValue.trim()) { setError('Enter the new value.'); return }
    const sel = lines.filter(l => selectedIds.has(l.id) && pendingForLine(l.id) === 0)
    const skipped = selectedIds.size - sel.length
    if (sel.length === 0) { setError('All selected lines already have a pending request — wait for those to be approved first.'); return }
    const direct = sel.filter(l => !isFactoryConfirmed(l.factory_code || ''))   // before confirm → apply now
    const needAppr = sel.filter(l => isFactoryConfirmed(l.factory_code || ''))   // after confirm → approval
    if (needAppr.length > 0 && !bulkReason.trim()) { setError('Some selected lines are already confirmed — please give a reason for those.'); return }
    setBulkSubmitting(true); setError(''); setSuccess('')
    const k = FIELD_PARAM[bulkField as string]
    for (const l of direct) {
      const args = emptyEditArgs(l.id); if (k) args[k] = bulkValue.trim()
      const { error: e } = await supabase.rpc('edit_unconfirmed_sales_line', args)
      if (e) { setError(`Could not update ${l.item_code}: ${e.message}`); setBulkSubmitting(false); return }
    }
    if (needAppr.length) {
      const rows = needAppr.map(l => ({
        line_id: l.id, import_id: linesFor.id, reason: bulkReason.trim(), status: 'Pending',
        requested_by: profile.id, requested_by_email: profile.email, requested_by_name: profile.full_name || profile.email,
        factory_code: l.factory_code || profile.factory_code,
        request_type: 'edit', field: bulkField, old_value: String(l[bulkField] ?? ''), new_value: bulkValue.trim(),
      }))
      const { error: insErr } = await supabase.from('change_requests').insert(rows)
      if (insErr) { setError(`Could not submit: ${insErr.message}`); setBulkSubmitting(false); return }
    }
    setSuccess(`${direct.length ? `${direct.length} line(s) updated` : ''}${direct.length && needAppr.length ? '; ' : ''}${needAppr.length ? `${needAppr.length} sent for Head Office approval` : ''}${skipped ? ` (${skipped} skipped — already pending)` : ''}.`)
    setBulkSubmitting(false); setBulkOpen(false); setSelectedIds(new Set())
    await viewLines(linesFor); loadSummary()
  }
  async function submitBulkDelete() {
    if (!profile || !linesFor || selectedIds.size === 0) return
    const sel = lines.filter(l => selectedIds.has(l.id) && pendingForLine(l.id) === 0)
    const skipped = selectedIds.size - sel.length
    if (sel.length === 0) { setError('All selected lines already have a pending request — wait for those first.'); return }
    const direct = sel.filter(l => !isFactoryConfirmed(l.factory_code || ''))
    const needAppr = sel.filter(l => isFactoryConfirmed(l.factory_code || ''))
    if (!confirm(`Delete ${direct.length} line(s) now${needAppr.length ? ` and request deletion of ${needAppr.length} confirmed line(s)` : ''}?`)) return
    let reason = ''
    if (needAppr.length) { const r = window.prompt(`${needAppr.length} selected line(s) are confirmed — deletion needs Head Office approval.\nReason:`); if (r === null) return; if (!r.trim()) { setError('Please give a reason.'); return } reason = r.trim() }
    setBulkSubmitting(true); setError(''); setSuccess('')
    for (const l of direct) {
      const { error: e } = await supabase.rpc('delete_unconfirmed_sales_line', { p_line_id: l.id })
      if (e) { setError(`Could not delete ${l.item_code}: ${e.message}`); setBulkSubmitting(false); return }
    }
    if (needAppr.length) {
      const rows = needAppr.map(l => ({
        line_id: l.id, import_id: linesFor.id, reason, status: 'Pending',
        requested_by: profile.id, requested_by_email: profile.email, requested_by_name: profile.full_name || profile.email,
        factory_code: l.factory_code || profile.factory_code,
        request_type: 'delete', field: '__line__', old_value: `${l.item_code} — ${l.description}`, new_value: '(delete line)',
      }))
      const { error: insErr } = await supabase.from('change_requests').insert(rows)
      if (insErr) { setError(`Could not submit: ${insErr.message}`); setBulkSubmitting(false); return }
    }
    setSuccess(`${direct.length ? `${direct.length} line(s) deleted` : ''}${direct.length && needAppr.length ? '; ' : ''}${needAppr.length ? `${needAppr.length} deletion(s) sent for approval` : ''}${skipped ? ` (${skipped} skipped — already pending)` : ''}.`)
    setBulkSubmitting(false); setBulkOpen(false); setSelectedIds(new Set())
    await viewLines(linesFor); loadSummary()
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
    if (reqMode === 'edit' && !reqValue.trim()) { setError('Enter the new value.'); return }
    // Item code must come from the Items master; its description follows automatically.
    const pickedItem = reqMode === 'edit' && reqField === 'item_code' ? itemByCode(reqValue) : null
    if (reqMode === 'edit' && reqField === 'item_code' && !pickedItem) { setError('Pick a valid item code from the Items master.'); return }

    // Before this line's factory confirms: apply the change directly, no approval.
    if (!isFactoryConfirmed(reqLine.factory_code || '')) {
      setSubmitting(true); setError(''); setSuccess('')
      if (reqMode === 'delete') {
        const { error: e } = await supabase.rpc('delete_unconfirmed_sales_line', { p_line_id: reqLine.id })
        if (e) { setError(e.message); setSubmitting(false); return }
      } else {
        const args = emptyEditArgs(reqLine.id)
        if (pickedItem) { args.p_item_code = pickedItem.code; args.p_description = pickedItem.description }
        else { const k = FIELD_PARAM[reqField as string]; if (k) args[k] = reqValue.trim() }
        const { error: e } = await supabase.rpc('edit_unconfirmed_sales_line', args)
        if (e) { setError(e.message); setSubmitting(false); return }
      }
      setSuccess(reqMode === 'delete' ? 'Line deleted.' : 'Line updated.')
      setSubmitting(false); setReqLine(null)
      await viewLines(linesFor); loadSummary()
      return
    }

    if (!reqReason.trim()) { setError('Please give a reason.'); return }
    setSubmitting(true); setError(''); setSuccess('')

    const base = {
      line_id: reqLine.id, import_id: linesFor.id, reason: reqReason.trim(), status: 'Pending',
      requested_by: profile.id, requested_by_email: profile.email,
      requested_by_name: profile.full_name || profile.email,
      factory_code: reqLine.factory_code || profile.factory_code,
    }
    const rows = reqMode === 'delete'
      ? [{ ...base, request_type: 'delete', field: '__line__', old_value: `${reqLine.item_code} — ${reqLine.description}`, new_value: '(delete line)' }]
      : pickedItem
        // Changing the item code also updates the description (kept in sync with the Items master)
        ? [
            { ...base, request_type: 'edit', field: 'item_code', old_value: String(reqLine.item_code ?? ''), new_value: pickedItem.code },
            { ...base, request_type: 'edit', field: 'description', old_value: String(reqLine.description ?? ''), new_value: pickedItem.description },
          ]
        : [{ ...base, request_type: 'edit', field: reqField, old_value: String(reqLine[reqField] ?? ''), new_value: reqValue.trim() }]

    const { error: insErr } = await supabase.from('change_requests').insert(rows)
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

  // Non-HO staff ask Head Office to delete a whole document (with a reason).
  async function requestDocDelete(doc: SalesImport) {
    if (!profile) return
    const reason = window.prompt(`Request to DELETE "${doc.file_name}".\nReason (sent to Head Office):`)
    if (reason === null) return
    if (!reason.trim()) { setError('Please give a reason for the delete request.'); return }
    setError(''); setSuccess('')
    const { error: insErr } = await supabase.from('doc_delete_requests').insert({
      import_id: doc.id, file_name: doc.file_name, file_path: doc.file_path, factory_code: doc.factory_code,
      reason: reason.trim(), requested_by: profile.id, requested_by_name: profile.full_name || null,
    })
    if (insErr) { setError(`Could not send request: ${insErr.message}`); return }
    setDocDelPending(p => new Set(p).add(doc.id))
    setSuccess(`Delete request for "${doc.file_name}" sent to Head Office.`)
  }

  async function toggleUrgent(doc: SalesImport) {
    const next = !doc.urgent
    setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('set_order_urgent', { p_import_id: doc.id, p_urgent: next })
    if (e) { setError(e.message); return }
    setImports(prev => prev.map(d => (d.id === doc.id ? { ...d, urgent: next } : d)))
    setSuccess(next ? `🔴 "${doc.file_name}" flagged URGENT — highlighted through the whole journey.` : `Urgent flag cleared for "${doc.file_name}".`)
  }

  function formatDate(iso: string) { return new Date(iso).toLocaleString() }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const currentDoc = linesFor ? (imports.find(i => i.id === linesFor.id) || linesFor) : null

  // Column filters for the Uploaded Documents list
  const docIssueTags = (d: SalesImport) => { const t: string[] = []; if (docSummary[d.id]?.dup) t.push('Duplicates'); if (docSummary[d.id]?.pending) t.push('Pending changes'); if (!t.length) t.push('None'); return t }
  const docDistinct = (key: string) => {
    if (key === 'file') return [...new Set(imports.map(d => d.file_name))].sort()
    if (key === 'status') return [...new Set(imports.map(d => d.status))].sort()
    if (key === 'locations') return [...new Set(imports.flatMap(d => docSummary[d.id]?.locations || []))].sort()
    if (key === 'issues') return [...new Set(imports.flatMap(docIssueTags))].sort()
    return []
  }
  const docPass = (sel: Set<string> | undefined, vals: string[]) => !sel || sel.size === 0 || vals.some(v => sel.has(v))
  const shownImports = imports.filter(d =>
    (!docSearch || d.file_name.toLowerCase().includes(docSearch.toLowerCase()) || (docLineText[d.id] || '').includes(docSearch.toLowerCase())) &&
    docPass(docFilters.status, [d.status]) &&
    docPass(docFilters.locations, docSummary[d.id]?.locations || []) &&
    docPass(docFilters.issues, docIssueTags(d)))
  const anyDocFilter = ['status', 'locations', 'issues'].some(k => docFilters[k]?.size)

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
        <div className="flex flex-wrap items-center gap-2 mb-2 text-sm relative z-20">
          <input value={docSearch} onChange={e => setDocSearch(e.target.value)} placeholder="🔍 Search file or item…" className="border rounded-lg px-3 py-1.5 text-sm w-52" />
          <div className="w-44"><span className="text-xs text-gray-500">Location</span><MultiFilter values={docDistinct('locations')} selected={docFilters.locations || new Set()} onChange={s => setDocFilters(p => ({ ...p, locations: s }))} /></div>
          <div className="w-40"><span className="text-xs text-gray-500">Status</span><MultiFilter values={docDistinct('status')} selected={docFilters.status || new Set()} onChange={s => setDocFilters(p => ({ ...p, status: s }))} /></div>
          <div className="w-44"><span className="text-xs text-gray-500">Issues</span><MultiFilter values={docDistinct('issues')} selected={docFilters.issues || new Set()} onChange={s => setDocFilters(p => ({ ...p, issues: s }))} /></div>
          <span className="text-gray-400 text-xs self-end">{shownImports.length} of {imports.length}</span>
          {(anyDocFilter || docSearch) && <button onClick={() => { setDocFilters({}); setDocSearch('') }} className="text-blue-600 hover:underline text-xs self-end">Clear</button>}
        </div>
        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[24rem] mb-8">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{['File', 'Locations', 'Status', 'Issues', 'Uploaded', 'Actions'].map(h => (
                <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 bg-gray-50">{h}</th>))}</tr>
            </thead>
            <tbody>
              {imports.length === 0 && (<tr><td colSpan={6} className="text-center py-8 text-gray-400">No documents uploaded yet</td></tr>)}
              {imports.length > 0 && shownImports.length === 0 && (<tr><td colSpan={6} className="text-center py-8 text-gray-400">No documents match the filter.</td></tr>)}
              {shownImports.map(doc => (
                <tr key={doc.id} className={`border-b last:border-0 hover:bg-gray-50 ${doc.urgent ? 'bg-red-50' : linesFor?.id === doc.id ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3 font-medium">
                    {doc.urgent && <span className="inline-block mr-2 px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-bold align-middle">🔴 URGENT</span>}{doc.file_name}
                    {importSos[doc.id]?.length ? <span className="flex flex-wrap gap-1 mt-1">{importSos[doc.id].map(so => {
                      const c = discSo[so] || 0
                      return <button key={so} onClick={() => openDisc(so)} title={c ? `${c} message(s) — open discussion` : 'Open discussion for this SO'}
                        className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${c ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>{c ? `💬 ${c} ` : '💬 '}{so}</button>
                    })}</span> : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 max-w-[220px]">
                    {docSummary[doc.id]?.locations?.length
                      ? <span className="flex flex-wrap gap-x-2 gap-y-1">{docSummary[doc.id].locations.map(loc => {
                          const fac = docSummary[doc.id].locFactory[loc]
                          const ok = fac && docSummary[doc.id].confirmed.includes(fac)
                          const st = docSummary[doc.id].locStats[loc]
                          return <span key={loc} className={`inline-flex items-center gap-0.5 ${ok ? 'text-green-700 font-medium' : ''}`} title={ok ? 'Approved by this location' : 'Not yet approved'}>{ok && <span>✓</span>}{loc}{st ? <span className="text-gray-400 font-normal"> ({st.done}/{st.total})</span> : null}</span>
                        })}</span>
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
                    <button onClick={() => toggleUrgent(doc)} className={`hover:underline text-xs ${doc.urgent ? 'text-gray-500' : 'text-red-600 font-medium'}`}>{doc.urgent ? 'Clear urgent' : '🔴 Mark urgent'}</button>
                    {isHO ? <button onClick={() => handleDelete(doc)} className="text-red-600 hover:underline text-xs">Delete</button>
                      : docDelPending.has(doc.id) ? <span className="text-amber-600 text-xs">⏳ Delete requested</span>
                        : hasCap(profile, 'request_doc_delete') ? <button onClick={() => requestDocDelete(doc)} className="text-red-600 hover:underline text-xs">Request delete</button> : null}
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
              {currentDoc.urgent && <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-600 text-white">🔴 URGENT</span>}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[currentDoc.status] || 'bg-gray-100 text-gray-700'}`}>{currentDoc.status}</span>
              {pendingForDoc > 0 && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{pendingForDoc} pending change(s)</span>}
            </div>
            <p className="text-gray-500 text-sm mb-3"><strong>Before a location confirms</strong>, its lines can be edited directly (no approval). <strong>After it confirms</strong>, changes go to Head Office as a request. A document can&apos;t be confirmed while changes are pending.</p>

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
                <h3 className="font-semibold mb-1">{isFactoryConfirmed(reqLine.factory_code || '') ? (reqMode === 'delete' ? 'Request to delete this line' : 'Request a change') : (reqMode === 'delete' ? 'Delete this line' : 'Edit this line')}</h3>
                <p className="text-gray-500 text-xs mb-4">Line: <span className="font-mono">{reqLine.item_code}</span> — {reqLine.description}{!isFactoryConfirmed(reqLine.factory_code || '') && <span className="text-green-600"> · not yet confirmed — applies immediately</span>}</p>
                {reqMode === 'delete' ? (
                  <p className="text-red-600 text-sm bg-red-50 p-2 rounded mb-4">{isFactoryConfirmed(reqLine.factory_code || '') ? 'This asks Head Office to remove this line from the document. Give a reason below.' : 'This removes the line from the document immediately.'}</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className="block text-xs font-medium mb-1">Field to change</label>
                      <select value={reqField} onChange={e => onReqFieldChange(e.target.value as keyof SalesLine)}
                        className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                        {editableFields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
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
                      ) : reqField === 'item_code' ? (
                        <>
                          <input list="so-items" value={reqValue} onChange={e => setReqValue(e.target.value)} placeholder="Pick an item code…"
                            className="w-full border rounded-lg px-3 py-2 text-sm bg-white" />
                          <datalist id="so-items">{items.map(i => <option key={i.code} value={i.code}>{i.description}</option>)}</datalist>
                          {reqValue ? (itemByCode(reqValue) ? <span className="text-xs text-gray-500">→ {itemByCode(reqValue)!.description}</span> : <span className="text-xs text-red-500">Not in Items master</span>) : null}
                        </>
                      ) : (
                        <input value={reqValue} onChange={e => setReqValue(e.target.value)}
                          className="w-full border rounded-lg px-3 py-2 text-sm bg-white" />
                      )}
                    </div>
                  </div>
                )}
                {isFactoryConfirmed(reqLine.factory_code || '') && <>
                  <label className="block text-xs font-medium mb-1">Reason</label>
                  <textarea value={reqReason} onChange={e => setReqReason(e.target.value)} rows={2}
                    className="w-full border rounded-lg px-3 py-2 text-sm bg-white mb-4" placeholder={reqMode === 'delete' ? 'Why should this line be deleted?' : 'Why does this need to change?'} />
                </>}
                {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
                <div className="flex gap-3">
                  <button onClick={submitRequest} disabled={submitting}
                    className={`text-white px-5 py-2 rounded-lg disabled:opacity-50 text-sm font-medium ${reqMode === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                    {submitting ? 'Saving…' : isFactoryConfirmed(reqLine.factory_code || '') ? (reqMode === 'delete' ? 'Submit delete request' : 'Submit request') : (reqMode === 'delete' ? 'Delete line' : 'Save change')}
                  </button>
                  <button onClick={() => setReqLine(null)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
              <input value={lineSearch} onChange={e => setLineSearch(e.target.value)} placeholder="Search item code or description…" className="w-full sm:w-72 border rounded-lg px-3 py-2 text-sm" />
              <span className="text-gray-500">or filter each column below.</span>
              {hasUnmapped && <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={onlyUnmapped} onChange={e => setOnlyUnmapped(e.target.checked)} className="h-4 w-4" /> ⚠ Unmapped only</label>}
              {hasUnmapped && <button onClick={remapUnmapped} disabled={remapping} className="bg-amber-500 text-white px-3 py-1 rounded-lg hover:bg-amber-600 disabled:opacity-50 text-xs font-medium">{remapping ? 'Re-mapping…' : '🔄 Re-map unmapped lines'}</button>}
              <span className="text-gray-400 text-xs">{visibleLines.length} of {lines.length} line(s)</span>
              {(anyFilter || lineSearch) && <button onClick={() => { setColFilters({}); setOnlyUnmapped(false); setLineSearch('') }} className="text-blue-600 hover:underline text-xs">Clear filters</button>}
            </div>

            {hasUnmapped && (
              <div className="mb-3 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-800">
                ⚠ <strong>{lines.filter(l => !l.factory_code).length} line(s) are unmapped</strong> — locations not linked to a factory: <strong>{[...new Set(lines.filter(l => !l.factory_code).map(l => l.location_code || '(blank)'))].join(', ')}</strong>. They won't be confirmed to production until mapped. Add the location in <strong>Setup → Location Map</strong>, then click <strong>🔄 Re-map unmapped lines</strong>.
              </div>
            )}

            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 mb-3 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm">
                <span className="font-medium text-blue-800">{selectedIds.size} line(s) selected</span>
                <button onClick={openBulk} className="bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 text-sm font-medium">Bulk edit</button>
                <button onClick={submitBulkDelete} disabled={bulkSubmitting} className="bg-red-600 text-white px-4 py-1.5 rounded-lg hover:bg-red-700 disabled:opacity-50 text-sm font-medium">Delete selected</button>
                <button onClick={() => setSelectedIds(new Set())} className="text-gray-500 hover:underline">Clear</button>
              </div>
            )}

            {bulkOpen && (
              <div className="bg-white rounded-xl shadow-sm border p-5 mb-4">
                <h3 className="font-semibold mb-1">Bulk edit {selectedIds.size} line(s)</h3>
                <p className="text-gray-500 text-xs mb-4">The same change is applied to every selected line. Unconfirmed lines change immediately; already-confirmed lines go to Head Office for approval (reason required for those).</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Field to change</label>
                    <select value={bulkField} onChange={e => { setBulkField(e.target.value as keyof SalesLine); setBulkValue('') }} className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
                      {editableFields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
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
                <label className="block text-xs font-medium mb-1">Reason <span className="text-gray-400 font-normal">(only needed for already-confirmed lines)</span></label>
                <textarea value={bulkReason} onChange={e => setBulkReason(e.target.value)} rows={2} className="w-full border rounded-lg px-3 py-2 text-sm bg-white mb-4" placeholder="Why does this need to change?" />
                {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
                <div className="flex gap-3">
                  <button onClick={submitBulk} disabled={bulkSubmitting} className="bg-blue-600 text-white px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium">{bulkSubmitting ? 'Saving…' : `Apply to ${selectedIds.size} line(s)`}</button>
                  <button onClick={() => setBulkOpen(false)} className="border px-5 py-2 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[32rem]">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-2 bg-gray-50"><input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-4 w-4" /></th>
                    {COLS.map(c => (<th key={c.key} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{c.label}</th>))}
                    <th className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">Status</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                  <tr className="border-b">
                    <th className="px-2 py-1"></th>
                    {COLS.map(c => (
                      <th key={c.key} className="px-2 py-1 min-w-[110px]">
                        <MultiFilter values={colValues(c.key)} selected={colFilters[c.key] || new Set()} onChange={s => setColFilters(p => ({ ...p, [c.key]: s }))} />
                      </th>
                    ))}
                    <th className="px-2 py-1 min-w-[110px]"><MultiFilter values={[...new Set(Object.values(lineStatuses))].sort()} selected={colFilters.status || new Set()} onChange={s => setColFilters(p => ({ ...p, status: s }))} /></th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {linesLoading && (<tr><td colSpan={12} className="text-center py-8 text-gray-400">Loading…</td></tr>)}
                  {!linesLoading && lines.length === 0 && (<tr><td colSpan={12} className="text-center py-8 text-gray-400">No lines for this document.</td></tr>)}
                  {!linesLoading && lines.length > 0 && visibleLines.length === 0 && (<tr><td colSpan={12} className="text-center py-8 text-gray-400">No lines match the filter.</td></tr>)}
                  {visibleLines.map(line => {
                    const pend = pendingForLine(line.id)
                    return (
                      <tr key={line.id} className={`border-b last:border-0 align-top ${selectedIds.has(line.id) ? 'bg-blue-50' : isDuplicate(line) ? 'bg-amber-50' : 'hover:bg-gray-50'}`}>
                        <td className="px-3 py-2"><input type="checkbox" checked={selectedIds.has(line.id)} onChange={() => toggleSel(line.id)} className="h-4 w-4" /></td>
                        <td className="px-3 py-2 text-gray-700 min-w-[160px]">{line.customer_name}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {line.so_number
                            ? <button onClick={() => openDisc(line.so_number)} title={discSo[line.so_number] ? `${discSo[line.so_number]} message(s) — open discussion` : 'Open discussion for this SO'} className="text-blue-600 hover:underline">{line.so_number}{discSo[line.so_number] ? <span className="ml-1 text-indigo-600">💬{discSo[line.so_number]}</span> : null}</button>
                            : line.so_number}
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
                          {lineStatuses[line.id] ? <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${LINE_STATUS_STYLE[lineStatuses[line.id]] || 'bg-gray-100 text-gray-600'}`}>{lineStatuses[line.id]}</span> : <span className="text-gray-300 text-xs">—</span>}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {pend > 0
                            ? <span className="text-amber-600" title="Waiting for Head Office to approve/reject before another change can be raised">⏳ pending — wait for approval</span>
                            : !can(profile, 'sales', 'edit', line.factory_code)
                              ? <span className="text-gray-400" title="You have view-only access for this factory">view only</span>
                              : <>
                                <button onClick={() => openRequest(line)} className="text-blue-600 hover:underline">{isFactoryConfirmed(line.factory_code || '') ? 'Request change' : 'Edit'}</button>
                                <button onClick={() => openDelete(line)} className="text-red-600 hover:underline ml-3">{isFactoryConfirmed(line.factory_code || '') ? 'Request delete' : 'Delete'}</button>
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
                        {!confirmed && (can(profile, 'sales', 'edit', f)
                          ? <button onClick={() => confirmFactory(f)} disabled={!ready || confirmingFactory === f}
                              className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium whitespace-nowrap">
                              {confirmingFactory === f ? 'Confirming…' : `Confirm ${f} lines`}
                            </button>
                          : <span className="text-gray-400 text-sm">view only</span>)}
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
