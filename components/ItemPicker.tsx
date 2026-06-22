'use client'
import { useState } from 'react'

// Searchable item dropdown: type a code OR a name (punctuation/word-order
// tolerant) and click a row. Used wherever staff pick an item from the master.
export default function ItemPicker({ items, value, onPick, placeholder = 'Type a code or name…' }: {
  items: { code: string; description: string; unit: string }[]
  value: string
  onPick: (it: { code: string; description: string; unit: string }) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const words = norm(q).split(' ').filter(Boolean)
  const matches = (words.length ? items.filter(i => { const hay = norm(i.code + ' ' + i.description); return words.every(w => hay.includes(w)) }) : items).slice(0, 60)
  return (
    <div className="relative">
      <input value={open ? q : value} onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => { setQ(''); setOpen(true) }} onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder} className="w-full border rounded-lg px-3 py-2 text-sm" />
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto bg-white border rounded-lg shadow-lg">
          {matches.length === 0 && <div className="px-3 py-2 text-sm text-gray-400">No matching item — check the Items master.</div>}
          {matches.map(i => (
            <button key={i.code} type="button" onMouseDown={e => { e.preventDefault(); onPick(i); setOpen(false) }}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b last:border-0">
              <span className="font-mono font-medium">{i.code}</span> <span className="text-gray-500">{i.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
