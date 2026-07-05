'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadReport, prevMonthRange, leaveBreakdown, sundayContra, type EmpBlock } from '@/lib/attendanceReport'

// Cross-check tab — reconcile the payroll software's manually-keyed leave against
// the app's computed leave. Upload the "Attendance Listing Report" xlsx; people
// are matched by name and each shared leave type is compared.

// App leave key → payroll column label. These three are tracked on both sides.
const COMPARE: { key: string; label: string }[] = [
  { key: 'AL', label: 'AL' },
  { key: 'Unpaid', label: 'UL' },
  { key: 'MC', label: 'MC' },
]

// Normalise a name for matching across the two systems. Malaysian patronymic
// connectors ("A/L", "A/P", "S/O", "D/O") aren't stored the same way — ZKLink
// strips the slash (→ "AL"), payroll keeps "A/L" — so drop the connector entirely
// (any of "A/L", "A / L", or a bare "AL"/"AP" token) before comparing.
const norm = (s: string) => (s || '').toUpperCase()
  .replace(/\bA\s*\/\s*[LP]\b/g, ' ')   // A/L, A/P (slash form)
  .replace(/\b[SD]\s*\/\s*O\b/g, ' ')   // S/O, D/O
  .replace(/\//g, ' ')                   // any remaining slash
  .replace(/\b(AL|AP)\b/g, ' ')          // bare AL / AP (slash was stripped upstream)
  .replace(/[^A-Z0-9 ]/g, ' ')           // other punctuation
  .replace(/\s+/g, ' ').trim()
const near = (a: number, b: number) => Math.abs(a - b) < 0.01

interface PayRow { name: string; AL: number; UL: number; MC: number; RL: number; SL: number; TO: number; attended: number | null }

export default function CrossCheckPage() {
  const [from, setFrom] = useState(() => prevMonthRange().from)
  const [to, setTo] = useState(() => prevMonthRange().to)
  const [blocks, setBlocks] = useState<EmpBlock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pay, setPay] = useState<PayRow[]>([])
  const [fileName, setFileName] = useState('')
  const [onlyDiff, setOnlyDiff] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { const { blocks } = await loadReport(from, to); setBlocks(blocks) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [from, to])
  useEffect(() => { load() }, [load])

  async function onFile(file: File) {
    setError(null); setFileName(file.name)
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null })
      // Find the header row (the one carrying AL / MC), then map columns by label.
      const hi = rows.findIndex(r => Array.isArray(r) && r.includes('AL') && r.includes('MC'))
      if (hi < 0) { setError('Could not find the AL/MC header row — is this the payroll Attendance Listing export?'); return }
      const H = rows[hi] as unknown[]
      const col = (label: string) => H.findIndex(c => typeof c === 'string' && c.trim().toLowerCase() === label.toLowerCase())
      const ci = { name: Math.max(0, col('Name')), AL: col('AL'), UL: col('UL'), MC: col('MC'), RL: col('RL'), SL: col('SL'), TO: col('T/O'), att: col('Attended') }
      const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
      const out: PayRow[] = []
      for (const r of rows.slice(hi + 1)) {
        if (!Array.isArray(r)) continue
        const name = r[ci.name]
        if (typeof name !== 'string' || !name.trim()) continue
        out.push({
          name: name.trim(),
          AL: num(r[ci.AL]), UL: num(r[ci.UL]), MC: num(r[ci.MC]),
          RL: num(r[ci.RL]), SL: num(r[ci.SL]), TO: num(r[ci.TO]),
          attended: ci.att >= 0 ? num(r[ci.att]) : null,
        })
      }
      if (out.length === 0) { setError('No employee rows found in the file.'); return }
      setPay(out)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the file.') }
  }

  const appByName = useMemo(() => new Map(blocks.map(b => [norm(b.name), b])), [blocks])

  // One comparison row per payroll person (matched to an app block by name).
  const rows = useMemo(() => pay.map(p => {
    const b = appByName.get(norm(p.name))
    const lb = b ? leaveBreakdown(b) : {}
    // UL compared is the NET after Sunday contra (matching payroll's UL).
    const app = { AL: lb['AL'] || 0, UL: b ? sundayContra(b).netUL : 0, MC: lb['MC'] || 0 }
    const payv = { AL: p.AL, UL: p.UL, MC: p.MC }
    const diffs = COMPARE.filter(c => !near(app[c.label as 'AL' | 'UL' | 'MC'], payv[c.label as 'AL' | 'UL' | 'MC']))
    // Half-days the app detected but whose ½-leave type isn't set (in the "Half"
    // bucket) — often the exact 0.5 that makes a UL differ; flag them to categorise.
    const half = lb['Half'] || 0
    return { p, b, code: b?.code ?? '', app, payv, half, matched: !!b, ok: !!b && diffs.length === 0, diffs: diffs.map(d => d.label) }
  }), [pay, appByName])

  // App people (with attendance this month) who aren't in the payroll file at all.
  const payNames = useMemo(() => new Set(pay.map(p => norm(p.name))), [pay])
  const appOnly = useMemo(() => blocks.filter(b => b.leaveDays > 0 && !payNames.has(norm(b.name))), [blocks, payNames])

  const shown = onlyDiff ? rows.filter(r => !r.ok) : rows
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const fmtDate = (k: string) => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}` }

  // Print the currently-shown comparison (respects the Only-differences filter),
  // plus the "in app, not in payroll" list.
  function printTable() {
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
    const stat = (r: typeof shown[number]) => (!r.matched ? 'NOT IN APP' : r.ok ? 'match' : `DIFFER: ${r.diffs.join(', ')}`)
      + (r.half > 0 ? ` · ½ unassigned ${fmt(r.half)}` : '')
    const trs = shown.map(r => `<tr>
      <td>${esc(r.p.name)}${r.code ? ` (${esc(r.code)})` : ''}</td>
      <td class="n">${r.matched ? fmt(r.app.AL) : '—'} / ${fmt(r.payv.AL)}</td>
      <td class="n">${r.matched ? fmt(r.app.UL) : '—'} / ${fmt(r.payv.UL)}</td>
      <td class="n">${r.matched ? fmt(r.app.MC) : '—'} / ${fmt(r.payv.MC)}</td>
      <td>${esc(stat(r))}</td></tr>`).join('')
    const appOnlyHtml = appOnly.length ? `<h2>In the app with leave, not in payroll (${appOnly.length})</h2>
      <table><thead><tr><th>Name</th><th>Code</th><th>Leave</th></tr></thead><tbody>${appOnly.map(b =>
        `<tr><td>${esc(b.name)}</td><td>${esc(b.code)}</td><td>${esc(Object.entries(leaveBreakdown(b)).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || `${fmt(b.leaveDays)}d`)}</td></tr>`).join('')}</tbody></table>` : ''
    const css = `* { font-family: -apple-system, Segoe UI, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      @page { size: A4; margin: 12mm; }
      body { margin: 0; color: #111; }
      h1 { font-size: 15px; margin: 0 0 2px; } h2 { font-size: 13px; margin: 14px 0 4px; }
      .meta { font-size: 11px; color: #444; margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 8px; }
      th, td { border: 1px solid #bbb; padding: 3px 6px; text-align: left; }
      th { background: #eee; } td.n, th.n { text-align: center; white-space: nowrap; }`
    const win = window.open('', '_blank')
    if (!win) { setError('Please allow pop-ups to print.'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payroll cross-check</title><style>${css}</style></head><body>
      <h1>Payroll cross-check — ${fmtDate(from)} – ${fmtDate(to)}</h1>
      <div class="meta">${esc(fileName)} · ${shown.length} shown${onlyDiff ? ' (differences only)' : ''} of ${rows.length}</div>
      <table><thead><tr><th>Name</th><th class="n">AL app/pay</th><th class="n">UL app/pay</th><th class="n">MC app/pay</th><th>Status</th></tr></thead><tbody>${trs}</tbody></table>
      ${appOnlyHtml}
    </body></html>`)
    win.document.close(); win.focus()
    setTimeout(() => win.print(), 350)
  }

  return (
    <main className="max-w-full mx-auto p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">Cross-check payroll</h1>
      <p className="text-sm text-gray-500 mb-4">Upload the payroll <b>Attendance Listing Report</b> for the month; each person&apos;s leave (AL, UL, MC) is compared with what the app computed from punches.</p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-sm">Month
          <input type="month" lang="en-GB" value={from.slice(0, 7)}
            onChange={e => { const v = e.target.value; if (!v) return; const [y, m] = v.split('-').map(Number); const last = new Date(y, m, 0).getDate(); setFrom(`${v}-01`); setTo(`${v}-${String(last).padStart(2, '0')}`) }}
            className="block mt-1 rounded border border-gray-300 px-2 py-1" />
        </label>
        <label className="text-sm">Payroll file (.xlsx)
          <input type="file" accept=".xlsx,.xls" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
            className="block mt-1 text-sm" />
        </label>
        {pay.length > 0 && (
          <label className={`flex items-center gap-1.5 text-sm cursor-pointer rounded-md border px-3 py-1.5 ${onlyDiff ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-gray-300'}`}>
            <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
            Only differences
          </label>
        )}
        {pay.length > 0 && (
          <button onClick={printTable} className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">Print</button>
        )}
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>}
      <p className="text-sm text-gray-500 mb-3">
        {loading ? 'Loading app data…' : pay.length === 0 ? 'Upload the payroll file to compare.'
          : `${fileName} · ${pay.length} people in file · ${rows.filter(r => !r.ok).length} to check · ${fmtDate(from)} – ${fmtDate(to)}`}
      </p>

      {pay.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-500 bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="px-3 py-2 font-medium">Name</th>
                {COMPARE.map(c => (
                  <th key={c.key} className="px-3 py-2 font-medium text-center" colSpan={2}>{c.label} (app / payroll)</th>
                ))}
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className={`border-b border-gray-50 ${!r.matched ? 'bg-gray-50' : r.ok ? '' : 'bg-amber-50'}`}>
                  <td className="px-3 py-2 whitespace-nowrap font-medium">{r.p.name}{r.code && <span className="text-gray-400 text-xs ml-2">{r.code}</span>}</td>
                  {(['AL', 'UL', 'MC'] as const).map(k => {
                    const mismatch = r.matched && !near(r.app[k], r.payv[k])
                    return (
                      <td key={k} className={`px-3 py-2 text-center whitespace-nowrap ${mismatch ? 'font-semibold text-amber-800' : 'text-gray-700'}`} colSpan={2}>
                        {r.matched ? fmt(r.app[k]) : '—'} / {fmt(r.payv[k])}
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 whitespace-nowrap">
                    {!r.matched ? <span className="text-rose-600 text-xs">not in app</span>
                      : r.ok ? <span className="text-green-700 text-xs">✓ match</span>
                        : <span className="text-amber-700 text-xs">⚠ {r.diffs.join(', ')} differ</span>}
                    {r.half > 0 && <span className="ml-2 text-xs text-indigo-600" title="Half-day(s) with no leave type set — assign it on the Attendance page (e.g. as Unpaid) to close the gap">· ½ unassigned {fmt(r.half)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pay.length > 0 && appOnly.length > 0 && (
        <div className="mt-6">
          <h2 className="font-medium text-gray-800 mb-2">In the app with leave, but not in the payroll file ({appOnly.length})</h2>
          <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
            {appOnly.map(b => (
              <div key={b.code} className="px-3 py-2 text-sm flex justify-between">
                <span>{b.name} <span className="text-gray-400 text-xs ml-1">{b.code}</span></span>
                <span className="text-rose-600 text-xs">{Object.entries(leaveBreakdown(b)).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') || `${fmt(b.leaveDays)}d leave`}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
