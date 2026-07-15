'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase } from '@/lib/supabase'

interface Note {
  id: string; so_number: string | null; customer_name: string | null; item_code: string | null; description: string | null
  factory_code: string | null; ordered_qty: number | null; delivered_qty: number | null; cancel_qty: number | null
  reason: string | null; status: string
  requested_by_name: string | null; reviewed_by_name: string | null; reviewed_at: string | null; created_at: string
}

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700', Approved: 'bg-green-100 text-green-700', Rejected: 'bg-red-100 text-red-700',
}

export default function CancelNotesPage() {
  const { profile, loading, error } = useProfile()
  useRequireView(profile, 'sales')
  const [notes, setNotes] = useState<Note[]>([])
  const [q, setQ] = useState('')
  const [statusF, setStatusF] = useState('')

  useEffect(() => { if (profile) load() }, [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  async function load() {
    const { data } = await supabase.from('so_balance_cancel_requests').select('*').order('created_at', { ascending: false })
    setNotes((data as Note[]) || [])
  }
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading…</div>
  if (error) return <div className="flex min-h-screen items-center justify-center text-red-500">{error}</div>
  if (!profile) return null

  const n = q.trim().toLowerCase()
  const shown = notes.filter(x =>
    (!statusF || x.status === statusF) &&
    (!n || `${x.so_number} ${x.customer_name} ${x.item_code} ${x.description} ${x.reason}`.toLowerCase().includes(n)))

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Cancel Notes</h1>
        <p className="text-gray-500 text-sm mb-4">Cancelled order balances — the leftover (undelivered) quantity that was cancelled off a delivered order. Pending ones are approved in <span className="font-medium">Pending Changes</span>.</p>

        <div className="flex flex-wrap gap-2 mb-4 text-sm">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search SO / customer / item / reason…" className="border rounded-lg px-3 py-2 flex-1 min-w-[220px]" />
          <select value={statusF} onChange={e => setStatusF(e.target.value)} className="border rounded-lg px-3 py-2">
            <option value="">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['SO', 'Customer', 'Item', 'Ordered', 'Delivered', 'Cancelled', 'Reason', 'Status', 'Requested', 'Reviewed'].map(h =>
                <th key={h} className="text-left px-3 py-2.5 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={10} className="text-center py-10 text-gray-400">No cancel notes.</td></tr>}
              {shown.map(x => (
                <tr key={x.id} className="border-b last:border-0 hover:bg-gray-50 align-top">
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{x.so_number || '—'}</td>
                  <td className="px-3 py-2 min-w-[140px]">{x.customer_name || '—'}</td>
                  <td className="px-3 py-2"><span className="font-medium">{x.item_code}</span>{x.description ? <span className="block text-xs text-gray-500">{x.description}</span> : null}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.ordered_qty ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.delivered_qty ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-orange-600">{x.cancel_qty ?? '—'}</td>
                  <td className="px-3 py-2 min-w-[140px] text-gray-600">{x.reason || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[x.status] || 'bg-gray-100 text-gray-600'}`}>{x.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{x.requested_by_name || '—'}<span className="block text-gray-400">{fmt(x.created_at)}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500 text-xs">{x.reviewed_by_name || '—'}{x.reviewed_at ? <span className="block text-gray-400">{fmt(x.reviewed_at)}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">{shown.length} note(s).</p>
      </div>
    </div>
  )
}
