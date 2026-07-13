import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requirePerm } from '@/lib/apiAuth'

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
export const maxDuration = 60
const MODEL = 'claude-sonnet-4-6'

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_purchase_order',
  description: 'Record the header and every line item of a supplier purchase order we are buying.',
  input_schema: {
    type: 'object',
    properties: {
      po_number: { type: 'string', description: 'The purchase order number (e.g. PO-1234). Empty string if none.' },
      supplier_name: { type: 'string', description: 'The supplier / vendor we are buying from. Empty string if unclear.' },
      order_date: { type: 'string', description: 'The PO date as printed. Empty string if none.' },
      expected_date: { type: 'string', description: 'The expected delivery / ETA date as printed. Empty string if none.' },
      lines: {
        type: 'array',
        description: 'One entry per ordered product line.',
        items: {
          type: 'object',
          properties: {
            item_code: { type: 'string', description: 'The item / product code as printed.' },
            description: { type: 'string', description: 'The item description.' },
            quantity: { type: 'number', description: 'The quantity ordered.' },
            uom: { type: 'string', description: 'Unit of measure if shown (BAG, CTN, KG, UNIT). Empty string if none.' },
          },
          required: ['item_code', 'description', 'quantity', 'uom'],
        },
      },
    },
    required: ['po_number', 'supplier_name', 'order_date', 'expected_date', 'lines'],
  },
}

const PROMPT = `This PDF is a PURCHASE ORDER we (SRRI EASWARI MILLS) sent to a SUPPLIER to buy goods.

Extract:
- po_number: our PO / document number,
- supplier_name: the supplier / vendor we are buying from (the party we send the PO to, NOT ourselves),
- order_date: the PO date, and expected_date: the expected delivery / ETA if shown,
- every ordered product line: item code, description, quantity, and unit of measure if shown.

Ignore totals, tax, terms and any summary blocks — only the real ordered product rows. Call record_purchase_order once with the header and one entry per product line, in order.`

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'warehouse', 'edit')
  if (auth instanceof NextResponse) return auth
  const { poId, filePath } = await request.json()
  try {
    const { data: fileBlob, error: dlError } = await supabaseAdmin.storage.from('wms-grn').download(filePath)
    if (dlError || !fileBlob) { await markError(poId, dlError?.message); return NextResponse.json({ error: `Could not read file: ${dlError?.message}` }, { status: 400 }) }
    const base64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64')

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: 8000, tools: [EXTRACTION_TOOL], tool_choice: { type: 'tool', name: 'record_purchase_order' },
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: PROMPT },
      ] }],
    })
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') { await markError(poId, 'No data extracted'); return NextResponse.json({ error: 'No data could be read from the document.' }, { status: 400 }) }
    const out = toolUse.input as { po_number?: string; supplier_name?: string; order_date?: string; expected_date?: string; lines?: POLine[] }
    const lines = out.lines || []

    const codes = [...new Set(lines.map(l => (l.item_code || '').trim()).filter(Boolean))]
    const idByCode = new Map<string, string>()
    for (let i = 0; i < codes.length; i += 500) {
      const { data } = await supabaseAdmin.from('items').select('id, code').in('code', codes.slice(i, i + 500))
      for (const d of (data as { id: string; code: string }[] || [])) idByCode.set(d.code, d.id)
    }

    await supabaseAdmin.from('wms_po_lines').delete().eq('po_id', poId)
    if (lines.length > 0) {
      const rows = lines.map((l, i) => ({
        po_id: poId, line_no: i + 1, item_id: idByCode.get((l.item_code || '').trim()) ?? null,
        item_code: (l.item_code || '').trim(), description: l.description || null,
        quantity: Number(l.quantity) || 0, uom: l.uom || null,
      }))
      const { error: insErr } = await supabaseAdmin.from('wms_po_lines').insert(rows)
      if (insErr) { await markError(poId, insErr.message); return NextResponse.json({ error: `Saving lines failed: ${insErr.message}` }, { status: 400 }) }
    }

    await supabaseAdmin.from('wms_purchase_orders').update({
      po_number: out.po_number?.trim() || null, supplier_name: out.supplier_name?.trim() || null,
      order_date: out.order_date?.trim() || null, expected_date: out.expected_date?.trim() || null,
      status: 'Open', error_message: null,
    }).eq('id', poId)

    return NextResponse.json({ success: true, count: lines.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    await markError(poId, msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function markError(poId: string, msg?: string) {
  await supabaseAdmin.from('wms_purchase_orders').update({ status: 'Error', error_message: msg ?? null }).eq('id', poId)
}

interface POLine { item_code: string; description: string; quantity: number; uom: string }
