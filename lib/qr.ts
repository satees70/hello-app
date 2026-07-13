import QRCode from 'qrcode'

// QR payloads are tiny prefixed strings so a scan instantly says what it is:
//   bin   → "BIN|A105"
//   stock → "ITEM|<item_code>|<batch>|<expiry>"
export type ParsedQr =
  | { kind: 'bin'; code: string }
  | { kind: 'item'; item_code: string; batch: string; exp: string }
  | { kind: 'unknown'; raw: string }

export const encodeBin = (code: string) => `BIN|${code.trim().toUpperCase()}`
export const encodeItem = (itemCode: string, batch?: string | null, exp?: string | null) =>
  `ITEM|${itemCode.trim()}|${(batch || '').trim()}|${(exp || '').trim()}`

export function parseQr(raw: string): ParsedQr {
  const t = (raw || '').trim()
  const up = t.toUpperCase()
  if (up.startsWith('BIN|')) return { kind: 'bin', code: t.slice(4).trim().toUpperCase() }
  if (up.startsWith('ITEM|')) {
    const parts = t.split('|')
    return { kind: 'item', item_code: (parts[1] || '').trim(), batch: (parts[2] || '').trim(), exp: (parts[3] || '').trim() }
  }
  return { kind: 'unknown', raw: t }
}

// Matchers accept either a scanned QR or a hand-typed bare code (camera fallback).
export function matchBin(raw: string, expectCode: string): boolean {
  const e = expectCode.trim().toUpperCase()
  const p = parseQr(raw)
  if (p.kind === 'bin') return p.code === e
  return raw.trim().toUpperCase() === e
}
export function matchItem(raw: string, itemCode: string, batch: string): boolean {
  const item = itemCode.trim().toUpperCase(); const b = (batch || '').trim()
  const p = parseQr(raw)
  if (p.kind === 'item') return p.item_code.toUpperCase() === item && p.batch === b
  const parts = raw.trim().split('|')
  if (parts.length >= 2) return parts[0].toUpperCase() === item && parts[1].trim() === b
  return parts[0].toUpperCase() === item && !b
}

export async function qrDataUrl(text: string, width = 260): Promise<string> {
  return QRCode.toDataURL(text, { margin: 1, width, errorCorrectionLevel: 'M' })
}
