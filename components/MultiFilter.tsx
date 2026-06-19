'use client'
import { useState } from 'react'

// Excel-style column filter: a button that opens a searchable checklist of
// values; tick several to filter (empty selection = All).
export default function MultiFilter({ values, selected, onChange }: {
  values: string[]; selected: Set<string>; onChange: (s: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const shown = values.filter(v => v.toLowerCase().includes(q.toLowerCase()))
  const toggle = (v: string) => { const n = new Set(selected); n.has(v) ? n.delete(v) : n.add(v); onChange(n) }
  const label = selected.size === 0 ? 'All' : `${selected.size} selected`
  return (
    <div className="relative font-normal">
      <button type="button" onClick={() => setOpen(o => !o)} title={selected.size ? [...selected].join(', ') : 'All'}
        className={`w-full border rounded px-2 py-1 text-xs text-left flex items-center justify-between gap-1 ${selected.size ? 'bg-blue-50 border-blue-400 text-blue-700' : 'bg-white'}`}>
        <span className="truncate">{label}</span><span className="text-gray-400 shrink-0">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-[22rem] max-w-[80vw] max-h-72 overflow-auto bg-white border rounded-lg shadow-xl p-2 text-xs">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="w-full border rounded px-2 py-1 mb-1" />
            <label className="flex items-center gap-2 px-1 py-1 hover:bg-gray-50 cursor-pointer font-medium border-b mb-1">
              <input type="checkbox" checked={selected.size === 0} onChange={() => onChange(new Set())} className="h-4 w-4" /> (All)
            </label>
            {shown.map(v => (
              <label key={v} className="flex items-start gap-2 px-1 py-1 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selected.has(v)} onChange={() => toggle(v)} className="h-4 w-4 mt-0.5 shrink-0" />
                <span className="break-words leading-tight">{v}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="text-gray-400 px-1 py-2">No matches</div>}
          </div>
        </>
      )}
    </div>
  )
}
