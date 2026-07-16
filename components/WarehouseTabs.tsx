'use client'
// Two-warehouse split: GCH items (item description starts with "GCH") live in the GCH warehouse,
// everything else in the other warehouse. A shared filter used across the WMS list pages so each
// warehouse can see only its own items (and spot which one hasn't been updated).

export type WhFilter = 'all' | 'gch' | 'other'
export const isGch = (desc?: string | null) => (desc || '').trim().toUpperCase().startsWith('GCH')
// Passes the filter. `descs` may be a single description or a list (e.g. all items on a DO — the
// row shows if ANY of its items match the chosen warehouse).
export const passWh = (f: WhFilter, descs?: string | null | (string | null | undefined)[]) => {
  if (f === 'all') return true
  const arr = Array.isArray(descs) ? descs : [descs]
  const anyGch = arr.some(isGch)
  const anyOther = arr.some(d => !isGch(d))
  return f === 'gch' ? anyGch : anyOther
}

export default function WarehouseTabs({ value, onChange, className = '' }: { value: WhFilter; onChange: (v: WhFilter) => void; className?: string }) {
  // Short labels so the control fits a phone; the title spells out the full name.
  const tabs: { k: WhFilter; label: string; title: string }[] = [
    { k: 'all', label: 'All', title: 'All warehouses' }, { k: 'gch', label: 'GCH', title: 'GCH warehouse' }, { k: 'other', label: 'Other', title: 'Other warehouse' },
  ]
  return (
    <div className={`inline-flex rounded-lg border overflow-hidden text-sm ${className}`}>
      {tabs.map(t => (
        <button key={t.k} type="button" onClick={() => onChange(t.k)} title={t.title}
          className={`px-3 py-1.5 font-medium whitespace-nowrap ${value === t.k ? 'bg-emerald-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{t.label}</button>
      ))}
    </div>
  )
}
