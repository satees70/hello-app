'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '@/lib/supabase'
import { useProfile } from '@/hooks/useProfile'
import { can } from '@/lib/permissions'

// One physical storage location (bin), mirroring the SQL Accounting location list.
interface Loc {
  id: string
  warehouse_code: string
  category: string
  location_type: string   // 'SL' = pick face, 'XS' = excess/reserve, 'PICK' etc. from the path
  code: string            // e.g. 'A105'
  aisle: string | null    // leading letters, e.g. 'A' / 'AA' / 'ZG'
  sql_location: string | null  // exact SQL Account path, e.g. '8BT/Stock/SL/A105' or '8BT/PICK/ZG203'
  label: string | null
  pick_sequence: number | null
  active: boolean
  pickable?: boolean          // false = return/quarantine bin, never offered for picking
  notes: string | null
}

const WAREHOUSE = '8BT'
const CATEGORY = 'Stock'

const EMPTY = { code: '', location_type: 'SL', label: '', pick_sequence: '', active: true }

// The code minus its trailing number is the aisle used for grouping/sorting
// (A105 → A, ZG203 → ZG, 0BA01 → 0BA). Falls back to the whole code if it's all digits.
const deriveAisle = (code: string) => { const a = code.replace(/\d+$/, ''); return (a || code).toUpperCase() }
// For a NEW manually-added location, build the standard 8BT/Stock/<type>/<code> path.
const buildPath = (type: string, code: string) => `${WAREHOUSE}/${CATEGORY}/${type}/${code}`

const TYPE_LABEL: Record<string, string> = { SL: 'Pick (SL)', XS: 'Excess (XS)' }
const typeLabel = (t: string) => TYPE_LABEL[t] || t
const typeChip = (t: string) =>
  t === 'SL' ? 'bg-emerald-100 text-emerald-700'
  : t === 'XS' ? 'bg-amber-100 text-amber-700'
  : 'bg-sky-100 text-sky-700'

