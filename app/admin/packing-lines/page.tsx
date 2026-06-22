'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface PackLine { id: string; factory_code: string; name: string; active: boolean; line_code: string | null; line_mode: string | null }

export default function PackingLinesPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'packing_lines')
  const [lines, setLines] = useState<PackLine[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [factory, setFactory] = useState('')
  const [name, setName] = useState('')
  const [lineCode, setLineCode] = useState('')
  const [lineMode, setLineMode] = useState('any')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'packing_lines', 'edit')
  const canDelete = can(profile, 'packing_lines', 'delete')

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    if (!isHO && profile) setFactory(profile.factory_code)
    else if (f && f.length && !factory) setFactory(f[0].code)
    const { data } = await supabase.from('packing_lines').select('*').order('factory_code').order('name')
    setLines((data as PackLine[]) || [])
  }

  async function addLine(e: React.FormEvent) {
    e.preventDefault()
    if (!factory || !name.trim()) return
    setSaving(true); setError(''); setSuccess('')
    const { error: e1 } = await supabase.from('packing_lines').insert({ factory_code: factory, name: name.trim(), line_code: lineCode.trim().toUpperCase() || null, line_mode: lineMode })
    setSaving(false)
    if (e1) { setError(e1.message.includes('duplicate') ? 'That line already exists for this factory.' : e1.message); return }
    setName(''); setLineCode(''); setLineMode('any'); setSuccess('Packing line added.'); load()
  }
  async function saveLetter(l: PackLine, val: string) {
    const code = val.trim().toUpperCase() || null
    await supabase.from('packing_lines').update({ line_code: code }).eq('id', l.id)
    setLines(prev => prev.map(x => (x.id === l.id ? { ...x, line_code: code } : x)))
  }
  async function saveMode(l: PackLine, mode: string) {
    await supabase.from('packing_lines').update({ line_mode: mode }).eq('id', l.id)
    setLines(prev => prev.map(x => (x.id === l.id ? { ...x, line_mode: mode } : x)))
  }

  async function toggleActive(l: PackLine) {
    const { error: e1 } = await supabase.from('packing_lines').update({ active: !l.active }).eq('id', l.id)
    if (e1) { setError(e1.message); return }
    setLines(prev => prev.map(x => (x.id === l.id ? { ...x, active: !x.active } : x)))
  }

  async function remove(l: PackLine) {
    if (!confirm(`Delete packing line "${l.name}"? Batches already saved with this line keep it.`)) return
    const { error: e1 } = await supabase.from('packing_lines').delete().eq('id', l.id)
    if (e1) { setError(e1.message); return }
    setLines(prev => prev.filter(x => x.id !== l.id))
    setSuccess('Packing line deleted.')
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const factoryName = (code: string) => factories.find(f => f.code === code)?.name || code
  const shown = isHO ? lines : lines.filter(l => l.factory_code === profile.factory_code)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Packing Lines</h1>
        <p className="text-gray-500 text-sm mb-5">The list of packing lines used in the Run mode / Pack line dropdown on the Order Board.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {canEdit && (
          <form onSubmit={addLine} className="flex flex-wrap items-end gap-3 mb-6 bg-white border rounded-xl p-4 shadow-sm">
            {isHO && (
              <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory</span>
                <select value={factory} onChange={e => setFactory(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-white">
                  {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                </select></div>
            )}
            <div className="flex flex-col gap-1 flex-1 min-w-[180px]"><span className="text-xs font-medium text-gray-600">Packing line name</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Line 1" className="border rounded px-2 py-1.5 text-sm" /></div>
            <div className="flex flex-col gap-1 w-24"><span className="text-xs font-medium text-gray-600">Letter</span>
              <input value={lineCode} onChange={e => setLineCode(e.target.value)} maxLength={3} placeholder="A" className="border rounded px-2 py-1.5 text-sm uppercase" /></div>
            <div className="flex flex-col gap-1 w-32"><span className="text-xs font-medium text-gray-600">Run mode</span>
              <select value={lineMode} onChange={e => setLineMode(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-white"><option value="any">Any</option><option value="auto">Auto only</option><option value="manual">Manual only</option></select></div>
            <button disabled={saving || !name.trim()} className="bg-teal-600 text-white px-4 py-1.5 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Adding…' : 'Add line'}</button>
          </form>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {isHO && <th className="text-left px-4 py-2 font-medium text-gray-600">Factory</th>}
                <th className="text-left px-4 py-2 font-medium text-gray-600">Packing line</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Letter</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Run mode</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Status</th>
                {(canEdit || canDelete) && <th className="text-left px-4 py-2 font-medium text-gray-600">Action</th>}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No packing lines yet.</td></tr>}
              {shown.map(l => (
                <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
                  {isHO && <td className="px-4 py-2 text-gray-600">{factoryName(l.factory_code)}</td>}
                  <td className="px-4 py-2 font-medium">{l.name}</td>
                  <td className="px-4 py-2">{canEdit ? <input defaultValue={l.line_code || ''} maxLength={3} onBlur={e => { if ((e.target.value.trim().toUpperCase() || null) !== (l.line_code || null)) saveLetter(l, e.target.value) }} placeholder="—" className="border rounded px-2 py-1 text-sm w-16 uppercase" /> : <span className="font-mono">{l.line_code || '—'}</span>}</td>
                  <td className="px-4 py-2">{canEdit ? <select value={l.line_mode || 'any'} onChange={e => saveMode(l, e.target.value)} className="border rounded px-2 py-1 text-sm bg-white"><option value="any">Any</option><option value="auto">Auto only</option><option value="manual">Manual only</option></select> : <span className="capitalize">{l.line_mode || 'any'}</span>}</td>
                  <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${l.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}`}>{l.active ? 'Active' : 'Hidden'}</span></td>
                  {(canEdit || canDelete) && (
                    <td className="px-4 py-2 whitespace-nowrap">
                      {canEdit && <button onClick={() => toggleActive(l)} className="text-blue-600 hover:underline text-xs mr-3">{l.active ? 'Hide' : 'Show'}</button>}
                      {canDelete && <button onClick={() => remove(l)} className="text-red-600 hover:underline text-xs">Delete</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
