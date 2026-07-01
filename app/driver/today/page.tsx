'use client'
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { todayISO } from '@/lib/delivery'

interface Driver { id: string; name: string; phone: string | null }
interface Trip {
  route: string; delivery_date: string
  lorry_no: string | null; driver: string | null; kelindan: string | null
  odometer_start: number | null; odometer_end: number | null
}
interface Order {
  id: string; so_number: string; customer_name: string | null; route: string | null
  delivered_at: string | null; delivery_photo_path: string | null; delivery_note: string | null
}
interface LineBlock { trip: Trip; orders: Order[] }
// One outlet (same customer_name) on a line — may bundle several SO orders.
interface OutletGroup { key: string; customer: string; orders: Order[]; allDelivered: boolean; firstDeliveredAt: string | null }

const DRIVER_KEY = 'easwari_driver_id'

// Group a line's orders by outlet (customer_name); each group is delivered as one.
function groupByOutlet(route: string, orders: Order[]): OutletGroup[] {
  const map = new Map<string, Order[]>()
  for (const o of orders) {
    const cust = o.customer_name || '—'
    if (!map.has(cust)) map.set(cust, [])
    map.get(cust)!.push(o)
  }
  return [...map].map(([customer, list]) => {
    const delivered = list.filter(o => o.delivered_at)
    return {
      key: `${route}||${customer}`,
      customer,
      orders: list,
      allDelivered: delivered.length === list.length,
      firstDeliveredAt: delivered.length ? delivered.map(o => o.delivered_at!).sort()[0] : null,
    }
  })
}

