'use client'
import { Fragment, useEffect, useState } from 'react'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'
import { can } from '@/lib/permissions'

interface Item { id: string; code: string; description: string; unit: string }
interface Adj {
  id: string; factory_code: string; item_code: string; description: string | null
  direction: string; quantity: number; batch_no: string | null; exp_date: string | null; reason: string | null
  status: string; requested_by_name: string | null; created_at: string; reviewed_by_name: string | null; reviewed_at: string | null
}

const STATUS_STYLE: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
}
const FILTERS = ['Pending', 'Approved', 'Rejected', 'All'] as const
type Filter = typeof FILTERS[number]

export default function StockAdjustmentPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'stock_adjustment')
  const [items, setItems] = useState<Item[]>([])
  const [factories, setFactories] = useState<{ code: string; name: string }[]>([])
  const [onHand, setOnHand] = useState<Record<string, number>>({}) // item_id|factory -> qty
  const [adjs, setAdjs] = useState<Adj[]>([])
  const [filter, setFilter] = useState<Filter>('Pending')
  const [collapsedFacs, setCollapsedFacs] = useState<Set<string>>(new Set())
  const toggleFac = (fc: string) => setCollapsedFacs(p => { const n = new Set(p); n.has(fc) ? n.delete(fc) : n.add(fc); return n })
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const isHO = profile?.factory_code === 'HEAD_OFFICE'
  const canEdit = can(profile, 'stock_adjustment', 'edit')
  const canEditFac = (fc: string) => can(profile, 'stock_adjustment', 'edit', fc)   // honours per-factory view-only

  // form
  const [factory, setFactory] = useState('')
  const [code, setCode] = useState('')
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [qty, setQty] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [expDate, setExpDate] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    setItems(await fetchAll<Item>('items', 'id, code, description, unit', 'code'))
    const { data: f } = await supabase.from('factories').select('code, name').order('code')
    setFactories(f || [])
    const codes = profile?.factory_codes?.length ? profile.factory_codes : [profile?.factory_code || '']
    const editable = (f || []).filter(x => isHO || (codes.includes(x.code) && can(profile, 'stock_adjustment', 'edit', x.code)))
    if (!isHO) setFactory(editable[0]?.code || '')
    else if (f && f.length && !factory) setFactory(f[0].code)
    const { data: st } = await supabase.from('item_stock').select('item_id, factory_code, quantity')
    const m: Record<string, number> = {}; (st || []).forEach(r => { m[`${r.item_id}|${r.factory_code}`] = Number(r.quantity) })
    setOnHand(m)
    await loadAdjs()
  }
  async function loadAdjs() {
    const { data } = await supabase.from('stock_adjustments').select('*').order('created_at', { ascending: false })
    setAdjs((data as Adj[]) || [])
  }

  const resolve = (c: string) => items.find(i => i.code.toLowerCase() === c.trim().toLowerCase())
  const item = resolve(code)
  const onHandQty = item ? (onHand[`${item.id}|${factory}`] ?? 0) : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setSuccess('')
    if (!canEditFac(factory)) { setError('You have view-only access at this factory.'); return }
    const it = resolve(code)
    if (!it) { setError('Pick a valid item code from the list.'); return }
    const n = Number(qty)
    if (!(n > 0)) { setError('Enter a quantity greater than zero.'); return }
    if (!reason.trim()) { setError('Please give a reason for the adjustment.'); return }
    setSaving(true)
    const { data, error: insErr } = await supabase.from('stock_adjustments').insert({
      factory_code: factory, item_id: it.id, item_code: it.code, description: it.description,
      direction, quantity: n, batch_no: batchNo || null, exp_date: direction === 'in' ? (expDate || null) : null,
      reason: reason.trim(), requested_by: profile?.id, requested_by_name: profile?.full_name || null,
    }).select('id').single()
    if (insErr) { setError(insErr.message); setSaving(false); return }
    // Head Office is the approver — apply immediately; staff entries wait for approval
    if (isHO && data) {
      const { error: apErr } = await supabase.rpc('approve_stock_adjustment', { p_id: data.id })
      if (apErr) { setError(`Saved, but could not apply: ${apErr.message}`); setSaving(false); loadAdjs(); return }
    }
    setSaving(false)
    setSuccess(isHO ? 'Stock adjusted.' : 'Adjustment submitted — waiting for Head Office approval.')
    setQty(''); setBatchNo(''); setExpDate(''); setReason('')
    load()
  }

  async function approve(id: string) {
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('approve_stock_adjustment', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Adjustment approved — stock updated.'); setBusyId(''); load()
  }
  async function reject(id: string) {
    if (!confirm('Reject this stock adjustment? Stock will not change.')) return
    setBusyId(id); setError(''); setSuccess('')
    const { error: e } = await supabase.rpc('reject_stock_adjustment', { p_id: id })
    if (e) { setError(e.message); setBusyId(''); return }
    setSuccess('Adjustment rejected.'); setBusyId(''); load()
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const factoryName = (c: string) => factories.find(f => f.code === c)?.name || c
  // Locations this user may adjust: all (HO), else their assigned factory_codes
  const myCodes = profile.factory_codes && profile.factory_codes.length ? profile.factory_codes : [profile.factory_code]
  const myFactories = isHO ? factories : factories.filter(f => myCodes.includes(f.code) && canEditFac(f.code))
  const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—'
  const fmtD = (d: string | null) => d ? d.split('-').reverse().join('/') : '—'
  const shown = filter === 'All' ? adjs : adjs.filter(a => a.status === filter)
  const counts: Record<string, number> = { Pending: 0, Approved: 0, Rejected: 0 }
  adjs.forEach(a => { counts[a.status] = (counts[a.status] || 0) + 1 })

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Stock Adjustment</h1>
        <p className="text-gray-500 text-sm mb-5">Manually add or remove stock when there is no document. {isHO ? 'Your entries apply immediately.' : 'Entries are submitted to Head Office for approval before stock changes.'}</p>

        {error && <p className="text-red-500 text-sm bg-red-50 p-2 rounded mb-3">{error}</p>}
        {success && <p className="text-green-600 text-sm bg-green-50 p-2 rounded mb-3">{success}</p>}

        {canEdit && (
          <form onSubmit={submit} className="bg-white border rounded-xl shadow-sm p-4 mb-8">
            <div className="flex flex-wrap gap-4 items-end">
              {myFactories.length > 1 ? (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory (location)</span>
                  <select value={factory} onChange={e => setFactory(e.target.value)} className="border rounded px-2 py-1.5 text-sm bg-white">
                    {myFactories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
                  </select></div>
              ) : (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Factory (location)</span>
                  <div className="border rounded px-2 py-1.5 text-sm bg-gray-50 text-gray-700 min-w-[140px]">{factoryName(factory) || '—'}</div></div>
              )}
              <div className="flex flex-col gap-1 min-w-[200px] flex-1"><span className="text-xs font-medium text-gray-600">Item</span>
                <input list="adj-items" value={code} onChange={e => setCode(e.target.value)} placeholder="Type code…" className="border rounded px-2 py-1.5 text-sm" />
                <datalist id="adj-items">{items.map(i => <option key={i.id} value={i.code}>{i.description}</option>)}</datalist>
                {item ? <span className="text-xs text-gray-500">{item.description} · on hand: <strong>{onHandQty}</strong> {item.unit}</span> : code ? <span className="text-xs text-red-500">Unknown code</span> : null}
              </div>
              <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Direction</span>
                <select value={direction} onChange={e => setDirection(e.target.value as 'in' | 'out')} className="border rounded px-2 py-1.5 text-sm bg-white">
                  <option value="in">➕ Stock IN (add)</option>
                  <option value="out">➖ Stock OUT (remove)</option>
                </select></div>
              <div className="flex flex-col gap-1 w-28"><span className="text-xs font-medium text-gray-600">Quantity {item ? `(${item.unit})` : ''}</span>
                <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
            </div>
            <div className="flex flex-wrap gap-4 items-end mt-3">
              <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Batch no. {direction === 'in' ? '' : '(optional)'}</span>
                <input value={batchNo} onChange={e => setBatchNo(e.target.value)} placeholder="e.g. 260606AH" className="border rounded px-2 py-1.5 text-sm" /></div>
              {direction === 'in' && (
                <div className="flex flex-col gap-1"><span className="text-xs font-medium text-gray-600">Expiry (optional)</span>
                  <input type="date" value={expDate} onChange={e => setExpDate(e.target.value)} className="border rounded px-2 py-1.5 text-sm" /></div>
              )}
              <div className="flex flex-col gap-1 min-w-[220px] flex-1"><span className="text-xs font-medium text-gray-600">Reason</span>
                <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this adjustment needed?" className="border rounded px-2 py-1.5 text-sm" /></div>
              <button disabled={saving} className="bg-teal-600 text-white px-5 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : isHO ? 'Adjust stock' : 'Submit for approval'}</button>
            </div>
            {direction === 'out' && item && onHandQty !== null && Number(qty) > onHandQty && <p className="text-amber-600 text-xs mt-2">⚠ Removing more than on-hand ({onHandQty}). Approval will fail if there isn’t enough stock.</p>}
          </form>
        )}

        <div className="flex gap-2 mb-4">
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${filter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
              {f}{f !== 'All' && counts[f] ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-auto max-h-[28rem]">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0 z-10">
              <tr>{[...(isHO ? ['Factory'] : []), 'Item', 'In/Out', 'Qty', 'Batch', 'Reason', 'Requested by', 'Status', 'Reviewed by', isHO ? 'Action' : ''].map((h, i) => (
                <th key={i} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={isHO ? 10 : 8} className="text-center py-8 text-gray-400">No {filter !== 'All' ? filter.toLowerCase() : ''} adjustments.</td></tr>}
              {isHO && [...new Set(shown.map(a => a.factory_code))].map(fc => (
                <Fragment key={fc}>
                  <tr className="bg-gray-50 border-b cursor-pointer hover:bg-gray-100" onClick={() => toggleFac(fc)}>
                    <td colSpan={10} className="px-3 py-1.5 font-semibold text-gray-700"><span className="text-gray-400 mr-1">{collapsedFacs.has(fc) ? '▸' : '▾'}</span>🏭 {factoryName(fc)} <span className="text-gray-400 font-normal">· {shown.filter(a => a.factory_code === fc).length}</span></td>
                  </tr>
                  {!collapsedFacs.has(fc) && shown.filter(a => a.factory_code === fc).map(a => renderRow(a))}
                </Fragment>
              ))}
              {!isHO && shown.map(a => renderRow(a))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  function renderRow(a: Adj) {
    return (
                <tr key={a.id} className="border-b last:border-0 align-top hover:bg-gray-50">
                  {isHO && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{factoryName(a.factory_code)}</td>}
                  <td className="px-3 py-2"><span className="font-mono font-medium">{a.item_code}</span><span className="block text-gray-400">{a.description}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.direction === 'in' ? <span className="text-green-700 font-medium">➕ IN</span> : <span className="text-red-600 font-medium">➖ OUT</span>}</td>
                  <td className="px-3 py-2 text-right font-semibold">{a.quantity}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{a.batch_no || '—'}{a.exp_date ? <span className="block text-gray-400">exp {fmtD(a.exp_date)}</span> : null}</td>
                  <td className="px-3 py-2 text-gray-600 min-w-[120px]">{a.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="block">{a.requested_by_name || '—'}</span><span className="block text-gray-400">{fmt(a.created_at)}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[a.status] || 'bg-gray-100 text-gray-700'}`}>{a.status}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-600">{a.status === 'Pending' ? '—' : (<><span className="block">{a.reviewed_by_name}</span><span className="block text-gray-400">{fmt(a.reviewed_at)}</span></>)}</td>
                  {isHO && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.status === 'Pending' ? (
                        <div className="flex gap-2">
                          <button onClick={() => approve(a.id)} disabled={busyId === a.id} className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 disabled:opacity-50">Approve</button>
                          <button onClick={() => reject(a.id)} disabled={busyId === a.id} className="bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 disabled:opacity-50">Reject</button>
                        </div>
                      ) : <span className="text-gray-400">done</span>}
                    </td>
                  )}
                </tr>
    )
  }
}
