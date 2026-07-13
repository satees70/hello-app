import { qrDataUrl } from '@/lib/qr'
import type { jsPDF } from 'jspdf'

export const LABEL_SIZES: Record<string, { w: number; h: number; label: string }> = {
  '55x35': { w: 55, h: 35, label: '55 × 35 mm' },
  '50x50': { w: 50, h: 50, label: '50 × 50 mm' },
}

// One label per page, sized in mm for a thermal roll printer.
export interface LabelItem { qrText: string; title: string; subs: string[] }

const titleFont = (len: number) => (len > 16 ? 9 : len > 12 ? 11 : len > 8 ? 14 : 18)

function draw(doc: jsPDF, w: number, h: number, qrUrl: string, title: string, subs: string[]) {
  if (w >= h) {
    const qs = Math.min(h - 6, w * 0.4)
    doc.addImage(qrUrl, 'PNG', 3, (h - qs) / 2, qs, qs)
    const tx = qs + 6
    const fs = titleFont(title.length)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(fs)
    doc.text(title, tx, h / 2 - 1, { maxWidth: w - tx - 2, lineHeightFactor: 1.05 })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    subs.forEach((s, i) => doc.text(s, tx, h / 2 + 5 + i * 4, { maxWidth: w - tx - 2 }))
  } else {
    const qs = Math.min(w - 8, h * 0.55)
    doc.addImage(qrUrl, 'PNG', (w - qs) / 2, 3, qs, qs)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(titleFont(title.length))
    doc.text(title, w / 2, qs + 8, { align: 'center', maxWidth: w - 4, lineHeightFactor: 1.05 })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    subs.forEach((s, i) => doc.text(s, w / 2, qs + 13 + i * 4, { align: 'center', maxWidth: w - 4 }))
  }
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
