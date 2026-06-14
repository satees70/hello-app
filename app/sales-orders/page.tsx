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
  item_code: string
  description: string
  quantity: number
  outstanding_qty: number
  delivery_date: string
  location_code: string
}

const STATUS_STYLES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Processing: 'bg-blue-100 text-blue-700',
  Review: 'bg-purple-100 text-purple-700',
  Processed: 'bg-green-100 text-green-700',
  Error: 'bg-red-100 text-red-700',
}

export default function SalesOrdersPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [imports, setImports] = useState<SalesImport[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Confirmation / editing state
  const [lines, setLines] = useState<SalesLine[]>([])
  const [linesFor, setLinesFor] = useState<SalesImport | null>(null)
  const [linesLoading, setLinesLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Reference data for the factory auto-fill
  const [locationMap, setLocationMap] = useState<Record<string, string>>({})
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [addSel, setAddSel] = useState<Record<string, string>>({}) // location_code -> chosen factory

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
    const [{ data: lm }, { data: f }] = await Promise.all([
      supabase.from('location_map').select('location_code, factory_code'),
      supabase.from('factories').select('code, name').order('code'),
    ])
    const map: Record<string, string> = {}
    ;(lm || []).forEach(r => { map[r.location_code] = r.factory_code })
    setLocationMap(map)
    setFactories(f || [])
  }

  // --- factory lookup helpers ---
  const factoryFor = (loc: string) => locationMap[loc] || ''
  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code
  const isUnmapped = (loc: string) => !locationMap[loc]
  const unmappedCodes = [...new Set(lines.filter(l => isUnmapped(l.location_code)).map(l => l.location_code))]

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

    const { error: uploadError } = await supabase.storage
      .from('sales-orders')
      .upload(path, file)
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

    // Kick off extraction on the server.
    try {
      const res = await fetch('/api/extract-sales-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ importId: inserted.id, filePath: path }),
      })
      const result = await res.json()
      if (!res.ok) {
        setError(`Extraction failed: ${result.error || 'Unknown error'}`)
        setSuccess('')
      } else {
        setSuccess(`Extracted ${result.count} line(s) from "${inserted.file_name}". Review and confirm them below.`)
        viewLines(inserted)
      }
    } catch {
      setError('Could not reach the extraction service.')
      setSuccess('')
    }
    loadImports()
  }

  async function viewLines(doc: SalesImport) {
    setLinesFor(doc)
    setLinesLoading(true)
    setLines([])
    setAddSel({})
    const { data } = await supabase
      .from('sales_order_lines')
      .select('*')
      .eq('import_id', doc.id)
      .order('customer_name', { ascending: true })
    setLines(data || [])
    setLinesLoading(false)
  }

  function updateLine(id: string, field: keyof SalesLine, value: string | number) {
    setLines(prev => prev.map(l => (l.id === id ? { ...l, [field]: value } : l)))
  }

  async function addMapping(locationCode: string) {
    const factoryCode = addSel[locationCode]
    if (!factoryCode) { setError(`Pick a factory for ${locationCode} first.`); return }
    setError('')
    const { error: addErr } = await supabase
      .from('location_map')
      .insert({ location_code: locationCode, factory_code: factoryCode })
    if (addErr) { setError(`Could not add ${locationCode} to the map: ${addErr.message}`); return }
    setLocationMap(prev => ({ ...prev, [locationCode]: factoryCode }))
    setAddSel(prev => { const n = { ...prev }; delete n[locationCode]; return n })
    setSuccess(`Added ${locationCode} → ${factoryName(factoryCode)} to the location map.`)
  }

  async function handleConfirm() {
    if (!linesFor || lines.length === 0) return
    if (unmappedCodes.length > 0) {
      setError(`Add these location codes to the map before confirming: ${unmappedCodes.join(', ')}`)
      return
    }
    setSaving(true); setError(''); setSuccess('')

    // Save every edited line with its auto-filled factory.
    const results = await Promise.all(lines.map(l =>
      supabase.from('sales_order_lines').update({
        customer_name: l.customer_name,
        item_code: l.item_code,
        description: l.description,
        quantity: Number(l.quantity) || 0,
        outstanding_qty: Number(l.outstanding_qty) || 0,
        delivery_date: l.delivery_date,
        location_code: l.location_code,
        factory_code: factoryFor(l.location_code),
      }).eq('id', l.id)
    ))
    const failed = results.find(r => r.error)
    if (failed?.error) { setError(`Save failed: ${failed.error.message}`); setSaving(false); return }

    // Only now does the document become Processed.
    const { error: stErr } = await supabase
      .from('sales_imports')
      .update({ status: 'Processed' })
      .eq('id', linesFor.id)
    if (stErr) { setError(`Save failed: ${stErr.message}`); setSaving(false); return }

    setSuccess(`Confirmed and saved ${lines.length} line(s) for "${linesFor.file_name}".`)
    setSaving(false)
    loadImports()
  }

  async function handleDownload(path: string) {
    const { data, error: signError } = await supabase.storage
      .from('sales-orders')
      .createSignedUrl(path, 60)
    if (signError || !data) { setError('Could not open file.'); return }
    window.open(data.signedUrl, '_blank')
  }

  async function handleDelete(doc: SalesImport) {
    if (!confirm(`Delete "${doc.file_name}"?\n\nThis removes the PDF and all extracted lines. This cannot be undone.`)) return
    setError(''); setSuccess('')
    await supabase.storage.from('sales-orders').remove([doc.file_path])
    const { error: delError } = await supabase.from('sales_imports').delete().eq('id', doc.id)
    if (delError) { setError(`Delete failed: ${delError.message}`); return }
    if (linesFor?.id === doc.id) { setLinesFor(null); setLines([]) }
    setSuccess(`Deleted "${doc.file_name}".`)
    loadImports()
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString()
  }

  const inputCls = 'w-full border rounded px-2 py-1 text-xs bg-white'

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  // Latest status for the doc being reviewed (kept fresh from the imports list).
  const currentDoc = linesFor ? (imports.find(i => i.id === linesFor.id) || linesFor) : null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Sales Orders</h1>
        <p className="text-gray-500 text-sm mb-6">Upload a sales order PDF. It is read automatically, then you review and confirm each line before it is saved.</p>

        <form onSubmit={handleUpload} className="bg-white rounded-xl shadow-sm border p-6 mb-8">
          <label className="block text-sm font-medium mb-2">Sales Order PDF</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={e => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-medium hover:file:bg-blue-100 mb-4"
          />
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
              <tr>
                {['File', 'Factory', 'Status', 'Uploaded', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {imports.length === 0 && (
                <tr><td colSpan={5} className="text-center py-8 text-gray-400">No documents uploaded yet</td></tr>
              )}
              {imports.map(doc => (
                <tr key={doc.id} className={`border-b last:border-0 hover:bg-gray-50 ${linesFor?.id === doc.id ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-3 font-medium">{doc.file_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {doc.factory_code === 'HEAD_OFFICE' ? 'Head Office' : doc.factory_code}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[doc.status] || 'bg-gray-100 text-gray-700'}`}>
                      {doc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{formatDate(doc.created_at)}</td>
                  <td className="px-4 py-3 space-x-3 whitespace-nowrap">
                    <button onClick={() => viewLines(doc)} className="text-blue-600 hover:underline text-xs">
                      {doc.status === 'Review' ? 'Review & Confirm' : 'View / Edit Lines'}
                    </button>
                    <button onClick={() => handleDownload(doc.file_path)} className="text-blue-600 hover:underline text-xs">
                      View PDF
                    </button>
                    <button onClick={() => handleDelete(doc)} className="text-red-600 hover:underline text-xs">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {currentDoc && (
          <>
            <div className="flex items-center gap-3 mb-2">
              <h2 className="font-semibold text-lg">
                {currentDoc.status === 'Processed' ? 'Edit Lines' : 'Confirm Lines'} —{' '}
                <span className="text-gray-500 font-normal">{currentDoc.file_name}</span>
              </h2>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[currentDoc.status] || 'bg-gray-100 text-gray-700'}`}>
                {currentDoc.status}
              </span>
            </div>
            <p className="text-gray-500 text-sm mb-3">
              Every field is editable. The factory fills in automatically from each line&apos;s location code.
              Nothing is saved as <strong>Processed</strong> until you click <strong>Confirm &amp; Save</strong>.
            </p>

            <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    {['Customer', 'Item Code', 'Description', 'Qty', 'Outstanding', 'Delivery Date', 'Location', 'Factory'].map(h => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {linesLoading && (
                    <tr><td colSpan={8} className="text-center py-8 text-gray-400">Loading…</td></tr>
                  )}
                  {!linesLoading && lines.length === 0 && (
                    <tr><td colSpan={8} className="text-center py-8 text-gray-400">No lines for this document.</td></tr>
                  )}
                  {lines.map(line => {
                    const unmapped = isUnmapped(line.location_code)
                    return (
                      <tr key={line.id} className={`border-b last:border-0 align-top ${unmapped ? 'bg-red-50' : ''}`}>
                        <td className="px-3 py-2 min-w-[180px]">
                          <input className={inputCls} value={line.customer_name}
                            onChange={e => updateLine(line.id, 'customer_name', e.target.value)} />
                        </td>
                        <td className="px-3 py-2 min-w-[130px]">
                          <input className={inputCls} value={line.item_code}
                            onChange={e => updateLine(line.id, 'item_code', e.target.value)} />
                        </td>
                        <td className="px-3 py-2 min-w-[220px]">
                          <input className={inputCls} value={line.description}
                            onChange={e => updateLine(line.id, 'description', e.target.value)} />
                        </td>
                        <td className="px-3 py-2 w-20">
                          <input type="number" className={`${inputCls} text-right`} value={line.quantity}
                            onChange={e => updateLine(line.id, 'quantity', Number(e.target.value))} />
                        </td>
                        <td className="px-3 py-2 w-20">
                          <input type="number" className={`${inputCls} text-right`} value={line.outstanding_qty}
                            onChange={e => updateLine(line.id, 'outstanding_qty', Number(e.target.value))} />
                        </td>
                        <td className="px-3 py-2 w-28">
                          <input className={inputCls} value={line.delivery_date}
                            onChange={e => updateLine(line.id, 'delivery_date', e.target.value)} />
                        </td>
                        <td className="px-3 py-2 w-28">
                          <input className={`${inputCls} font-mono uppercase`} value={line.location_code}
                            onChange={e => updateLine(line.id, 'location_code', e.target.value.toUpperCase())} />
                        </td>
                        <td className="px-3 py-2 min-w-[170px]">
                          {!unmapped ? (
                            <span className="inline-block bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                              {factoryName(factoryFor(line.location_code))}
                            </span>
                          ) : (
                            <div className="space-y-1">
                              <span className="block text-red-600 font-medium">⚠ Not in map</span>
                              <div className="flex gap-1">
                                <select
                                  className="border rounded px-1 py-1 text-xs bg-white"
                                  value={addSel[line.location_code] || ''}
                                  onChange={e => setAddSel(prev => ({ ...prev, [line.location_code]: e.target.value }))}
                                >
                                  <option value="">Factory…</option>
                                  {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                                </select>
                                <button type="button" onClick={() => addMapping(line.location_code)}
                                  className="bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 text-xs">
                                  Add
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {lines.length > 0 && (
              <div className="flex items-center justify-between mt-4 mb-12">
                <div className="text-sm">
                  {unmappedCodes.length > 0 ? (
                    <span className="text-red-600">
                      ⚠ {unmappedCodes.length} location code(s) not in the map: {unmappedCodes.join(', ')} — add them before confirming.
                    </span>
                  ) : (
                    <span className="text-green-600">All locations mapped to a factory. Ready to confirm.</span>
                  )}
                </div>
                <button onClick={handleConfirm} disabled={saving || unmappedCodes.length > 0}
                  className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium">
                  {saving ? 'Saving…' : 'Confirm & Save'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
