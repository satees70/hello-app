// Download a table as a CSV file (client-side, no dependency).
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    let s = v == null ? '' : String(v)
    // Spreadsheet formula-injection guard: a TEXT cell starting with = + - @ (or tab/CR)
    // could run as a formula in Excel — prefix a quote. Numbers are left alone, both
    // number type and pre-formatted numeric strings like "-1,234.5" / "+5" (callers
    // pass fmtQty/fmtSigned output), so negatives stay numeric.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?(\d[\d,]*)?\.?\d+%?$/.test(s)) s = `'${s}`
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n')
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  // Revoke later — revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
