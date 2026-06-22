'use client'
import { Fragment, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Navbar from '@/components/Navbar'
import { useProfile } from '@/hooks/useProfile'
import { useRequireView } from '@/hooks/useRequireView'
import { supabase, fetchAll } from '@/lib/supabase'

interface Line {
  id: string; customer_name: string; so_number: string; item_code: string; description: string
  quantity: number; outstanding_qty: number; delivery_date: string; location_code: string; factory_code: string
}

export default function SupplierPage() {
  const { profile, loading, error: profileError } = useProfile()
  useRequireView(profile, 'sales')
  const router = useRouter()
  const [lines, setLines] = useState<Line[]>([])
  const [q, setQ] = useState('')
  const [pendingOnly, setPendingOnly] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (code: string) => setOpen(p => { const n = new Set(p); n.has(code) ? n.delete(code) : n.add(code); return n })

  useEffect(() => { if (profile) load() }, [profile])
  async function load() {
    const rows = await fetchAll<Line>('sales_order_lines',
      'id, customer_name, so_number, item_code, description, quantity, outstanding_qty, delivery_date, location_code, factory_code',
      qb => qb.or('location_code.eq.SUPPLIER,factory_code.eq.SUPPLIER'))
    setLines(rows)
  }

  if (loading && !profileError) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (profileError) return <div className="flex min-h-screen items-center justify-center flex-col gap-4"><p className="text-red-500 text-lg">{profileError}</p><a href="/login" className="text-blue-600 underline">Back to login</a></div>
  if (!profile) return null

  const n = (x: number) => Number(Number(x || 0).toPrecision(12))
  const fmtDate = (d: string | null) => d ? d.split('-').reverse().join('/') : '—'
  const term = q.trim().toLowerCase()
  const visible = lines.filter(l =>
    (!pendingOnly || Number(l.outstanding_qty || 0) > 0) &&
    (!term || (l.item_code || '').toLowerCase().includes(term) || (l.description || '').toLowerCase().includes(term)))

  // Group by item — totals tell me how much to order
  const groups: Record<string, { code: string; description: string; qty: number; outstanding: number; lines: Line[]; next: string | null }> = {}
  visible.forEach(l => {
    const g = (groups[l.item_code] = groups[l.item_code] || { code: l.item_code, description: l.description, qty: 0, outstanding: 0, lines: [], next: null })
    g.qty += Number(l.quantity || 0)
    g.outstanding += Number(l.outstanding_qty || 0)
    g.lines.push(l)
    if (l.delivery_date && (!g.next || l.delivery_date < g.next)) g.next = l.delivery_date
  })
  // Soonest delivery first, then biggest outstanding
  const list = Object.values(groups).sort((a, b) => (a.next || '9999').localeCompare(b.next || '9999') || b.outstanding - a.outstanding)
  const totalOutstanding = list.reduce((s, g) => s + g.outstanding, 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar factoryCode={profile.factory_code} fullName={profile.full_name} role={profile.role} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-2xl font-bold mb-1">Supplier — to order</h1>
        <p className="text-gray-500 text-sm mb-5">Items on sales orders routed to <strong>SUPPLIER</strong>, grouped by item. Use the outstanding totals to decide what to order.</p>

        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item code or description…" className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm" />
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)} className="h-4 w-4" /> Pending only</label>
          <span className="text-gray-400 text-xs">{list.length} item(s) · {n(totalOutstanding)} outstanding</span>
        </div>

        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>{['Item', 'Description', 'Ordered', 'Outstanding', 'Orders', 'Next delivery', ''].map(h => (
                <th key={h} className="text-left px-4 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>))}</tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} className="text-center py-10 text-gray-400">Nothing for the supplier{pendingOnly ? ' pending' : ''}.</td></tr>}
              {list.map(g => (
                <Fragment key={g.code}>
                  <tr className="border-b last:border-0 hover:bg-gray-50 cursor-pointer" onClick={() => toggle(g.code)}>
                    <td className="px-4 py-2 font-mono font-medium whitespace-nowrap">{open.has(g.code) ? '▾' : '▸'} {g.code}</td>
                    <td className="px-4 py-2 text-gray-600">{g.description}</td>
                    <td className="px-4 py-2 text-right">{n(g.qty)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-amber-700">{n(g.outstanding)}</td>
                    <td className="px-4 py-2 text-right">{g.lines.length}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmtDate(g.next)}</td>
                    <td className="px-4 py-2 text-blue-600 text-xs">{open.has(g.code) ? 'Hide' : 'Orders'}</td>
                  </tr>
                  {open.has(g.code) && (
                    <tr className="bg-gray-50/60"><td colSpan={7} className="px-4 py-2">
                      <table className="w-full text-xs">
                        <thead><tr className="text-gray-500">{['Customer', 'SO No', 'Qty', 'Outstanding', 'Delivery', 'Location'].map(h => <th key={h} className="text-left px-2 py-1 font-medium">{h}</th>)}</tr></thead>
                        <tbody>
                          {g.lines.sort((a, b) => (a.delivery_date || '').localeCompare(b.delivery_date || '')).map(l => (
                            <tr key={l.id} className="border-t">
                              <td className="px-2 py-1">{l.customer_name}</td>
                              <td className="px-2 py-1">{l.so_number ? <button onClick={e => { e.stopPropagation(); router.push(`/discussion?so=${encodeURIComponent(l.so_number)}`) }} className="text-blue-600 hover:underline font-mono">{l.so_number}</button> : '—'}</td>
                              <td className="px-2 py-1 text-right">{n(l.quantity)}</td>
                              <td className="px-2 py-1 text-right font-medium text-amber-700">{n(l.outstanding_qty)}</td>
                              <td className="px-2 py-1 whitespace-nowrap">{fmtDate(l.delivery_date)}</td>
                              <td className="px-2 py-1">{l.location_code}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
