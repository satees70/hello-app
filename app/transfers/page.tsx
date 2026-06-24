'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'

interface TItem { item_code: string; description: string | null; unit: string | null; qty: number | null }
interface Transfer {
  id: string; from_factory: string; to_factory: string; reason: string | null; status: string
  created_by_name: string | null; created_at: string
  sent_by_name: string | null; sent_at: string | null
  received_by_name: string | null; received_at: string | null
  items: TItem[]
}

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700', Sent: 'bg-blue-100 text-blue-700', Received: 'bg-green-100 text-green-700',
}

export default function TransfersPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'material_requests')
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [filter, setFilter] = useState<'all' | 'Pending' | 'Sent' | 'Received'>('all')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const myFacs = new Set(isHO ? [] : (profile?.factory_codes?.length ? profile.factory_codes : (profile?.factory_code ? [profile.factory_code] : [])))
  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  const canSend = (t: Transfer) => t.status === 'Pending' && (isHO || myFacs.has(t.from_factory))
  const canReceive = (t: Transfer) => t.status === 'Sent' && (isHO || myFacs.has(t.to_factory))

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const [{ data: t }, { data: f }] = await Promise.all([
      supabase.from('material_transfers').select('*').order('created_at', { ascending: false }),
      supabase.from('factories').select('code, name').order('code'),
    ])
    setFactories(f || [])
    const ids = (t || []).map(x => x.id)
    let itemsByT: Record<string, TItem[]> = {}
    if (ids.length) {
      const { data: its } = await supabase.from('material_transfer_items').select('transfer_id, item_code, description, unit, qty').in('transfer_id', ids)
      ;(its || []).forEach(it => { (itemsByT[it.transfer_id] = itemsByT[it.transfer_id] || []).push(it) })
    }
    setTransfers((t || []).map(x => ({ ...x, items: itemsByT[x.id] || [] })))
  }

  async function act(rpc: 'confirm_transfer_send' | 'confirm_transfer_receive', id: string, msg: string) {
    setBusy(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc(rpc, { p_id: id })
    setBusy('')
    if (e) { setError(e.message); return }
    setSuccess(msg); load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = transfers.filter(t => filter === 'all' || t.status === filter)

  return (
    <>
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <h1 className="text-2xl font-bold">Material Transfers</h1>
          <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} className="border rounded-lg px-3 py-1.5 text-sm">
            <option value="all">All</option>
            <option value="Pending">Pending (to send)</option>
            <option value="Sent">Sent (to receive)</option>
            <option value="Received">Received</option>
          </select>
        </div>
        <p className="text-gray-500 mb-5 text-sm">Materials moving between factories. The sending factory confirms dispatch, then the receiving factory confirms receipt — stock moves on each step.</p>

        {error && <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}
        {success && <div className="mb-4 p-3 rounded-lg bg-green-50 text-green-700 text-sm">{success}</div>}

        {shown.length === 0 && <p className="text-gray-400 text-sm">No transfers.</p>}
        <div className="space-y-3">
          {shown.map(t => (
            <div key={t.id} className="border rounded-xl p-4 bg-white shadow-sm">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="font-semibold">
                  {factoryName(t.from_factory)} <span className="text-gray-400">→</span> {factoryName(t.to_factory)}
                  <span className="text-gray-400 text-sm font-normal ml-2">{new Date(t.created_at).toLocaleDateString()}{t.created_by_name ? ` · by ${t.created_by_name}` : ''}</span>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${STATUS_STYLE[t.status] || 'bg-gray-100 text-gray-600'}`}>{t.status}</span>
              </div>
              {t.reason && <div className="text-xs text-gray-500 mt-0.5">{t.reason}</div>}
              <div className="mt-2 border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-left"><tr><th className="px-3 py-1.5">Material</th><th className="px-3 py-1.5">Description</th><th className="px-3 py-1.5 text-right">Qty</th></tr></thead>
                  <tbody>
                    {t.items.map((it, i) => (
                      <tr key={i} className="border-t"><td className="px-3 py-1.5 font-mono">{it.item_code}</td><td className="px-3 py-1.5 text-gray-600">{it.description}</td><td className="px-3 py-1.5 text-right">{it.qty} {it.unit}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex items-center justify-between flex-wrap gap-2">
                <div className="text-[11px] text-gray-500">
                  {t.sent_at && <span className="mr-3">Dispatched by {t.sent_by_name} · {new Date(t.sent_at).toLocaleString()}</span>}
                  {t.received_at && <span>Received by {t.received_by_name} · {new Date(t.received_at).toLocaleString()}</span>}
                </div>
                <div className="flex gap-2">
                  {canSend(t) && <button onClick={() => act('confirm_transfer_send', t.id, 'Dispatch confirmed — stock left ' + factoryName(t.from_factory) + '.')} disabled={busy === t.id} className="text-sm px-3 py-1.5 rounded-lg bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50">{busy === t.id ? '…' : 'Confirm dispatch'}</button>}
                  {canReceive(t) && <button onClick={() => act('confirm_transfer_receive', t.id, 'Receipt confirmed — stock added to ' + factoryName(t.to_factory) + '.')} disabled={busy === t.id} className="text-sm px-3 py-1.5 rounded-lg bg-green-700 text-white hover:bg-green-800 disabled:opacity-50">{busy === t.id ? '…' : 'Confirm receipt'}</button>}
                  {t.status === 'Pending' && !canSend(t) && <span className="text-xs text-gray-400">waiting for {factoryName(t.from_factory)} to dispatch</span>}
                  {t.status === 'Sent' && !canReceive(t) && <span className="text-xs text-gray-400">waiting for {factoryName(t.to_factory)} to receive</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
