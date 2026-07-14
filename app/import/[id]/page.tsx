'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'
import ItemPicker from '@/components/ItemPicker'
import { apiFetch } from '@/lib/api'
import {
  IMPORT_STATUSES, STATUS_STYLE, DOC_TYPE_LABEL, fmtDate, n3,
  type ImportShipment, type ImportSupplier, type ImportBL, type ImportContainer,
  type ImportItem, type ContainerCharge, type ImportDocument, type Extracted, type ExtractedItem,
} from '@/lib/import'

type MasterItem = { code: string; description: string; unit: string; id?: string }

export default function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const reviewParam = useSearchParams().get('review') || undefined
  const { profile, loading, error: profileError } = useProfile()
  const canEdit = can(profile, 'import', 'edit')
  const canDelete = can(profile, 'import', 'delete')

  const [shipment, setShipment] = useState<ImportShipment | null>(null)
  const [suppliers, setSuppliers] = useState<ImportSupplier[]>([])
  const [bls, setBls] = useState<ImportBL[]>([])
  const [containers, setContainers] = useState<ImportContainer[]>([])
  const [items, setItems] = useState<ImportItem[]>([])
  const [charges, setCharges] = useState<ContainerCharge[]>([])
  const [master, setMaster] = useState<MasterItem[]>([])
  const [documents, setDocuments] = useState<ImportDocument[]>([])
  const [notFound, setNotFound] = useState(false)

  useEffect(() => { if (profile && id) load() }, [profile, id])
  async function load() {
    const { data: ship } = await supabase.from('import_shipments').select('*').eq('id', id).maybeSingle()
    if (!ship) { setNotFound(true); return }
    setShipment(ship as ImportShipment)
    const [sup, bl, con, it, chg, mst, docs] = await Promise.all([
      fetchAll<ImportSupplier>('import_suppliers', '*', 'name'),
      fetchAll<ImportBL>('import_bills_of_lading', '*', q => q.eq('shipment_id', id).order('created_at')),
      fetchAll<ImportContainer>('import_containers', '*', q => q.eq('shipment_id', id).order('created_at')),
      fetchAll<ImportItem>('import_shipment_items', '*', q => q.eq('shipment_id', id).order('created_at')),
      fetchAll<ContainerCharge>('import_container_charges', '*', q => q.eq('shipment_id', id)),
      fetchAll<MasterItem>('items', 'id, code, description, unit', 'code'),
      fetchAll<ImportDocument>('import_documents', '*', q => q.eq('shipment_id', id).order('created_at', { ascending: false })),
    ])
    setSuppliers(sup); setBls(bl); setContainers(con); setItems(it); setCharges(chg); setMaster(mst); setDocuments(docs)
  }
  // Reload just the container-charge view (after a container date/free-day edit).
  async function reloadCharges() {
    setCharges(await fetchAll<ContainerCharge>('import_container_charges', '*', q => q.eq('shipment_id', id)))
  }

  const chargeOf = useMemo(() => {
    const m: Record<string, ContainerCharge> = {}
    charges.forEach(c => { m[c.container_id] = c })
    return m
  }, [charges])

  if (loading && !profileError) return <div className="p-8 text-sm text-gray-500">Loading…</div>
  if (profileError) return <div className="p-8 text-sm text-red-600">{profileError}</div>
  if (notFound) return <div className="p-8 text-sm text-gray-500">Shipment not found. <button onClick={() => router.push('/import')} className="text-emerald-600 hover:underline">Back to list</button></div>
  if (!profile || !shipment) return null

  const totalDeclared = items.reduce((s, i) => s + Number(i.declared_weight || 0), 0)
  const totalDemurrage = charges.reduce((s, c) => s + c.demurrage_days, 0)
  const totalDetention = charges.reduce((s, c) => s + c.detention_days, 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <button onClick={() => router.push('/import')} className="text-emerald-600 hover:underline text-sm mb-3">← All shipments</button>

        {/* Summary strip */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-4">
          <h1 className="text-2xl font-bold">{shipment.reference}</h1>
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[shipment.status] || 'bg-gray-100 text-gray-700'}`}>{shipment.status}</span>
          <span className="text-sm text-gray-500">{containers.length} container(s) · {items.length} item(s) · {n3(totalDeclared)} kg declared</span>
          {(totalDemurrage > 0 || totalDetention > 0) && (
            <span className="text-sm font-semibold text-red-600">⚠ {totalDemurrage}d demurrage · {totalDetention}d detention</span>
          )}
        </div>

        <Header shipment={shipment} suppliers={suppliers} canEdit={canEdit} canDelete={canDelete} onSaved={load}
          onDeleted={() => router.push('/import')} />

        <Items shipmentId={shipment.id} items={items} containers={containers} master={master} canEdit={canEdit} reload={load} />

        <BillsOfLading shipmentId={shipment.id} bls={bls} canEdit={canEdit} reload={load} />

        <Containers shipmentId={shipment.id} containers={containers} bls={bls} charges={chargeOf} canEdit={canEdit}
          reload={load} reloadCharges={reloadCharges} />

        <Documents shipment={shipment} documents={documents} suppliers={suppliers} master={master}
          profileId={profile.id} profileName={profile.full_name} canEdit={canEdit} reload={load} autoReview={reviewParam} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header (order-level fields)
// ---------------------------------------------------------------------------
function Header({ shipment, suppliers, canEdit, canDelete, onSaved, onDeleted }: {
  shipment: ImportShipment; suppliers: ImportSupplier[]; canEdit: boolean; canDelete: boolean
  onSaved: () => void; onDeleted: () => void
}) {
  const [f, setF] = useState({
    reference: shipment.reference, supplier_id: shipment.supplier_id || '', status: shipment.status,
    order_date: shipment.order_date || '', received_date: shipment.received_date || '',
    destination_factory_code: shipment.destination_factory_code || '', notes: shipment.notes || '',
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  async function save() {
    if (!f.reference.trim()) { setMsg('Reference is required.'); return }
    setSaving(true); setMsg('')
    const { error } = await supabase.from('import_shipments').update({
      reference: f.reference.trim(), supplier_id: f.supplier_id || null, status: f.status,
      order_date: f.order_date || null, received_date: f.received_date || null,
      destination_factory_code: f.destination_factory_code.trim() || null, notes: f.notes.trim() || null,
    }).eq('id', shipment.id)
    setSaving(false)
    if (error) { setMsg(error.message); return }
    setMsg('Saved.'); onSaved()
  }
  async function del() {
    if (!confirm(`Delete shipment "${shipment.reference}" and everything on it (items, BLs, containers)? This cannot be undone.`)) return
    const { error } = await supabase.from('import_shipments').delete().eq('id', shipment.id)
    if (error) { alert(error.message); return }
    onDeleted()
  }

  const label = 'text-xs font-medium text-gray-600'
  const inp = 'mt-1 w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500'
  return (
    <section className="bg-white rounded-xl shadow-sm border p-5 mb-5">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <label className="block"><span className={label}>Reference</span>
          <input disabled={!canEdit} value={f.reference} onChange={e => setF(v => ({ ...v, reference: e.target.value }))} className={inp} /></label>
        <label className="block"><span className={label}>Supplier</span>
          <select disabled={!canEdit} value={f.supplier_id} onChange={e => setF(v => ({ ...v, supplier_id: e.target.value }))} className={inp}>
            <option value="">—</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}{!s.active ? ' (inactive)' : ''}</option>)}
          </select></label>
        <label className="block"><span className={label}>Status</span>
          <select disabled={!canEdit} value={f.status} onChange={e => setF(v => ({ ...v, status: e.target.value }))} className={inp}>
            {IMPORT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select></label>
        <label className="block"><span className={label}>Order date</span>
          <input type="date" disabled={!canEdit} value={f.order_date} onChange={e => setF(v => ({ ...v, order_date: e.target.value }))} className={inp} /></label>
        <label className="block"><span className={label}>Received date</span>
          <input type="date" disabled={!canEdit} value={f.received_date} onChange={e => setF(v => ({ ...v, received_date: e.target.value }))} className={inp} /></label>
        <label className="block"><span className={label}>Destination factory (optional)</span>
          <input disabled={!canEdit} value={f.destination_factory_code} onChange={e => setF(v => ({ ...v, destination_factory_code: e.target.value }))} placeholder="e.g. AVINA01" className={inp} /></label>
        <label className="block sm:col-span-2 lg:col-span-3"><span className={label}>Notes</span>
          <textarea disabled={!canEdit} value={f.notes} onChange={e => setF(v => ({ ...v, notes: e.target.value }))} rows={2} className={inp} /></label>
      </div>
      {canEdit && (
        <div className="flex items-center gap-3 mt-4">
          <button onClick={save} disabled={saving} className="bg-emerald-600 text-white px-5 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : 'Save details'}</button>
          {msg && <span className={`text-sm ${msg === 'Saved.' ? 'text-green-600' : 'text-red-500'}`}>{msg}</span>}
          {canDelete && <button onClick={del} className="ml-auto text-red-500 hover:underline text-sm">Delete shipment</button>}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Items (from the Items Master)
// ---------------------------------------------------------------------------
function Items({ shipmentId, items, containers, master, canEdit, reload }: {
  shipmentId: string; items: ImportItem[]; containers: ImportContainer[]; master: MasterItem[]
  canEdit: boolean; reload: () => void
}) {
  const [pick, setPick] = useState<MasterItem | null>(null)
  const [qty, setQty] = useState('')
  const [weight, setWeight] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function add() {
    if (!pick) { setErr('Pick an item first.'); return }
    const q = Number(qty)
    if (!(q > 0)) { setErr('Enter a quantity.'); return }
    setBusy(true); setErr('')
    const { error } = await supabase.from('import_shipment_items').insert({
      shipment_id: shipmentId, item_id: pick.id || null, item_code: pick.code,
      description: pick.description, unit: pick.unit, quantity: q,
      declared_weight: weight === '' ? null : Number(weight),
    })
    setBusy(false)
    if (error) { setErr(error.message); return }
    setPick(null); setQty(''); setWeight(''); reload()
  }
  // Save an inline field edit (qty / weight / container) for an existing row.
  async function patch(row: ImportItem, changes: Partial<ImportItem>) {
    await supabase.from('import_shipment_items').update(changes).eq('id', row.id)
    reload()
  }
  async function remove(row: ImportItem) {
    if (!confirm(`Remove ${row.item_code} from this shipment?`)) return
    await supabase.from('import_shipment_items').delete().eq('id', row.id)
    reload()
  }

  const containerLabel = (c: ImportContainer) => c.container_no || 'Container'
  return (
    <section className="bg-white rounded-xl shadow-sm border p-5 mb-5">
      <h2 className="font-semibold mb-3">Items <span className="text-gray-400 font-normal text-sm">({items.length})</span></h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>{['Code', 'Description', 'Qty', 'Unit', 'Declared wt (kg)', 'Container', ''].map(h => <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-gray-400">No items yet.</td></tr>}
            {items.map(row => (
              <tr key={row.id} className="border-b last:border-0">
                <td className="px-3 py-1.5 font-mono font-medium whitespace-nowrap">{row.item_code}</td>
                <td className="px-3 py-1.5 text-gray-600">{row.description}</td>
                <td className="px-3 py-1.5">
                  {canEdit
                    ? <input type="number" step="any" defaultValue={row.quantity} onBlur={e => { const v = Number(e.target.value); if (v !== Number(row.quantity)) patch(row, { quantity: v }) }} className="border rounded px-2 py-1 text-sm w-24 text-right" />
                    : <span className="block text-right">{n3(row.quantity)}</span>}
                </td>
                <td className="px-3 py-1.5 text-gray-500">{row.unit || '—'}</td>
                <td className="px-3 py-1.5">
                  {canEdit
                    ? <input type="number" step="any" defaultValue={row.declared_weight ?? ''} onBlur={e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== row.declared_weight) patch(row, { declared_weight: v }) }} className="border rounded px-2 py-1 text-sm w-28 text-right" />
                    : <span className="block text-right">{row.declared_weight != null ? n3(row.declared_weight) : '—'}</span>}
                </td>
                <td className="px-3 py-1.5">
                  {canEdit
                    ? <select defaultValue={row.container_id || ''} onChange={e => patch(row, { container_id: e.target.value || null })} className="border rounded px-2 py-1 text-sm">
                        <option value="">—</option>
                        {containers.map(c => <option key={c.id} value={c.id}>{containerLabel(c)}</option>)}
                      </select>
                    : <span>{containers.find(c => c.id === row.container_id)?.container_no || '—'}</span>}
                </td>
                <td className="px-3 py-1.5 text-right">{canEdit && <button onClick={() => remove(row)} className="text-red-500 hover:underline text-xs">remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="mt-4 border-t pt-4">
          {err && <p className="text-red-500 text-sm mb-2">{err}</p>}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 flex-1 min-w-[16rem]"><span className="text-xs font-medium text-gray-600">Add item from master</span>
              <ItemPicker items={master} value={pick ? `${pick.code} — ${pick.description}` : ''} onPick={it => setPick(it as MasterItem)} /></div>
            <div className="flex flex-col gap-1 w-24"><span className="text-xs font-medium text-gray-600">Qty{pick ? ` (${pick.unit})` : ''}</span>
              <input type="number" step="any" value={qty} onChange={e => setQty(e.target.value)} className="border rounded-lg px-3 py-2 text-sm text-right" /></div>
            <div className="flex flex-col gap-1 w-32"><span className="text-xs font-medium text-gray-600">Declared wt (kg)</span>
              <input type="number" step="any" value={weight} onChange={e => setWeight(e.target.value)} className="border rounded-lg px-3 py-2 text-sm text-right" /></div>
            <button onClick={add} disabled={busy} className="border border-emerald-600 text-emerald-600 px-4 py-2 rounded-lg hover:bg-emerald-50 disabled:opacity-50 text-sm font-medium">+ Add item</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Bills of Lading
// ---------------------------------------------------------------------------
function BillsOfLading({ shipmentId, bls, canEdit, reload }: {
  shipmentId: string; bls: ImportBL[]; canEdit: boolean; reload: () => void
}) {
  const [busy, setBusy] = useState(false)
  async function add() {
    setBusy(true)
    await supabase.from('import_bills_of_lading').insert({ shipment_id: shipmentId })
    setBusy(false); reload()
  }
  return (
    <section className="bg-white rounded-xl shadow-sm border p-5 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Bills of Lading <span className="text-gray-400 font-normal text-sm">({bls.length})</span></h2>
        {canEdit && <button onClick={add} disabled={busy} className="border border-emerald-600 text-emerald-600 px-3 py-1.5 rounded-lg hover:bg-emerald-50 disabled:opacity-50 text-sm font-medium">+ Add BL</button>}
      </div>
      {bls.length === 0 && <p className="text-gray-400 text-sm">No Bills of Lading yet.</p>}
      <div className="space-y-4">
        {bls.map(bl => <BLCard key={bl.id} bl={bl} canEdit={canEdit} reload={reload} />)}
      </div>
    </section>
  )
}

function BLCard({ bl, canEdit, reload }: { bl: ImportBL; canEdit: boolean; reload: () => void }) {
  const [f, setF] = useState({
    bl_number: bl.bl_number || '', shipping_line: bl.shipping_line || '', vessel: bl.vessel || '',
    port_of_loading: bl.port_of_loading || '', port_of_discharge: bl.port_of_discharge || '',
    shipped_date: bl.shipped_date || '', eta: bl.eta || '', arrival_date: bl.arrival_date || '',
    customs_cleared_date: bl.customs_cleared_date || '',
    demurrage_free_days: bl.demurrage_free_days?.toString() ?? '', detention_free_days: bl.detention_free_days?.toString() ?? '',
    notes: bl.notes || '',
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  async function save() {
    setSaving(true); setMsg('')
    const { error } = await supabase.from('import_bills_of_lading').update({
      bl_number: f.bl_number.trim() || null, shipping_line: f.shipping_line.trim() || null, vessel: f.vessel.trim() || null,
      port_of_loading: f.port_of_loading.trim() || null, port_of_discharge: f.port_of_discharge.trim() || null,
      shipped_date: f.shipped_date || null, eta: f.eta || null, arrival_date: f.arrival_date || null,
      customs_cleared_date: f.customs_cleared_date || null,
      demurrage_free_days: f.demurrage_free_days === '' ? null : Number(f.demurrage_free_days),
      detention_free_days: f.detention_free_days === '' ? null : Number(f.detention_free_days),
      notes: f.notes.trim() || null,
    }).eq('id', bl.id)
    setSaving(false)
    setMsg(error ? error.message : 'Saved.')
    if (!error) reload()
  }
  async function remove() {
    if (!confirm('Remove this Bill of Lading?')) return
    await supabase.from('import_bills_of_lading').delete().eq('id', bl.id)
    reload()
  }
  const label = 'text-xs font-medium text-gray-600'
  const inp = 'mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm disabled:bg-gray-50 disabled:text-gray-500'
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF(v => ({ ...v, [k]: e.target.value }))
  return (
    <div className="border rounded-xl p-4 bg-gray-50/40">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="block"><span className={label}>BL number</span><input disabled={!canEdit} value={f.bl_number} onChange={set('bl_number')} className={inp} /></label>
        <label className="block"><span className={label}>Shipping line</span><input disabled={!canEdit} value={f.shipping_line} onChange={set('shipping_line')} className={inp} /></label>
        <label className="block"><span className={label}>Vessel</span><input disabled={!canEdit} value={f.vessel} onChange={set('vessel')} className={inp} /></label>
        <label className="block"><span className={label}>Port of loading</span><input disabled={!canEdit} value={f.port_of_loading} onChange={set('port_of_loading')} className={inp} /></label>
        <label className="block"><span className={label}>Port of discharge</span><input disabled={!canEdit} value={f.port_of_discharge} onChange={set('port_of_discharge')} className={inp} /></label>
        <label className="block"><span className={label}>Shipped date</span><input type="date" disabled={!canEdit} value={f.shipped_date} onChange={set('shipped_date')} className={inp} /></label>
        <label className="block"><span className={label}>ETA</span><input type="date" disabled={!canEdit} value={f.eta} onChange={set('eta')} className={inp} /></label>
        <label className="block"><span className={label}>Arrival date</span><input type="date" disabled={!canEdit} value={f.arrival_date} onChange={set('arrival_date')} className={inp} /></label>
        <label className="block"><span className={label}>Customs cleared</span><input type="date" disabled={!canEdit} value={f.customs_cleared_date} onChange={set('customs_cleared_date')} className={inp} /></label>
        <label className="block"><span className={label}>Demurrage free days</span><input type="number" disabled={!canEdit} value={f.demurrage_free_days} onChange={set('demurrage_free_days')} className={inp} /></label>
        <label className="block"><span className={label}>Detention free days</span><input type="number" disabled={!canEdit} value={f.detention_free_days} onChange={set('detention_free_days')} className={inp} /></label>
        <label className="block lg:col-span-4"><span className={label}>Notes</span><input disabled={!canEdit} value={f.notes} onChange={set('notes')} className={inp} /></label>
      </div>
      {canEdit && (
        <div className="flex items-center gap-3 mt-3">
          <button onClick={save} disabled={saving} className="bg-emerald-600 text-white px-4 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : 'Save BL'}</button>
          {msg && <span className={`text-sm ${msg === 'Saved.' ? 'text-green-600' : 'text-red-500'}`}>{msg}</span>}
          <button onClick={remove} className="ml-auto text-red-500 hover:underline text-xs">Remove</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Containers (carry the demurrage/detention dates + show the live day counts)
// ---------------------------------------------------------------------------
function Containers({ shipmentId, containers, bls, charges, canEdit, reload, reloadCharges }: {
  shipmentId: string; containers: ImportContainer[]; bls: ImportBL[]
  charges: Record<string, ContainerCharge>; canEdit: boolean; reload: () => void; reloadCharges: () => void
}) {
  const [busy, setBusy] = useState(false)
  async function add() {
    setBusy(true)
    await supabase.from('import_containers').insert({ shipment_id: shipmentId })
    setBusy(false); reload()
  }
  return (
    <section className="bg-white rounded-xl shadow-sm border p-5 mb-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold">Containers <span className="text-gray-400 font-normal text-sm">({containers.length})</span></h2>
        {canEdit && <button onClick={add} disabled={busy} className="border border-emerald-600 text-emerald-600 px-3 py-1.5 rounded-lg hover:bg-emerald-50 disabled:opacity-50 text-sm font-medium">+ Add container</button>}
      </div>
      <p className="text-xs text-gray-400 mb-3">Demurrage counts from <b>available at port</b> → <b>gate-out</b>; detention from <b>gate-out</b> → <b>empty returned</b>. Free days fall back from the BL. Both count up to today while still running.</p>
      {containers.length === 0 && <p className="text-gray-400 text-sm">No containers yet.</p>}
      <div className="space-y-4">
        {containers.map(c => <ContainerCard key={c.id} c={c} bls={bls} charge={charges[c.id]} canEdit={canEdit} reload={reload} reloadCharges={reloadCharges} />)}
      </div>
    </section>
  )
}

function ContainerCard({ c, bls, charge, canEdit, reload, reloadCharges }: {
  c: ImportContainer; bls: ImportBL[]; charge?: ContainerCharge; canEdit: boolean
  reload: () => void; reloadCharges: () => void
}) {
  const [f, setF] = useState({
    container_no: c.container_no || '', container_type: c.container_type || '', bl_id: c.bl_id || '',
    available_date: c.available_date || '', gate_out_date: c.gate_out_date || '', empty_returned_date: c.empty_returned_date || '',
    demurrage_free_days: c.demurrage_free_days?.toString() ?? '', detention_free_days: c.detention_free_days?.toString() ?? '',
    notes: c.notes || '',
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  async function save() {
    setSaving(true); setMsg('')
    const { error } = await supabase.from('import_containers').update({
      container_no: f.container_no.trim() || null, container_type: f.container_type.trim() || null, bl_id: f.bl_id || null,
      available_date: f.available_date || null, gate_out_date: f.gate_out_date || null, empty_returned_date: f.empty_returned_date || null,
      demurrage_free_days: f.demurrage_free_days === '' ? null : Number(f.demurrage_free_days),
      detention_free_days: f.detention_free_days === '' ? null : Number(f.detention_free_days),
      notes: f.notes.trim() || null,
    }).eq('id', c.id)
    setSaving(false)
    if (error) { setMsg(error.message); return }
    setMsg('Saved.'); reload(); reloadCharges()
  }
  async function remove() {
    if (!confirm('Remove this container?')) return
    await supabase.from('import_containers').delete().eq('id', c.id)
    reload()
  }
  const blLabel = (b: ImportBL) => b.bl_number || `BL (${b.shipping_line || 'unnamed'})`
  const label = 'text-xs font-medium text-gray-600'
  const inp = 'mt-1 w-full border rounded-lg px-2.5 py-1.5 text-sm disabled:bg-gray-50 disabled:text-gray-500'
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF(v => ({ ...v, [k]: e.target.value }))
  const dem = charge?.demurrage_days ?? 0
  const det = charge?.detention_days ?? 0
  return (
    <div className="border rounded-xl p-4 bg-gray-50/40">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="block"><span className={label}>Container no.</span><input disabled={!canEdit} value={f.container_no} onChange={set('container_no')} className={inp} /></label>
        <label className="block"><span className={label}>Type</span><input disabled={!canEdit} value={f.container_type} onChange={set('container_type')} placeholder="20GP / 40HC" className={inp} /></label>
        <label className="block lg:col-span-2"><span className={label}>Bill of Lading</span>
          <select disabled={!canEdit} value={f.bl_id} onChange={set('bl_id')} className={inp}>
            <option value="">—</option>
            {bls.map(b => <option key={b.id} value={b.id}>{blLabel(b)}</option>)}
          </select></label>
        <label className="block"><span className={label}>Available at port</span><input type="date" disabled={!canEdit} value={f.available_date} onChange={set('available_date')} className={inp} /></label>
        <label className="block"><span className={label}>Gate-out (picked up)</span><input type="date" disabled={!canEdit} value={f.gate_out_date} onChange={set('gate_out_date')} className={inp} /></label>
        <label className="block"><span className={label}>Empty returned</span><input type="date" disabled={!canEdit} value={f.empty_returned_date} onChange={set('empty_returned_date')} className={inp} /></label>
        <div /> {/* spacer */}
        <label className="block"><span className={label}>Demurrage free days (override)</span><input type="number" disabled={!canEdit} value={f.demurrage_free_days} onChange={set('demurrage_free_days')} placeholder="uses BL" className={inp} /></label>
        <label className="block"><span className={label}>Detention free days (override)</span><input type="number" disabled={!canEdit} value={f.detention_free_days} onChange={set('detention_free_days')} placeholder="uses BL" className={inp} /></label>
        <label className="block lg:col-span-2"><span className={label}>Notes</span><input disabled={!canEdit} value={f.notes} onChange={set('notes')} className={inp} /></label>
      </div>

      {/* Live charge readout from the DB view */}
      <div className="flex flex-wrap gap-2 mt-3">
        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${dem > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
          Demurrage: {dem} day{dem === 1 ? '' : 's'}{charge ? ` · free ${charge.demurrage_free_days}` : ''}
        </span>
        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${det > 0 ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
          Detention: {det} day{det === 1 ? '' : 's'}{charge ? ` · free ${charge.detention_free_days}` : ''}
        </span>
        <span className="px-2.5 py-1 text-xs text-gray-400">
          {f.available_date ? `available ${fmtDate(f.available_date)}` : ''}{f.gate_out_date ? ` → out ${fmtDate(f.gate_out_date)}` : ''}{f.empty_returned_date ? ` → returned ${fmtDate(f.empty_returned_date)}` : ''}
        </span>
      </div>

      {canEdit && (
        <div className="flex items-center gap-3 mt-3">
          <button onClick={save} disabled={saving} className="bg-emerald-600 text-white px-4 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-medium">{saving ? 'Saving…' : 'Save container'}</button>
          {msg && <span className={`text-sm ${msg === 'Saved.' ? 'text-green-600' : 'text-red-500'}`}>{msg}</span>}
          <button onClick={remove} className="ml-auto text-red-500 hover:underline text-xs">Remove</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Documents — upload a PDF (sales order / invoice / BL), read it with Claude,
// review what it found, and apply it to the shipment. Fully optional.
// ---------------------------------------------------------------------------
const DOC_STATUS_STYLE: Record<string, string> = {
  Uploaded: 'bg-gray-100 text-gray-600', Processing: 'bg-emerald-100 text-emerald-700',
  Review: 'bg-amber-100 text-amber-700', Applied: 'bg-green-100 text-green-700', Error: 'bg-red-100 text-red-700',
}

function Documents({ shipment, documents, suppliers, master, profileId, profileName, canEdit, reload, autoReview }: {
  shipment: ImportShipment; documents: ImportDocument[]; suppliers: ImportSupplier[]; master: MasterItem[]
  profileId: string; profileName: string; canEdit: boolean; reload: () => void; autoReview?: string
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [reviewing, setReviewing] = useState<string | null>(autoReview || null)

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf') { setMsg('Please choose a PDF.'); return }
    setBusy(true); setMsg('Uploading…')
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${shipment.id}/${Date.now()}-${safe}`
    const { error: upErr } = await supabase.storage.from('import-docs').upload(path, file)
    if (upErr) { setBusy(false); setMsg(`Upload failed: ${upErr.message}`); return }
    const { data: doc, error: insErr } = await supabase.from('import_documents').insert({
      shipment_id: shipment.id, file_name: file.name, file_path: path, status: 'Processing',
      uploaded_by: profileId, uploaded_by_name: profileName || null,
    }).select('id').single()
    if (insErr || !doc) { setBusy(false); setMsg(`Saving failed: ${insErr?.message}`); return }
    setMsg('Reading the document with Claude…')
    try {
      const res = await apiFetch('/api/extract-import-document', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id, filePath: path }),
      })
      const result = await res.json()
      setBusy(false)
      if (!res.ok) { setMsg(`Reading failed: ${result.error || 'Unknown error'}`); reload(); return }
      setMsg('Read successfully — review below.'); setReviewing(doc.id); reload()
    } catch {
      setBusy(false); setMsg('Could not reach the reading service.'); reload()
    }
  }

  async function reExtract(doc: ImportDocument) {
    setMsg(`Re-reading "${doc.file_name}"…`)
    await supabase.from('import_documents').update({ status: 'Processing' }).eq('id', doc.id)
    reload()
    try {
      const res = await apiFetch('/api/extract-import-document', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: doc.id, filePath: doc.file_path }),
      })
      const result = await res.json()
      if (!res.ok) setMsg(`Reading failed: ${result.error || 'Unknown error'}`)
      else { setMsg('Read successfully — review below.'); setReviewing(doc.id) }
    } catch { setMsg('Could not reach the reading service.') }
    reload()
  }

  async function view(doc: ImportDocument) {
    const { data } = await supabase.storage.from('import-docs').createSignedUrl(doc.file_path, 120)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank')
  }
  async function remove(doc: ImportDocument) {
    if (!confirm(`Delete "${doc.file_name}"? (The shipment data it created stays.)`)) return
    await supabase.storage.from('import-docs').remove([doc.file_path])
    await supabase.from('import_documents').delete().eq('id', doc.id)
    reload()
  }

  return (
    <section className="bg-white rounded-xl shadow-sm border p-5 mb-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h2 className="font-semibold">Documents <span className="text-gray-400 font-normal text-sm">({documents.length})</span></h2>
        {canEdit && (
          <label className={`text-sm font-medium px-4 py-2 rounded-lg cursor-pointer ${busy ? 'bg-gray-200 text-gray-400' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}>
            {busy ? 'Working…' : '⬆ Upload & auto-fill'}
            <input type="file" accept="application/pdf" onChange={onFile} disabled={busy} className="hidden" />
          </label>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-3">Upload a supplier sales order, invoice, or Bill of Lading (PDF). Claude reads it and suggests the supplier, reference, containers and items for you to review — English documents are matched to your Malay item master automatically. Optional; you can always enter things by hand.</p>
      {msg && <p className="text-sm mb-3 text-gray-600">{msg}</p>}

      {documents.length === 0 && <p className="text-gray-400 text-sm">No documents uploaded.</p>}
      <div className="space-y-2">
        {documents.map(doc => (
          <div key={doc.id} className="border rounded-lg">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${DOC_STATUS_STYLE[doc.status] || 'bg-gray-100'}`}>{doc.status}</span>
              <span className="text-sm font-medium">{doc.file_name || 'document.pdf'}</span>
              <span className="text-xs text-gray-400">{DOC_TYPE_LABEL[doc.doc_type] || 'Document'}{doc.uploaded_by_name ? ` · ${doc.uploaded_by_name}` : ''} · {new Date(doc.created_at).toLocaleDateString()}</span>
              <div className="ml-auto flex items-center gap-3 text-xs">
                <button onClick={() => view(doc)} className="text-emerald-600 hover:underline">View</button>
                {canEdit && doc.status === 'Review' && <button onClick={() => setReviewing(reviewing === doc.id ? null : doc.id)} className="text-amber-700 font-medium hover:underline">{reviewing === doc.id ? 'Hide' : 'Review & apply'}</button>}
                {canEdit && (doc.status === 'Error' || doc.status === 'Processing') && <button onClick={() => reExtract(doc)} className="text-emerald-600 hover:underline">Re-read</button>}
                {canEdit && <button onClick={() => remove(doc)} className="text-red-500 hover:underline">Delete</button>}
              </div>
            </div>
            {doc.status === 'Error' && doc.error_message && <p className="px-3 pb-2 text-xs text-red-500">{doc.error_message}</p>}
            {canEdit && reviewing === doc.id && doc.status === 'Review' && doc.extracted && (
              <DocumentReview doc={doc} extracted={doc.extracted} shipment={shipment} suppliers={suppliers} master={master}
                profileId={profileId} onDone={() => { setReviewing(null); reload() }} />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// Only pass through a real ISO date (yyyy-mm-dd); anything else → null (the model
// is asked for ISO, but a date column would reject a stray format).
const isoOrNull = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null)

function DocumentReview({ doc, extracted, shipment, suppliers, master, profileId, onDone }: {
  doc: ImportDocument; extracted: Extracted; shipment: ImportShipment; suppliers: ImportSupplier[]
  master: MasterItem[]; profileId: string; onDone: () => void
}) {
  // Supplier: matched to an existing one, or a new name to create.
  const matched = useMemo(() => {
    const byMatch = extracted.supplier_match && suppliers.find(s => s.name.toLowerCase() === extracted.supplier_match!.toLowerCase())
    const byName = extracted.supplier_name && suppliers.find(s => s.name.toLowerCase() === extracted.supplier_name!.toLowerCase())
    return byMatch || byName || null
  }, [extracted, suppliers])
  const [applySupplier, setApplySupplier] = useState(!!(matched || extracted.supplier_name) && !shipment.supplier_id)
  const [applyReference, setApplyReference] = useState(!!extracted.reference && !shipment.reference)
  const [applyBL, setApplyBL] = useState(!!(extracted.bl && (extracted.bl.bl_number || extracted.bl.shipping_line)))
  const [conSel, setConSel] = useState<boolean[]>((extracted.containers || []).map(() => true))
  // Item rows: pre-filled with the model's cross-language match; user confirms/fixes.
  const [rows, setRows] = useState(() => (extracted.items || []).map((it: ExtractedItem) => ({
    code: it.matched_item_code && master.some(m => m.code === it.matched_item_code) ? it.matched_item_code : '',
    description_en: it.description_en, quantity: it.quantity ?? 0, declared_weight: it.declared_weight ?? null as number | null,
    confidence: it.match_confidence,
    include: !!(it.matched_item_code && master.some(m => m.code === it.matched_item_code)),
  })))
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')

  const codeToItem = useMemo(() => { const m: Record<string, MasterItem> = {}; master.forEach(i => { m[i.code] = i }); return m }, [master])
  const setRow = (i: number, patch: Partial<typeof rows[number]>) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r))

  async function apply() {
    setApplying(true); setErr('')
    try {
      // 1) Supplier
      if (applySupplier) {
        let supplierId = matched?.id
        if (!supplierId && extracted.supplier_name) {
          const { data, error } = await supabase.from('import_suppliers')
            .insert({ name: extracted.supplier_name, created_by: profileId }).select('id').single()
          if (error && !error.message.includes('import_suppliers_name_key')) throw new Error(error.message)
          if (data) supplierId = data.id
          else { const { data: ex } = await supabase.from('import_suppliers').select('id').ilike('name', extracted.supplier_name).maybeSingle(); supplierId = ex?.id }
        }
        if (supplierId) await supabase.from('import_shipments').update({ supplier_id: supplierId }).eq('id', shipment.id)
      }
      // 2) Reference
      if (applyReference && extracted.reference) {
        await supabase.from('import_shipments').update({ reference: extracted.reference }).eq('id', shipment.id)
      }
      // 3) Bill of Lading
      let newBlId: string | null = null
      if (applyBL && extracted.bl) {
        const b = extracted.bl
        const { data } = await supabase.from('import_bills_of_lading').insert({
          shipment_id: shipment.id, bl_number: b.bl_number || null, shipping_line: b.shipping_line || null,
          vessel: b.vessel || null, port_of_loading: b.port_of_loading || null, port_of_discharge: b.port_of_discharge || null,
          shipped_date: isoOrNull(b.shipped_date), eta: isoOrNull(b.eta), arrival_date: isoOrNull(b.arrival_date),
        }).select('id').single()
        newBlId = data?.id ?? null
      }
      // 4) Containers
      const cons = (extracted.containers || []).filter((_, i) => conSel[i])
      if (cons.length) {
        await supabase.from('import_containers').insert(cons.map(c => ({
          shipment_id: shipment.id, bl_id: newBlId, container_no: c.container_no || null, container_type: c.container_type || null,
        })))
      }
      // 5) Items (only rows the user kept AND matched to a real master code)
      const itemRows = rows.filter(r => r.include && r.code && codeToItem[r.code])
      if (itemRows.length) {
        await supabase.from('import_shipment_items').insert(itemRows.map(r => {
          const m = codeToItem[r.code]
          return { shipment_id: shipment.id, item_id: m.id || null, item_code: m.code, description: m.description, unit: m.unit, quantity: Number(r.quantity) || 0, declared_weight: r.declared_weight }
        }))
      }
      // 6) Mark applied
      await supabase.from('import_documents').update({ status: 'Applied', bl_id: newBlId }).eq('id', doc.id)
      onDone()
    } catch (e) {
      setApplying(false); setErr(e instanceof Error ? e.message : 'Could not apply.')
    }
  }

  const confBadge = (c: string) => c === 'high' ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">match</span>
    : c === 'low' ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">check</span>
    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">pick</span>
  const chk = 'h-4 w-4'

  return (
    <div className="border-t bg-amber-50/40 px-4 py-4 text-sm">
      {err && <p className="text-red-500 mb-2">{err}</p>}
      <p className="text-xs text-gray-500 mb-3">Detected: <b>{DOC_TYPE_LABEL[extracted.doc_type] || 'Document'}</b>. Tick what to apply, fix any item matches, then Apply. Unmatched items are skipped until you pick a code.</p>

      {/* Supplier + reference */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3">
        {(matched || extracted.supplier_name) && (
          <label className="inline-flex items-center gap-2"><input type="checkbox" className={chk} checked={applySupplier} onChange={e => setApplySupplier(e.target.checked)} />
            Supplier: <b>{matched ? matched.name : extracted.supplier_name}</b> {matched ? <span className="text-xs text-green-600">(existing)</span> : <span className="text-xs text-emerald-600">(will be added)</span>}</label>
        )}
        {extracted.reference && (
          <label className="inline-flex items-center gap-2"><input type="checkbox" className={chk} checked={applyReference} onChange={e => setApplyReference(e.target.checked)} />
            Reference: <b>{extracted.reference}</b></label>
        )}
      </div>

      {/* BL */}
      {extracted.bl && (extracted.bl.bl_number || extracted.bl.shipping_line || extracted.bl.vessel) && (
        <label className="inline-flex items-start gap-2 mb-3"><input type="checkbox" className={`${chk} mt-0.5`} checked={applyBL} onChange={e => setApplyBL(e.target.checked)} />
          <span>Add Bill of Lading: <b>{extracted.bl.bl_number || '(no number)'}</b> <span className="text-xs text-gray-500">{[extracted.bl.shipping_line, extracted.bl.vessel, extracted.bl.arrival_date].filter(Boolean).join(' · ')}</span></span></label>
      )}

      {/* Containers */}
      {(extracted.containers || []).length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-600 mb-1">Containers</div>
          <div className="flex flex-wrap gap-3">
            {(extracted.containers || []).map((c, i) => (
              <label key={i} className="inline-flex items-center gap-2"><input type="checkbox" className={chk} checked={conSel[i]} onChange={e => setConSel(s => s.map((v, j) => j === i ? e.target.checked : v))} />
                <span className="font-mono">{c.container_no}</span>{c.container_type && <span className="text-xs text-gray-400">{c.container_type}</span>}</label>
            ))}
          </div>
        </div>
      )}

      {/* Items — built from divs (NOT a table) so the item-search dropdown can
          float over the rows below instead of being trapped in a table cell. */}
      {rows.length > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-gray-600 mb-1">Items (English → your item master)</div>
          <div className="border rounded-lg bg-white">
            <div className="hidden sm:grid grid-cols-[1.75rem_minmax(6rem,1fr)_minmax(9rem,1.6fr)_4.5rem_6rem] gap-2 items-center px-3 py-1.5 bg-gray-50 border-b text-xs font-medium text-gray-600">
              <span>Add</span><span>On document</span><span>Matched item</span><span className="text-right">Qty</span><span className="text-right">Declared wt</span>
            </div>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.75rem_minmax(6rem,1fr)_minmax(9rem,1.6fr)_4.5rem_6rem] gap-2 items-center px-3 py-2 border-b last:border-0">
                <input type="checkbox" className={chk} checked={r.include} onChange={e => setRow(i, { include: e.target.checked })} />
                <span className="text-gray-600 truncate" title={r.description_en}>{r.description_en}</span>
                <div className="flex items-center gap-2 min-w-0">
                  {confBadge(r.confidence)}
                  <div className="flex-1 min-w-0"><ItemPicker items={master} value={r.code ? `${r.code} — ${codeToItem[r.code]?.description || ''}` : ''} onPick={it => setRow(i, { code: it.code, include: true })} placeholder="Pick item…" /></div>
                </div>
                <input type="number" step="any" value={r.quantity} onChange={e => setRow(i, { quantity: Number(e.target.value) })} className="border rounded px-2 py-1 text-sm w-full text-right" />
                <input type="number" step="any" value={r.declared_weight ?? ''} onChange={e => setRow(i, { declared_weight: e.target.value === '' ? null : Number(e.target.value) })} className="border rounded px-2 py-1 text-sm w-full text-right" />
              </div>
            ))}
          </div>
          {rows.some(r => r.include && !r.code) && <p className="text-xs text-amber-600 mt-1">Rows without a matched code are skipped — pick a code to include them.</p>}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={apply} disabled={applying} className="bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm font-medium">{applying ? 'Applying…' : 'Apply to shipment'}</button>
        <button onClick={onDone} className="text-gray-500 hover:underline text-sm">Close</button>
      </div>
    </div>
  )
}
