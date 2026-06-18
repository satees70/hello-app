'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface Network { id: string; label: string | null; ip: string; enabled: boolean; created_at: string }

export default function AllowedNetworksPage() {
  const { profile, loading } = useProfile()
  const router = useRouter()
  const [nets, setNets] = useState<Network[]>([])
  const [guardOn, setGuardOn] = useState(false)
  const [myIp, setMyIp] = useState('')
  const [label, setLabel] = useState('')
  const [ip, setIp] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

  useEffect(() => {
    if (!profile) return
    if (profile.factory_code !== 'HEAD_OFFICE') { router.replace('/dashboard'); return }
    load()
    fetch('/api/whoami').then(r => r.json()).then(d => setMyIp(d.ip || '')).catch(() => {})
  }, [profile])

  async function load() {
    const [{ data: n }, { data: cfg }] = await Promise.all([
      supabase.from('allowed_networks').select('*').order('created_at', { ascending: true }),
      supabase.from('app_config').select('network_guard_enabled').eq('id', 1).maybeSingle(),
    ])
    setNets(n || [])
    setGuardOn(!!cfg?.network_guard_enabled)
  }

  async function toggleGuard() {
    setError('')
    const next = !guardOn
    const { error } = await supabase.from('app_config').update({ network_guard_enabled: next }).eq('id', 1)
    if (error) { setError(error.message); return }
    setGuardOn(next)
  }

  async function addIp(value: string, lbl: string) {
    const v = value.trim()
    if (!v) { setError('Enter an IP address'); return }
    setBusy(true); setError('')
    const { error } = await supabase.from('allowed_networks').insert({ ip: v, label: lbl.trim() || null })
    setBusy(false)
    if (error) { setError(error.message); return }
    setLabel(''); setIp('')
    load()
  }

  async function toggleRow(n: Network) {
    setError('')
    const { error } = await supabase.from('allowed_networks').update({ enabled: !n.enabled }).eq('id', n.id)
    if (error) { setError(error.message); return }
    load()
  }

  function startEdit(n: Network) { setEditId(n.id); setEditLabel(n.label || ''); setError('') }
  async function saveEdit(n: Network) {
    setError('')
    const { error } = await supabase.from('allowed_networks').update({ label: editLabel.trim() || null }).eq('id', n.id)
    if (error) { setError(error.message); return }
    setEditId(null); setEditLabel('')
    load()
  }

  async function removeRow(n: Network) {
    if (!confirm(`Remove ${n.label || n.ip}?`)) return
    setError('')
    const { error } = await supabase.from('allowed_networks').delete().eq('id', n.id)
    if (error) { setError(error.message); return }
    load()
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (!profile) return null

  const enabledCount = nets.filter(n => n.enabled).length
  const myIpListed = nets.some(n => n.enabled && n.ip.trim() === myIp.trim())

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Allowed Networks</h1>
        <p className="text-gray-500 text-sm mb-6">
          When the office-only guard is on, factory staff can only use the app from one of the allowed office IPs below.
          Head Office &amp; Admin accounts are always allowed, from anywhere.
        </p>

        {/* Master switch */}
        <div className="bg-white rounded-xl shadow-sm border p-5 mb-5 flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold">Office-only access</div>
            <div className="text-sm text-gray-500">{guardOn ? 'ON — factory staff are restricted to the allowed IPs.' : 'OFF — anyone can log in from anywhere.'}</div>
          </div>
          <button onClick={toggleGuard}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${guardOn ? 'bg-green-500' : 'bg-gray-300'}`}>
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${guardOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {guardOn && enabledCount === 0 && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-5">
            ⚠ The guard is ON but there are no allowed IPs — all factory staff are currently locked out. Add at least one IP below (or turn the guard off).
          </p>
        )}

        {/* Your current IP */}
        <div className="bg-white rounded-xl shadow-sm border p-5 mb-5">
          <div className="text-sm text-gray-500 mb-1">Your current internet address (this device, right now)</div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono text-lg">{myIp || '…'}</span>
            {myIp && !myIpListed && (
              <button onClick={() => addIp(myIp, label)} disabled={busy}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
                + Add this IP as allowed
              </button>
            )}
            {myIp && myIpListed && <span className="text-green-600 text-sm font-medium">✓ already allowed</span>}
          </div>
          <p className="text-xs text-gray-400 mt-2">Tip: open this page on each factory&apos;s Wi-Fi and click &quot;Add this IP&quot; to register that office.</p>
        </div>

        {/* Manual add */}
        <div className="bg-white rounded-xl shadow-sm border p-5 mb-5">
          <div className="font-semibold mb-3">Add an IP manually</div>
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Label (optional)</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. AVINA102 office"
                className="border rounded-lg px-3 py-2 text-sm w-48" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">IP address</label>
              <input value={ip} onChange={e => setIp(e.target.value)} placeholder="123.45.67.89"
                className="border rounded-lg px-3 py-2 text-sm w-48 font-mono" />
            </div>
            <button onClick={() => addIp(ip, label)} disabled={busy}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">Add</button>
          </div>
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-4">{error}</p>}

        {/* List */}
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Label', 'IP address', 'Status', ''].map((h, i) => (
                <th key={i} className="text-left px-4 py-3 font-medium text-gray-600">{h}</th>))}</tr>
            </thead>
            <tbody>
              {nets.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-gray-400">No allowed IPs yet</td></tr>}
              {nets.map(n => (
                <tr key={n.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {editId === n.id ? (
                      <input value={editLabel} onChange={e => setEditLabel(e.target.value)} autoFocus
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(n); if (e.key === 'Escape') setEditId(null) }}
                        placeholder="Office name" className="border rounded-lg px-2 py-1 text-sm w-48" />
                    ) : (
                      <>{n.label || '—'}{n.ip.trim() === myIp.trim() && <span className="ml-2 text-xs text-blue-600">(this device)</span>}</>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">{n.ip}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleRow(n)} className={`px-2 py-0.5 rounded-full text-xs font-medium ${n.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {n.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {editId === n.id ? (
                      <>
                        <button onClick={() => saveEdit(n)} className="text-blue-600 hover:underline text-sm font-medium">Save</button>
                        <button onClick={() => setEditId(null)} className="text-gray-500 hover:underline text-sm ml-3">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(n)} className="text-blue-600 hover:underline text-sm">Edit</button>
                        <button onClick={() => removeRow(n)} className="text-red-600 hover:underline text-sm ml-3">Remove</button>
                      </>
                    )}
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
