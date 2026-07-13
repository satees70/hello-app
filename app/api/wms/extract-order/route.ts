import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requirePerm } from '@/lib/apiAuth'

// Server-only clients — these keys must never reach the browser.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// Reading a PDF can run longer than the default ~10s limit.
export const maxDuration = 60

// Sonnet is fast + cheap for document extraction (same choice as extract-sales-order).
const MODEL = 'claude-sonnet-4-6'

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_warehouse_order',
  description: 'Record the header and every line item of a customer order the warehouse must pick.',
  input_schema: {
    type: 'object',
    properties: {
      order_no: { type: 'string', description: 'The order / document number (e.g. SO-40496, PO number). Empty string if none.' },
      customer_name: { type: 'string', description: 'The customer the goods are being sent to (the buyer). Empty string if unclear.' },
      order_date: { type: 'string', description: 'The order date exactly as printed (e.g. 13/06/26). Empty string if none.' },
      lines: {
        type: 'array',
        description: 'One entry per ordered product line.',
        items: {
          type: 'object',
          properties: {
            item_code: { type: 'string', description: 'The product / item code as printed.' },
            description: { type: 'string', description: 'The item description.' },
            quantity: { type: 'number', description: 'The quantity ordered for this line.' },
            uom: { type: 'string', description: 'The unit of measure if shown (e.g. UNIT, CTN, BAG, KG). Empty string if none.' },
          },
          required: ['item_code', 'description', 'quantity', 'uom'],
        },
      },
    },
    required: ['order_no', 'customer_name', 'order_date', 'lines'],
  },
}

const PROMPT = `This PDF is a CUSTOMER ORDER that our warehouse must pick and ship (a sales order / purchase order sent to us).

Extract:
- the order number (Doc No / SO / PO number),
- the customer (the buyer we are shipping to — NOT our own company "SRRI EASWARI MILLS", which is the seller),
- the order date as printed,
- and every ordered product line: item code, description, quantity, and unit of measure if shown.

Ignore totals, tax lines, terms & conditions, and any summary blocks — only the real ordered product rows. Call record_warehouse_order once with the header and one entry per product line, in the order they appear.`

export async function POST(request: Request) {
  // Only warehouse editors create orders (matches the /wms/orders upload gate).
  const auth = await requirePerm(request, 'warehouse', 'edit')
  if (auth instanceof NextResponse) return auth

  const { orderId, filePath } = await request.json()

  try {
    const { data: fileBlob, error: dlError } = await supabaseAdmin.storage.from('wms-orders').download(filePath)
    if (dlError || !fileBlob) {
      await markError(orderId, dlError?.message)
      return NextResponse.json({ error: `Could not read file: ${dlError?.message}` }, { status: 400 })
    }
    const base64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64')

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_warehouse_order' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })

    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      await markError(orderId, 'No data extracted')
      return NextResponse.json({ error: 'No data could be read from the document.' }, { status: 400 })
    }
    const out = toolUse.input as { order_no?: string; customer_name?: string; order_date?: string; lines?: OrderLine[] }
    const lines = out.lines || []

    // Resolve each item code to the Items master (unknown codes stay unlinked, flagged in the UI).
    const codes = [...new Set(lines.map(l => (l.item_code || '').trim()).filter(Boolean))]
    const idByCode = new Map<string, string>()
    for (let i = 0; i < codes.length; i += 500) {
      const { data } = await supabaseAdmin.from('items').select('id, code').in('code', codes.slice(i, i + 500))
      for (const d of (data as { id: string; code: string }[] || [])) idByCode.set(d.code, d.id)
    }

    await supabaseAdmin.from('wms_order_lines').delete().eq('order_id', orderId)
    if (lines.length > 0) {
      const rows = lines.map((l, i) => ({
        order_id: orderId,
        line_no: i + 1,
        item_id: idByCode.get((l.item_code || '').trim()) ?? null,
        item_code: (l.item_code || '').trim(),
        description: l.description || null,
        quantity: Number(l.quantity) || 0,
        uom: l.uom || null,
      }))
      const { error: insErr } = await supabaseAdmin.from('wms_order_lines').insert(rows)
      if (insErr) {
        await markError(orderId, insErr.message)
        return NextResponse.json({ error: `Saving lines failed: ${insErr.message}` }, { status: 400 })
      }
    }

    await supabaseAdmin.from('wms_orders').update({
      order_no: out.order_no?.trim() || null,
      customer_name: out.customer_name?.trim() || null,
      order_date: out.order_date?.trim() || null,
      status: 'Review',
      error_message: null,
    }).eq('id', orderId)

    return NextResponse.json({ success: true, count: lines.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    await markError(orderId, msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function markError(orderId: string, msg?: string) {
  await supabaseAdmin.from('wms_orders').update({ status: 'Error', error_message: msg ?? null }).eq('id', orderId)
}

interface OrderLine { item_code: string; description: string; quantity: number; uom: string }
