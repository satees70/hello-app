'use client'
import { useCallback, useState } from 'react'
import QrScanner from './QrScanner'

// One required scan step: match(raw) returns true if the scanned/typed code is right.
export interface ScanStep { label: string; expectText: string; match: (raw: string) => boolean }

// A guided, REQUIRED scan flow: the user must scan each step's correct code (big
// green ✓) before onComplete fires. Wrong code flashes red. A type-the-code
// fallback covers a broken camera.
export default function ScanGate({ title, steps, onComplete, onCancel }: { title: string; steps: ScanStep[]; onComplete: () => void; onCancel: () => void }) {
  const [idx, setIdx] = useState(0)
  const [flash, setFlash] = useState<'ok' | 'bad' | null>(null)
  const [manual, setManual] = useState('')
  const [camErr, setCamErr] = useState('')
  const [locked, setLocked] = useState(false)

  const handle = useCallback((raw: string) => {
    setIdx(cur => {
      if (locked || cur >= steps.length) return cur
      if (steps[cur].match(raw)) {
        setLocked(true); setFlash('ok')
        setTimeout(() => {
          setFlash(null); setLocked(false)
          if (cur + 1 >= steps.length) onComplete(); else setIdx(cur + 1)
        }, 550)
        return cur
      }
      setFlash('bad'); setTimeout(() => setFlash(null), 900)
      return cur
    })
  }, [locked, steps, onComplete])

  const step = steps[idx]
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl w-full max-w-sm p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>
        <div className="flex gap-1.5 mb-2">
          {steps.map((s, i) => <div key={i} className={`h-1.5 flex-1 rounded-full ${i < idx ? 'bg-emerald-500' : i === idx ? 'bg-emerald-300' : 'bg-gray-200'}`} />)}
        </div>
        {step && <p className="text-sm text-gray-700 mb-2">Scan the <b>{step.label}</b> <span className="text-gray-400 font-mono">({step.expectText})</span></p>}
        <div className="relative">
          {!camErr && <QrScanner onDetect={handle} onError={setCamErr} />}
          {flash && <div className={`absolute inset-0 rounded-lg flex flex-col items-center justify-center text-white font-bold ${flash === 'ok' ? 'bg-emerald-600/85' : 'bg-red-600/85'}`}>
            <span className="text-6xl">{flash === 'ok' ? '✓' : '✗'}</span>
            <span className="text-lg mt-1">{flash === 'ok' ? 'Correct' : 'Wrong — try again'}</span>
          </div>}
        </div>
        {camErr && <p className="text-xs text-amber-600 mt-2">Camera off ({camErr}). Type the code instead:</p>}
        <div className="flex gap-2 mt-3">
          <input value={manual} onChange={e => setManual(e.target.value)} placeholder="or type the code…" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
          <button type="button" onClick={() => { handle(manual); setManual('') }} className="border px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50">Enter</button>
        </div>
      </div>
    </div>
  )
}
