import { qrDataUrl } from '@/lib/qr'
import type { jsPDF } from 'jspdf'

export const LABEL_SIZES: Record<string, { w: number; h: number; label: string }> = {
  '55x35': { w: 55, h: 35, label: '55 × 35 mm' },
  '50x50': { w: 50, h: 50, label: '50 × 50 mm' },
}

// One label per page, sized in mm for a thermal roll printer.
export interface LabelItem { qrText: string; title: string; subs: string[] }

function draw(doc: jsPDF, w: number, h: number, qrUrl: string, title: string, subs: string[]) {
  if (w >= h) {
    const qs = Math.min(h - 6, w * 0.42)
    doc.addImage(qrUrl, 'PNG', 3, (h - qs) / 2, qs, qs)
    const tx = qs + 7
    doc.setFont('helvetica', 'bold'); doc.setFontSize(title.length > 9 ? 13 : 18)
    doc.text(title, tx, h / 2, { maxWidth: w - tx - 2 })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    subs.forEach((s, i) => doc.text(s, tx, h / 2 + 5 + i * 4, { maxWidth: w - tx - 2 }))
  } else {
    const qs = Math.min(w - 8, h * 0.58)
    doc.addImage(qrUrl, 'PNG', (w - qs) / 2, 3, qs, qs)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(title.length > 12 ? 12 : 15)
    doc.text(title, w / 2, qs + 8, { align: 'center', maxWidth: w - 4 })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    subs.forEach((s, i) => doc.text(s, w / 2, qs + 13 + i * 4, { align: 'center', maxWidth: w - 4 }))
  }
}

export async function downloadLabels(items: LabelItem[], sizeKey: string, filename: string, onProgress?: (i: number, n: number) => void) {
  if (!items.length) return
  const { jsPDF } = await import('jspdf')
  const { w, h } = LABEL_SIZES[sizeKey] || LABEL_SIZES['55x35']
  const doc = new jsPDF({ unit: 'mm', format: [w, h] })
  for (let i = 0; i < items.length; i++) {
    if (i > 0) doc.addPage([w, h])
    const url = await qrDataUrl(items[i].qrText)
    draw(doc, w, h, url, items[i].title, items[i].subs)
    if (onProgress && i % 50 === 0) onProgress(i, items.length)
  }
  doc.save(filename)
}
