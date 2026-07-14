import { qrDataUrl } from '@/lib/qr'
import type { jsPDF } from 'jspdf'

export const LABEL_SIZES: Record<string, { w: number; h: number; label: string }> = {
  '55x35': { w: 55, h: 35, label: '55 × 35 mm' },
  '50x50': { w: 50, h: 50, label: '50 × 50 mm' },
}

// One label per page, sized in mm for a thermal roll printer.
export interface LabelItem { qrText: string; title: string; subs: string[] }

const titleFont = (len: number) => (len > 16 ? 9 : len > 12 ? 11 : len > 8 ? 14 : 18)
const lineH = (ptFont: number) => ptFont * 0.3528 * 1.15   // mm per line

// Stack title + sub-lines from the top of the text area, wrapping long text onto
// extra lines instead of overlapping (item names can be long).
function draw(doc: jsPDF, w: number, h: number, qrUrl: string, title: string, subs: string[]) {
  const square = w < h
  const qs = square ? Math.min(w - 8, h * 0.46) : Math.min(h - 6, w * 0.4)
  const qx = square ? (w - qs) / 2 : 3
  const qy = square ? 3 : (h - qs) / 2
  doc.addImage(qrUrl, 'PNG', qx, qy, qs, qs)

  const tx = square ? w / 2 : qs + 6
  const tw = square ? w - 4 : w - (qs + 6) - 2
  const align: 'center' | 'left' = square ? 'center' : 'left'
  let y = square ? qy + qs + 5 : 6

  const fs = titleFont(title.length)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(fs)
  for (const line of doc.splitTextToSize(title, tw)) { doc.text(line, tx, y, { align }); y += lineH(fs) }
  y += 1.5
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  for (const s of subs) for (const line of doc.splitTextToSize(s, tw)) { doc.text(line, tx, y, { align }); y += lineH(8) }
}

export async function downloadLabels(items: LabelItem[], sizeKey: string, filename: string, onProgress?: (i: number, n: number) => void) {
  if (!items.length) return
  const { jsPDF } = await import('jspdf')
  const { w, h } = LABEL_SIZES[sizeKey] || LABEL_SIZES['55x35']
  // Respect the chosen width×height: landscape when wider than tall (jsPDF defaults
  // to portrait and would otherwise swap 55×35 into 35×55).
  const orientation = w >= h ? 'landscape' : 'portrait'
  const doc = new jsPDF({ unit: 'mm', orientation, format: [w, h] })
  for (let i = 0; i < items.length; i++) {
    if (i > 0) doc.addPage([w, h], orientation)
    const url = await qrDataUrl(items[i].qrText)
    draw(doc, w, h, url, items[i].title, items[i].subs)
    if (onProgress && i % 50 === 0) onProgress(i, items.length)
  }
  doc.save(filename)
}
