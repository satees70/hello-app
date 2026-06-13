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

const STATUS_STYLES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
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

  useEffect(() => { if (profile) loadImports() }, [profile])

  async function loadImports() {
    const { data } = await supabase
      .from('sales_imports')
      .select('*')
      .order('created_at', { ascending: false })
    setImports(data || [])
  }

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

    const { error: insertError } = await supabase.from('sales_imports').insert({
      file_name: file.name,
      file_path: path,
      status: 'Pending',
      factory_code: profile.factory_code,
      uploaded_by: profile.id,
    })
    if (insertError) { setError(`Saving record failed: ${insertError.message}`); setUploading(false); return }

    setSuccess(`Uploaded "${file.name}" successfully.`)
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setUploading(false)
    loadImports()
  }

  async function handleDownload(path: string) {
    const { data, error: signError } = await supabase.storage
      .from('sales-orders')
      .createSignedUrl(path, 60)
    if (signError || !data) { setError('Could not open file.'); return }
    window.open(data.signedUrl, '_blank')
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Sales Orders</h1>
        <p className="text-gray-500 text-sm mb-6">Upload a sales order PDF. It is stored securely and tracked below.</p>

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
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
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
                <tr key={doc.id} className="border-b last:border-0 hover:bg-gray-50">
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
                  <td className="px-4 py-3">
                    <button onClick={() => handleDownload(doc.file_path)} className="text-blue-600 hover:underline text-xs">
                      View PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
