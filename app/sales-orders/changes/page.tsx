'use client'
import { useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { supabase } from '@/lib/supabase'

interface ChangeRequest {
  id: string
  line_id: string
  import_id: string
  field: string
  old_value: string | null
  new_value: string
  reason: string | null
  request_type: string
  status: string
  requested_by_email: string | null
  requested_at: string
  reviewed_by_email: string | null
  reviewed_at: string | null
  factory_code: string
  sales_order_lines: { item_code: string; description: string } | null
  sales_imports: { file_name: string } | null
}

const FIELD_LABEL: Record<string, string> = {
  customer_name: 'Customer',
  item_code: 'Item Code',
  description: 'Description',
  quantity: 'Qty',
  outstanding_qty: 'Outstanding',
  delivery_date: 'Delivery Date',
  location_code: 'Location',
}

const STATUS_STYLES: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
}

const FILTERS = ['Pending', 'Approved', 'Rejected', 'All'] as const
type Filter = typeof FILTERS[number]

export default function PendingChangesPage() {
  const { profile, loading, error: profileError } = useProfile()
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [filter, setFilter] = useState<Filter>('Pending')
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'

  useEffect(() => {
    if (!profile) return
    loadRequests()
    // Live refresh on any change-request activity, with a poll fallback
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) supabase.realtime.setAuth(data.session.access_token)
    })
    const channel = supabase
      .channel('changes-page-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'change_requests' }, () => loadRequests())
      .subscribe()
    const timer = setInterval(loadRequests, 20000)
    return () => { supabase.removeChannel(channel); clearInterval(timer) }
  }, [profile])

  async function loadRequests() {
    const { data } = await supabase
      .from('change_requests')
      .select('*, sales_order_lines(item_code, description), sales_imports(file_name)')
      .order('requested_at', { ascending: false })
    setRequests((data as ChangeRequest[]) || [])
  }

  async function approve(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('approve_change_request', { p_id: id })
    if (rpcErr) { setError(rpcErr.message); setBusyId(''); return }
    setSuccess('Change request approved — the line has been updated.')
    setBusyId('')
    loadRequests()
  }

  async function reject(id: string) {
    if (!confirm('Reject this change request? The line will stay as it is.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: rpcErr } = await supabase.rpc('reject_change_request', { p_id: id })
    if (rpcErr) { setError(rpcErr.message); setBusyId(''); return }
    setSuccess('Change request rejected.')
    setBusyId('')
    loadRequests()
  }

  function fmt(iso: string | null) { return iso ? new Date(iso).toLocaleString() : '—' }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const shown = filter === 'All' ? requests : requests.filter(r => r.status === filter)
  const counts: Record<string, number> = { Pending: 0, Approved: 0, Rejected: 0 }
  requests.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Pending Changes</h1>
        <p className="text-gray-500 text-sm mb-5">
          {isHO ? 'Approve or reject change requests. Every decision is logged.' : 'Track the change requests you and your factory have raised.'}
        </p>

        <div className="flex gap-2 mb-4">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>{['Document', 'Line', 'Field', 'Change', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shown.length === 0 && (<tr><td colSpan={9} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} change requests.</td></tr>)}
              {shown.map(r => (
                <tr key={r.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 min-w-[140px]">{r.sales_imports?.file_name || '—'}</td>
                  <td className="px-3 py-2 min-w-[160px]">
                    <span className="font-mono font-medium">{r.sales_order_lines?.item_code || (r.request_type === 'delete' ? r.old_value : '—')}</span>
                    <span className="block text-gray-400">{r.sales_order_lines?.description}</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.request_type === 'delete' ? 'Whole line' : (FIELD_LABEL[r.field] || r.field)}</td>
                  <td className="px-3 py-2 min-w-[160px]">
                    {r.request_type === 'delete'
                      ? <span className="text-red-600 font-medium">🗑 Delete line</span>
                      : <><span className="line-through text-gray-400">{r.old_value || '(empty)'}</span><span className="mx-1">→</span><span className="font-medium text-gray-800">{r.new_value}</span></>}
                  </td>
                  <td className="px-3 py-2 text-gray-600 min-w-[140px]">{r.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="block">{r.requested_by_email}</span>
                    <span className="block text-gray-400">{fmt(r.requested_at)}</span>
                  </td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                    {r.status === 'Pending' ? '—' : (<><span className="block">{r.reviewed_by_email}</span><span className="block text-gray-400">{fmt(r.reviewed_at)}</span></>)}
                  </td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approve(r.id)} disabled={busyId === r.id}
                            className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => reject(r.id)} disabled={busyId === r.id}
                            className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
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
