'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface LocationRow { id: string; location_code: string; factory_code: string }
const EMPTY = { location_code: '', factory_code: '' }

export default function LocationMapPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const [rows, setRows] = useState<LocationRow[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<LocationRow | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!profile) return
    if (profile.factory_code !== 'HEAD_OFFICE') { router.replace('/dashboard'); return }
    loadData()
  }, [profile])

  async function loadData() {
    const [{ data: lm }, { data: f }] = await Promise.all([
      supabase.from('location_map').select('*').order('location_code'),
      supabase.from('factories').select('*').order('code'),
    ])
    setRows(lm || [])
    setFactories(f || [])
  }

  function openCreate() { setEditing(null); setForm(EMPTY); setError(''); setShowForm(true) }
  function openEdit(row: LocationRow) { setEditing(row); setForm({ location_code: row.location_code, factory_code: row.factory_code }); setError(''); setShowForm(true) }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    if (editing) {
      const { error } = await supabase.from('location_map').update({ factory_code: form.factory_code }).eq('id', editing.id)
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('location_map').insert(form)
      if (error) { setError(error.message); setSaving(false); return }
    }
    setShowForm(false); setSaving(false); loadData()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this mapping?')) return
    await supabase.from('location_map').delete().eq('id', id)
    loadData()
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (!profile) return null

  const getFactoryName = (code: string) => factories.find(f => f.code === code)?.name || code

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Location Map</h1>
            <p className="text-gray-500 text-sm mt-1">Map location codes to factories</p>
          </div>
          <button onClick={openCreate}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium">
            + Add Mapping
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{editing ? 'Edit Mapping' : 'New Mapping'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Location Code</label>
                <input value={form.location_code} onChange={e => setForm({ ...form, location_code: e.target.value.toUpperCase() })}
                  className="w-full border rounded-lg px-3 py-2 font-mono" required disabled={!!editing} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Factory</label>
                <select value={form.factory_code} onChange={e => setForm({ ...form, factory_code: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" required>
                  <option value="">-- Select Factory --</option>
                  {factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                </select>
              </div>
            </div>
            {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded">{error}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={saving}
                className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium">
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </form>
        )}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {['Location Code', 'Factory', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={3} className="text-center py-8 text-gray-400">No mappings yet</td></tr>
              )}
              {rows.map(row => (
                <tr key={row.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono font-medium">{row.location_code}</td>
                  <td className="px-4 py-3">
                    <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs font-medium">
                      {getFactoryName(row.factory_code)}
                    </span>
                  </td>
                  <td className="px-4 py-3 flex gap-3">
                    <button onClick={() => openEdit(row)} className="text-blue-600 hover:underline text-xs">Edit</button>
                    <button onClick={() => handleDelete(row.id)} className="text-red-500 hover:underline text-xs">Delete</button>
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
