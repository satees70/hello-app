'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Factory { code: string; name: string }

export default function FactoriesPage() {
  const { profile, loading, error: profileError } = useProfile()
  const router = useRouter()
  const [factories, setFactories] = useState<Factory[]>([])
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    if (!profile) return
    if (profile.factory_code !== 'HEAD_OFFICE') { router.replace('/dashboard'); return }
    load()
  }, [profile])

  async function load() {
    const { data } = await supabase.from('factories').select('code, name').order('code')
    setFactories((data as Factory[]) || [])
  }

  async function addFactory(e: React.FormEvent) {
    e.preventDefault()
    const c = code.trim().toUpperCase()
    if (!c || !name.trim()) { setError('Enter both a code and a name.'); return }
    setBusy('add'); setError(''); setSuccess('')
    const { error: e1 } = await supabase.from('factories').insert({ code: c, name: name.trim() })
    setBusy('')
    if (e1) { setError(e1.message.includes('duplicate') ? `Factory code "${c}" already exists.` : e1.message); return }
    setCode(''); setName(''); setSuccess(`Factory ${c} added.`); load()
  }

  async function rename(f: Factory) {
    const newName = (nameEdits[f.code] ?? f.name).trim()
    if (!newName) { setError('Name cannot be empty.'); return }
    setBusy(`name|${f.code}`); setError(''); setSuccess('')
    const { error: e1 } = await supabase.from('factories').update({ name: newName }).eq('code', f.code)
    setBusy('')
    if (e1) { setError(e1.message); return }
    setSuccess(`${f.code} renamed.`)
    setNameEdits(prev => { const n = { ...prev }; delete n[f.code]; return n })
    load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Factories</h1>
        <p className="text-gray-500 text-sm mb-5">Add a new factory / location, or rename an existing one. After adding, assign users to it under <strong>Setup → Users</strong>.</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        <form onSubmit={addFactory} className="flex flex-wrap items-end gap-3 mb-6 bg-white border rounded-xl p-4 shadow-sm">
          <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Code</span>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. AVINA 105" className="border rounded px-2 py-1.5 text-sm uppercase" /></div>
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]"><span className="text-xs font-medium text-gray-600">Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Avina Factory 105" className="border rounded px-2 py-1.5 text-sm" /></div>
          <button disabled={busy === 'add' || !code.trim() || !name.trim()} className="bg-teal-600 text-white px-4 py-1.5 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">{busy === 'add' ? 'Adding…' : 'Add factory'}</button>
        </form>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Code', 'Name', ''].map(h => <th key={h} className="text-left px-4 py-2 font-medium text-gray-600">{h}</th>)}</tr>
            </thead>
            <tbody>
              {factories.length === 0 && <tr><td colSpan={3} className="text-center py-8 text-gray-400">No factories yet.</td></tr>}
              {factories.map(f => (
                <tr key={f.code} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2 font-mono font-medium whitespace-nowrap">{f.code}</td>
                  <td className="px-4 py-2"><input value={nameEdits[f.code] ?? f.name} onChange={e => setNameEdits(prev => ({ ...prev, [f.code]: e.target.value }))} className="border rounded px-2 py-1 text-sm w-full max-w-xs" /></td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {(nameEdits[f.code] !== undefined && nameEdits[f.code] !== f.name)
                      ? <button onClick={() => rename(f)} disabled={busy === `name|${f.code}`} className="text-blue-600 hover:underline text-xs disabled:opacity-50">{busy === `name|${f.code}` ? 'Saving…' : 'Save'}</button>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-gray-400 text-xs mt-3">The <strong>code</strong> can’t be changed once created (it’s used across stock, batches and users). Deleting a factory isn’t offered here because it’s referenced throughout — tell me if you ever need to retire one.</p>
      </div>
    </div>
  )
}
