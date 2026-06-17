import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

// Server-only clients — these keys must never reach the browser.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const MODEL = 'claude-opus-4-8'

interface DoLine { item_code: string; description: string; quantity: number; unit: string; batch_no: string }

const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_delivery_order',
  description: 'Record the delivery order header and every line item delivered.',
  input_schema: {
    type: 'object',
    properties: {
      do_number: { type: 'string', description: 'The Delivery Order number, e.g. DO-260613/0596.' },
      do_date: { type: 'string', description: 'The Date on the document exactly as printed, e.g. 13/6/2026.' },
      factory_no: { type: 'string', description: 'The factory/branch number from the company header, e.g. "102" from "SRRI EASWARI MILLS SDN BHD(NO.102)". Digits only; empty string if not shown.' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_code: { type: 'string', description: 'The Item Code exactly as printed, e.g. P901000 or D982-3KG/BAG.' },
            description: { type: 'string', description: 'The item description.' },
            quantity: { type: 'number', description: 'The Qty delivered — the number only, ignore the unit word (e.g. 12.00 from "12.00 BAG").' },
            unit: { type: 'string', description: 'The unit word shown next to the qty, e.g. Unit or BAG. Empty string if none.' },
            batch_no: { type: 'string', description: 'The Batch value for this line, e.g. 260608. Empty string if none.' },
          },
          required: ['item_code', 'description', 'quantity', 'unit', 'batch_no'],
        },
      },
    },
    required: ['do_number', 'do_date', 'factory_no', 'lines'],
  },
}

const PROMPT = `This is a DELIVERY ORDER (DO) PDF from our own company's warehouse, listing materials delivered to one of our factories.

Extract:
- The Delivery Order number (top right, e.g. DO-260613/0596).
- The Date exactly as printed.
- The factory/branch number from the company header — e.g. "102" from "SRRI EASWARI MILLS SDN BHD(NO.102)". Digits only.
- Every numbered line item in the table. For each: Item Code, Description, Qty (number only — drop the unit word), the unit word, and the Batch value.

Ignore the "Total" row at the bottom. Call record_delivery_order with one entry per numbered line.`

async function markError(doId: string) {
  await supabaseAdmin.from('delivery_orders').update({ status: 'Error' }).eq('id', doId)
}

export async function POST(request: Request) {
  const { doId, filePath } = await request.json()
  if (!doId || !filePath) return NextResponse.json({ error: 'Missing document reference.' }, { status: 400 })
  if (!process.env.ANTHROPIC_API_KEY) { await markError(doId); return NextResponse.json({ error: 'Extraction is not configured (missing API key).' }, { status: 500 }) }

  try {
    const { data: fileBlob, error: dlError } = await supabaseAdmin.storage.from('delivery-orders').download(filePath)
    if (dlError || !fileBlob) { await markError(doId); return NextResponse.json({ error: `Could not read file: ${dlError?.message}` }, { status: 400 }) }
    const base64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64')

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_delivery_order' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') { await markError(doId); return NextResponse.json({ error: 'No data could be read from the document.' }, { status: 400 }) }
    const input = toolUse.input as { do_number: string; do_date: string; factory_no: string; lines: DoLine[] }
    const lines = input.lines || []

    // Header: set the DO number/date, and the factory from the branch number if present.
    const headerUpdate: Record<string, string> = { do_number: input.do_number || '', do_date: input.do_date || '', status: 'Review' }
    if (input.factory_no) headerUpdate.factory_code = `AVINA${input.factory_no}`
    await supabaseAdmin.from('delivery_orders').update(headerUpdate).eq('id', doId)

    // Replace any previous lines, then insert the fresh set.
    await supabaseAdmin.from('delivery_order_lines').delete().eq('do_id', doId)
    if (lines.length > 0) {
      const rows = lines.map(l => ({ do_id: doId, item_code: l.item_code, description: l.description, quantity: l.quantity, unit: l.unit, batch_no: l.batch_no }))
      const { error: insErr } = await supabaseAdmin.from('delivery_order_lines').insert(rows)
      if (insErr) { await markError(doId); return NextResponse.json({ error: `Saving lines failed: ${insErr.message}` }, { status: 400 }) }
    }

    return NextResponse.json({ count: lines.length })
  } catch (e) {
    await markError(doId)
    const msg = e instanceof Error ? e.message : 'Extraction failed.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