export default function DriverTodayPage() {
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [driverId, setDriverId] = useState('')
  const [lines, setLines] = useState<LineBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Per-outlet delivery form (keyed by the outlet group).
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [photo, setPhoto] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const today = todayISO()
  const driverName = drivers.find(d => d.id === driverId)?.name || ''

  useEffect(() => {
    supabase.from('delivery_resources').select('id, name, phone').eq('kind', 'driver').eq('active', true).order('name')
      .then(({ data }) => {
        const list = (data as Driver[]) || []
        setDrivers(list)
        const saved = typeof window !== 'undefined' ? localStorage.getItem(DRIVER_KEY) : ''
        setDriverId(saved && list.some(d => d.id === saved) ? saved : (list[0]?.id || ''))
      })
  }, [])

  const load = useCallback(async () => {
    if (!driverName) { setLines([]); setLoading(false); return }
    setLoading(true); setError(null)

    // Lines assigned to this driver today.
    const { data: trips, error: te } = await supabase.from('delivery_trips')
      .select('route, delivery_date, lorry_no, driver, kelindan, odometer_start, odometer_end')
      .eq('driver', driverName).eq('delivery_date', today)
    if (te) { setError(te.message); setLoading(false); return }

    const routes = (trips || []).map(t => t.route)
    let orders: Order[] = []
    if (routes.length) {
      const { data: ods, error: oe } = await supabase.from('delivery_schedule')
        .select('id, so_number, customer_name, route, delivered_at, delivery_photo_path, delivery_note')
        .eq('delivery_date', today).in('route', routes).order('so_number')
      if (oe) { setError(oe.message); setLoading(false); return }
      orders = (ods as Order[]) || []
    }

    setLines((trips as Trip[] || []).map(trip => ({
      trip,
      orders: orders.filter(o => o.route === trip.route),
    })))
    setLoading(false)
  }, [driverName, today])

  useEffect(() => { load() }, [load])

  function pickDriver(id: string) {
    setDriverId(id)
    if (typeof window !== 'undefined') localStorage.setItem(DRIVER_KEY, id)
  }

  async function confirmDeliver(g: OutletGroup) {
    setSaving(true); setError(null)
    try {
      const ids = g.orders.map(o => o.id)
      let photo_path: string | null = null
      if (photo) {
        const path = `schedule/${ids[0]}/${Date.now()}.jpg`
        const { error: upErr } = await supabase.storage.from('delivery-photos')
          .upload(path, photo, { upsert: true, contentType: photo.type || 'image/jpeg' })
        if (upErr) throw upErr
        photo_path = path
      }
      const res = await fetch('/api/driver/deliver', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, photo_path, note }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed')
      setOpenKey(null); setPhoto(null); setNote('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function undoDeliver(g: OutletGroup) {
    if (!confirm(`Undo delivery for ${g.customer}?`)) return
    const res = await fetch('/api/driver/deliver', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: g.orders.map(o => o.id), undo: true }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Undo failed') } else await load()
  }

  async function saveOdometer(trip: Trip, field: 'odometer_start' | 'odometer_end', value: string) {
    const res = await fetch('/api/driver/odometer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: trip.route, delivery_date: trip.delivery_date, [field]: value }),
    })
    if (!res.ok) { const j = await res.json(); setError(j.error || 'Odometer save failed') } else await load()
  }

  async function viewPhoto(path: string) {
    const { data } = await supabase.storage.from('delivery-photos').createSignedUrl(path, 120)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }

  const fmtTime = (iso: string | null) => iso
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
    : ''

  const allGroups = lines.flatMap(l => groupByOutlet(l.trip.route, l.orders))
  const done = allGroups.filter(g => g.allDelivered).length

  return (
    <main className="max-w-md mx-auto p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Today&apos;s deliveries</h1>
        <p className="text-sm text-gray-500">{today.split('-').reverse().join('/')}</p>
      </header>

      {drivers.length > 0 && (
        <label className="block mb-4 text-sm">Driver
          <select value={driverId} onChange={e => pickDriver(e.target.value)}
            className="block w-full mt-1 rounded border border-gray-300 px-3 py-2 text-base">
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}

      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}

      {!loading && <p className="text-sm text-gray-500 mb-3">{done} of {allGroups.length} outlets delivered</p>}

      {!loading && lines.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-500">
          No lines assigned to you today.<br />
          <span className="text-sm">The office assigns drivers on the Delivery Schedule page.</span>
        </div>
      )}

      <div className="space-y-5">
        {lines.map(({ trip, orders }) => {
          const groups = groupByOutlet(trip.route, orders)
          return (
          <section key={trip.route} className="rounded-lg border border-gray-200 overflow-hidden">
            <header className="bg-gray-50 px-4 py-2 border-b border-gray-200">
              <div className="font-medium">{trip.route}</div>
              <div className="text-xs text-gray-500">
                {trip.lorry_no && <>Lorry {trip.lorry_no} · </>}
                {trip.kelindan && <>Kelindan {trip.kelindan} · </>}
                {groups.filter(g => g.allDelivered).length}/{groups.length} outlets done
              </div>
              <div className="flex gap-2 mt-2">
                <label className="text-xs flex-1">Odometer start
                  <input type="number" inputMode="numeric" defaultValue={trip.odometer_start ?? ''}
                    onBlur={e => { if (e.target.value !== String(trip.odometer_start ?? '')) saveOdometer(trip, 'odometer_start', e.target.value) }}
                    className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" placeholder="km" />
                </label>
                <label className="text-xs flex-1">Odometer end
                  <input type="number" inputMode="numeric" defaultValue={trip.odometer_end ?? ''}
                    onBlur={e => { if (e.target.value !== String(trip.odometer_end ?? '')) saveOdometer(trip, 'odometer_end', e.target.value) }}
                    className="block w-full mt-0.5 rounded border border-gray-300 px-2 py-1 text-sm" placeholder="km" />
                </label>
              </div>
            </header>

            {groups.length === 0
              ? <p className="px-4 py-3 text-sm text-gray-400">No orders on this line today.</p>
              : <div className="divide-y divide-gray-100">
                  {groups.map(g => {
                    const delivered = g.allDelivered
                    const photoOrder = g.orders.find(o => o.delivery_photo_path)
                    const noteText = g.orders.find(o => o.delivery_note)?.delivery_note
                    return (
                      <div key={g.key} className={`p-4 ${delivered ? 'bg-green-50' : ''}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-medium">{g.customer}</div>
                            <div className="text-xs text-gray-400">
                              {g.orders.length > 1 ? `${g.orders.length} orders · ` : ''}{g.orders.map(o => o.so_number).join(', ')}
                            </div>
                          </div>
                          {delivered
                            ? <span className="shrink-0 rounded bg-green-600 px-2 py-0.5 text-xs text-white">✓ {fmtTime(g.firstDeliveredAt)}</span>
                            : <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">Pending</span>}
                        </div>

                        {delivered && (
                          <div className="mt-2 text-sm text-gray-600 flex flex-wrap items-center gap-x-4 gap-y-1">
                            {photoOrder?.delivery_photo_path && <button onClick={() => viewPhoto(photoOrder.delivery_photo_path!)} className="text-blue-600 underline">View photo</button>}
                            {noteText && <span className="text-gray-500">“{noteText}”</span>}
                            <button onClick={() => undoDeliver(g)} className="text-xs text-gray-400 underline">Undo</button>
                          </div>
                        )}

                        {!delivered && openKey !== g.key && (
                          <button onClick={() => { setOpenKey(g.key); setPhoto(null); setNote('') }}
                            className="mt-3 w-full rounded-md bg-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                            Mark delivered{g.orders.length > 1 ? ` (${g.orders.length} orders)` : ''}
                          </button>
                        )}

                        {!delivered && openKey === g.key && (
                          <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
                            <label className="block text-sm">Proof photo
                              <input type="file" accept="image/*" capture="environment"
                                onChange={e => setPhoto(e.target.files?.[0] || null)} className="block w-full mt-1 text-sm" />
                            </label>
                            <label className="block text-sm">Note (optional)
                              <input type="text" value={note} onChange={e => setNote(e.target.value)}
                                className="block w-full mt-1 rounded border border-gray-300 px-3 py-2 text-base" placeholder="Left with security, etc." />
                            </label>
                            <div className="flex gap-2">
                              <button onClick={() => confirmDeliver(g)} disabled={saving}
                                className="flex-1 rounded-md bg-green-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50">
                                {saving ? 'Saving…' : 'Confirm delivered'}
                              </button>
                              <button onClick={() => setOpenKey(null)} disabled={saving}
                                className="rounded-md border border-gray-300 px-3 py-2.5 text-sm">Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>}
          </section>
          )
        })}
      </div>
    </main>
  )
}
