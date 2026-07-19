'use client'
import { useEffect, useMemo, useRef, useState } from 'react'

// A readable, high-contrast bin autocomplete. Replaces the native <datalist>, whose dropdown
// text renders nearly invisible on some devices. Type to filter; click to pick.
export default function BinPicker({ bins, value, onChange, className, placeholder }: {
  bins: string[]; value: string; onChange: (v: string) => void; className?: string; placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const shown = useMemo(() => {
    const f = (value || '').toUpperCase()
    return bins.filter(b => b.toUpperCase().includes(f)).slice(0, 50)
  }, [bins, value])
  return (
    <div ref={ref} className="relative">
      <input value={value} onChange={e => { onChange(e.target.value.toUpperCase()); setOpen(true) }} onFocus={() => setOpen(true)}
        className={className} placeholder={placeholder} autoComplete="off" />
      {open && shown.length > 0 && (
        <div className="absolute left-0 z-50 mt-1 max-h-56 min-w-full w-max overflow-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {shown.map(b => (
            <button key={b} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onChange(b); setOpen(false) }}
              className="block w-full text-left px-3 py-1.5 text-sm font-mono text-gray-800 hover:bg-emerald-50">{b}</button>
          ))}
        </div>
      )}
    </div>
  )
}