export default function WmsLocationsPage() {
  const { profile, loading } = useProfile()
  const canEdit = !!profile && can(profile, 'warehouse', 'edit')
  const canDelete = !!profile && can(profile, 'warehouse', 'delete')

  const [rows, setRows] = useState<Loc[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // filters
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState('')   // '' = all
  const [aisleFilter, setAisleFilter] = useState('')
  const [activeFilter, setActiveFilter] = useState('active')  // active | inactive | all

  // single add/edit form
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Loc | null>(null)
  const [form, setForm] = useState(EMPTY)

  // paste import
  const [showImport, setShowImport] = useState(false)
  const [pasteText, setPasteText] = useState('')

  useEffect(() => { if (profile) load() }, [profile])

  async function load() {
    const data = await fetchAll<Loc>('wms_locations', '*', 'code')
    setRows(data)
  }

  const aisles = useMemo(() => Array.from(new Set(rows.map(r => r.aisle || '').filter(Boolean))).sort(), [rows])
  const types = useMemo(() => Array.from(new Set(['SL', 'XS', ...rows.map(r => r.location_type)])).filter(Boolean), [rows])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows
      .filter(r => (typeFilter ? r.location_type === typeFilter : true))
      .filter(r => (aisleFilter ? (r.aisle || '') === aisleFilter : true))
      .filter(r => (activeFilter === 'all' ? true : activeFilter === 'active' ? r.active : !r.active))
      .filter(r => !needle || [r.code, r.label, r.sql_location].some(v => (v || '').toLowerCase().includes(needle)))
      .sort((a, b) => (a.aisle || '').localeCompare(b.aisle || '') || a.code.localeCompare(b.code))
  }, [rows, q, typeFilter, aisleFilter, activeFilter])

  const counts = useMemo(() => {
    const sl = rows.filter(r => r.location_type === 'SL').length
    const xs = rows.filter(r => r.location_type === 'XS').length
    return { total: rows.length, sl, xs, other: rows.length - sl - xs, inactive: rows.filter(r => !r.active).length }
  }, [rows])

  function openCreate() { setEditing(null); setForm(EMPTY); setErr(''); setShowForm(true) }
  function openEdit(r: Loc) {
    setEditing(r)
    setForm({ code: r.code, location_type: r.location_type, label: r.label || '', pick_sequence: r.pick_sequence?.toString() || '', active: r.active })
    setErr(''); setShowForm(true)
  }

  async function saveOne(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return
    setBusy(true); setErr('')
    if (editing) {
      // Never rewrite the SQL Account identity (code / sql_location) on edit — just the
      // classification and housekeeping fields.
      const res = await supabase.from('wms_locations').update({
        location_type: form.location_type.trim().toUpperCase() || 'SL',
        label: form.label.trim() || null,
        pick_sequence: form.pick_sequence ? Number(form.pick_sequence) : null,
        active: form.active,
      }).eq('id', editing.id)
      setBusy(false)
      if (res.error) { setErr(res.error.message); return }
    } else {
      const code = form.code.trim().toUpperCase()
      if (!code) { setErr('Location code is required.'); setBusy(false); return }
      const type = form.location_type.trim().toUpperCase() || 'SL'
      const res = await supabase.from('wms_locations').insert({
        warehouse_code: WAREHOUSE, category: CATEGORY, location_type: type, code,
        aisle: deriveAisle(code), sql_location: buildPath(type, code),
        label: form.label.trim() || null,
        pick_sequence: form.pick_sequence ? Number(form.pick_sequence) : null,
        active: form.active,
      })
      setBusy(false)
      if (res.error) { setErr(res.error.message); return }
    }
    setShowForm(false); load()
  }

  async function toggleActive(r: Loc) {
    if (!canEdit) return
    await supabase.from('wms_locations').update({ active: !r.active }).eq('id', r.id)
    load()
  }
  async function togglePickable(r: Loc) {
    if (!canEdit) return
    const { error } = await supabase.from('wms_locations').update({ pickable: r.pickable === false }).eq('id', r.id)
    if (error) { alert(/pickable|column/i.test(error.message) ? 'Run db/2026-07-wms-pickable-stop.sql in Supabase first.' : error.message); return }
    load()
  }

  async function remove(r: Loc) {
    if (!canDelete) return
    if (!confirm(`Delete location ${r.code}? (Prefer "Deactivate" if it was ever used for stock.)`)) return
    const { error } = await supabase.from('wms_locations').delete().eq('id', r.id)
    if (error) { alert(error.message); return }
    load()
  }

  // --- Paste import from SQL Accounting (Location + Description columns) ---
  const parsed = useMemo(() => parsePaste(pasteText), [pasteText])
  const existingPaths = useMemo(() => new Set(rows.map(r => r.sql_location)), [rows])
  const importPreview = useMemo(() => {
    const seen = new Set<string>()
    const byType: Record<string, number> = {}
    let dupInFile = 0, already = 0
    for (const p of parsed) {
      if (seen.has(p.sql_location)) { dupInFile++; continue }
      seen.add(p.sql_location)
      byType[p.location_type] = (byType[p.location_type] || 0) + 1
      if (existingPaths.has(p.sql_location)) already++
    }
    return { rows: seen.size, byType, dupInFile, already, isNew: seen.size - already }
  }, [parsed, existingPaths])

  async function runImport() {
    if (!canEdit) return
    setBusy(true); setErr('')
    const seen = new Set<string>()
    const toUpsert = parsed.filter(p => { if (seen.has(p.sql_location)) return false; seen.add(p.sql_location); return true })
    for (let i = 0; i < toUpsert.length; i += 500) {
      const chunk = toUpsert.slice(i, i + 500)
      const { error } = await supabase.from('wms_locations').upsert(chunk, { onConflict: 'sql_location' })
      if (error) { setErr(error.message); setBusy(false); return }
    }
    setBusy(false); setShowImport(false); setPasteText(''); load()
  }

  if (loading) return <div className="p-8 text-sm text-gray-500">Loading…</div>

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">Warehouse Location Map</h1>
            <p className="text-gray-500 text-sm mt-1">Every storage bin, its type (SL = pick, XS = excess) and its SQL Account path.</p>
          </div>
          {canEdit && (
            <div className="flex gap-2">
              <button onClick={() => { setShowImport(true); setErr('') }}
                className="border border-emerald-600 text-emerald-700 px-4 py-2 rounded-lg hover:bg-emerald-50 text-sm font-medium">
                ⇪ Import from SQL Account
              </button>
              <button onClick={openCreate}
                className="bg-emerald-700 text-white px-4 py-2 rounded-lg hover:bg-emerald-800 text-sm font-medium">
                + Add location
              </button>
            </div>
          )}
        </div>

        {/* stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <Stat label="Total locations" value={counts.total} />
          <Stat label="Pick (SL)" value={counts.sl} accent="text-emerald-700" />
          <Stat label="Excess (XS)" value={counts.xs} accent="text-amber-600" />
          <Stat label="Other types" value={counts.other} accent="text-sky-600" />
        </div>

        {/* filters */}
        <div className="flex flex-wrap gap-2 mb-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search code / label / path…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]" />
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </select>
          <select value={aisleFilter} onChange={e => setAisleFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">All aisles</option>
            {aisles.map(a => <option key={a} value={a}>Aisle {a}</option>)}
          </select>
          <select value={activeFilter} onChange={e => setActiveFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
            <option value="all">All</option>
          </select>
        </div>

        {/* single add/edit form */}
        {showForm && (
          <form onSubmit={saveOne} className="bg-white rounded-xl shadow-sm border p-6 mb-6 space-y-4">
            <h2 className="font-semibold text-lg">{editing ? `Edit ${editing.code}` : 'New location'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Location code</label>
                <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  className="w-full border rounded-lg px-3 py-2 font-mono disabled:bg-gray-100 disabled:text-gray-500" placeholder="A105" required disabled={!!editing} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Type</label>
                <input list="wms-types" value={form.location_type} onChange={e => setForm({ ...form, location_type: e.target.value.toUpperCase() })}
                  className="w-full border rounded-lg px-3 py-2 font-mono" placeholder="SL" />
                <datalist id="wms-types">{types.map(t => <option key={t} value={t} />)}</datalist>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Label <span className="text-gray-400 font-normal">(optional)</span></label>
                <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2" placeholder="e.g. Cold room" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Pick order <span className="text-gray-400 font-normal">(optional)</span></label>
                <input value={form.pick_sequence} onChange={e => setForm({ ...form, pick_sequence: e.target.value.replace(/[^0-9]/g, '') })}
                  className="w-full border rounded-lg px-3 py-2" placeholder="walking sequence" inputMode="numeric" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Active
            </label>
            {editing
              ? <p className="text-xs text-gray-500">SQL Account path: <span className="font-mono">{editing.sql_location}</span> <span className="text-gray-400">(fixed — comes from SQL Account)</span></p>
              : <p className="text-xs text-gray-500">SQL Account path: <span className="font-mono">{buildPath(form.location_type || 'SL', form.code || '…')}</span></p>}
            {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded">{err}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={busy}
                className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </form>
        )}

        {/* table */}
        <div className="bg-white rounded-xl shadow-sm border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {['Code', 'Type', 'Aisle', 'Label', 'SQL Account path', 'Status', 'Actions'].map(h => (
                  <th key={h} className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400">
                  No locations {rows.length ? 'match the filters' : 'yet — use “Import from SQL Account” to load them'}.
                </td></tr>
              )}
              {filtered.map(r => (
                <tr key={r.id} className={`border-b last:border-0 hover:bg-gray-50 ${r.active ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2.5 font-mono font-medium">{r.code}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeChip(r.location_type)}`}>
                      {typeLabel(r.location_type)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{r.aisle}</td>
                  <td className="px-4 py-2.5 text-gray-600">{r.label}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{r.sql_location}</td>
                  <td className="px-4 py-2.5">{r.active ? <span className="text-emerald-700 text-xs">Active</span> : <span className="text-gray-400 text-xs">Inactive</span>}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {canEdit ? (
                      <div className="flex gap-3">
                        <button onClick={() => openEdit(r)} className="text-emerald-700 hover:underline text-xs">Edit</button>
                        <button onClick={() => togglePickable(r)} className={`hover:underline text-xs ${r.pickable === false ? 'text-purple-700 font-medium' : 'text-gray-500'}`} title={r.pickable === false ? 'Not picked for orders (return/quarantine)' : 'Available for picking'}>{r.pickable === false ? '🚫 No-pick' : 'Pickable'}</button>
                        <button onClick={() => toggleActive(r)} className="text-gray-500 hover:underline text-xs">{r.active ? 'Deactivate' : 'Activate'}</button>
                        {canDelete && <button onClick={() => remove(r)} className="text-red-500 hover:underline text-xs">Delete</button>}
                      </div>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-3">Showing {filtered.length} of {counts.total} locations.</p>
      </div>

      {/* import modal */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowImport(false)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold text-lg mb-1">Import locations from SQL Account</h2>
            <p className="text-sm text-gray-500 mb-3">
              In SQL Account, select the <b>Location</b> + <b>Description</b> columns and copy. Paste them below —
              the exact path, type (SL / XS / PICK …) and aisle are read from each description. Header rows and
              blank locations are ignored. Pasting the same location again just updates it (no duplicates).
            </p>
            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={10}
              placeholder={'A105\t8BT/Stock/SL/A105\nA420\t8BT/Stock/XS/A420\nZG203\t8BT/PICK/ZG203'}
              className="w-full border rounded-lg px-3 py-2 font-mono text-xs" />
            {parsed.length > 0 && (
              <div className="mt-3 text-sm bg-gray-50 border rounded-lg p-3">
                <p><b>{importPreview.rows}</b> locations read — {Object.entries(importPreview.byType).map(([t, n], i) =>
                  <span key={t}>{i > 0 ? ', ' : ''}<span className={t === 'SL' ? 'text-emerald-700' : t === 'XS' ? 'text-amber-600' : 'text-sky-600'}>{n} {typeLabel(t)}</span></span>
                )}.</p>
                <p className="text-gray-500 text-xs mt-1">
                  {importPreview.isNew} new · {importPreview.already} already exist (will update)
                  {importPreview.dupInFile > 0 && ` · ${importPreview.dupInFile} duplicate line(s) in the paste (skipped)`}
                </p>
              </div>
            )}
            {err && <p className="text-red-600 text-sm bg-red-50 p-2 rounded mt-3">{err}</p>}
            <div className="flex gap-3 mt-4">
              <button onClick={runImport} disabled={busy || importPreview.rows === 0}
                className="bg-emerald-700 text-white px-6 py-2 rounded-lg hover:bg-emerald-800 disabled:opacity-50 font-medium">
                {busy ? 'Importing…' : `Import ${importPreview.rows} location${importPreview.rows === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setShowImport(false)} className="border px-6 py-2 rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="bg-white rounded-xl border shadow-sm px-4 py-3">
      <div className={`text-2xl font-bold ${accent || 'text-gray-800'}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  )
}

// Parse pasted SQL Account rows. Only lines whose description is a real location PATH
// (contains '/') are imported — header rows, "DEFAULT LOCATION" and summary lines are
// skipped. The EXACT path is kept as sql_location (the SQL Account identity); the type
// is the segment just before the code, so both 8BT/Stock/SL/A105 (→ SL) and
// 8BT/PICK/ZG203 (→ PICK) are handled correctly.
type Parsed = { warehouse_code: string; category: string; location_type: string; code: string; aisle: string; sql_location: string }
function parsePaste(text: string): Parsed[] {
  const out: Parsed[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/\t|\s{2,}|,/).map(t => t.trim()).filter(Boolean)
    const pathTok = tokens.find(t => t.includes('/'))
    if (!pathTok) continue   // no path → header / DEFAULT LOCATION / summary line
    const parts = pathTok.split('/').map(p => p.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const code = parts[parts.length - 1].toUpperCase()
    if (!code) continue
    const type = (parts[parts.length - 2] || 'SL').toUpperCase()
    const warehouse = parts[0] || WAREHOUSE
    const category = parts.length >= 4 ? parts.slice(1, parts.length - 2).join('/') : CATEGORY
    out.push({ warehouse_code: warehouse, category, location_type: type, code, aisle: deriveAisle(code), sql_location: pathTok })
  }
  return out
}
