import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

// Server-only clients — these keys must never reach the browser.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// Most capable model for messy multi-column document extraction.
// Switch to 'claude-sonnet-4-6' if you want lower cost per document.
const MODEL = 'claude-opus-4-8'

// Structured-output tool: forces Claude to return clean rows instead of prose.
const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_sales_order_lines',
  description: 'Record every line item extracted from the sales order listing.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            customer_name: { type: 'string', description: 'The customer this line belongs to. A document can list several customers; each one appears as a header above its lines.' },
            item_code: { type: 'string', description: 'The item / product code, e.g. HE4424-25UN/PACK.' },
            description: { type: 'string', description: 'The full item description.' },
            quantity: { type: 'number', description: 'The original order quantity (Orig Qty).' },
            outstanding_qty: { type: 'number', description: 'The outstanding quantity (O/Stding).' },
            delivery_date: { type: 'string', description: 'The delivery date exactly as printed, e.g. 13/06/26.' },
            location_code: { type: 'string', description: 'The LOCATION code for THIS line, e.g. AVINA14 or AVINA102. This is per line, not per document.' },
          },
          required: ['customer_name', 'item_code', 'description', 'quantity', 'outstanding_qty', 'delivery_date', 'location_code'],
        },
      },
    },
    required: ['lines'],
  },
}

const PROMPT = `This is an "Outstanding Sales Order Listing" PDF. Extract every line item.

Important rules:
- The document can contain MULTIPLE customers. Each customer name appears as a header row, and the line items below it belong to that customer until the next customer header appears.
- The LOCATION code (e.g. AVINA14, AVINA102) is PER LINE, not per document — read it from the LOCATION column for each individual line.
- Ignore the "Back Order Summary" section at the bottom; only extract the main line-item rows.
- For each line capture: customer name, item code, description, original quantity, outstanding quantity, delivery date, and location code.

Call the record_sales_order_lines tool with one entry per line item.`

export async function POST(request: Request) {
  const { importId, filePath } = await request.json()

  try {
    // 1. Pull the PDF back out of Supabase storage.
    const { data: fileBlob, error: dlError } = await supabaseAdmin.storage
      .from('sales-orders')
      .download(filePath)
    if (dlError || !fileBlob) {
      await markError(importId)
      return NextResponse.json({ error: `Could not read file: ${dlError?.message}` }, { status: 400 })
    }
    const base64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64')

    // 2. Ask Claude to read the PDF and return structured rows.
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_sales_order_lines' },
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
      await markError(importId)
      return NextResponse.json({ error: 'No data extracted from the document.' }, { status: 400 })
    }
    const lines = (toolUse.input as { lines: SalesLine[] }).lines || []

    // 3. Look up the import so each line inherits its factory (for RLS).
    const { data: imp } = await supabaseAdmin
      .from('sales_imports')
      .select('factory_code')
      .eq('id', importId)
      .single()
    const factory_code = imp?.factory_code || 'HEAD_OFFICE'

    // 4. Replace any previous lines for this import, then insert the fresh set.
    await supabaseAdmin.from('sales_order_lines').delete().eq('import_id', importId)
    if (lines.length > 0) {
      const rows = lines.map(l => ({ ...l, import_id: importId, factory_code }))
      const { error: insErr } = await supabaseAdmin.from('sales_order_lines').insert(rows)
      if (insErr) {
        await markError(importId)
        return NextResponse.json({ error: `Saving lines failed: ${insErr.message}` }, { status: 400 })
      }
    }

    // 5. Mark the document as processed.
    await supabaseAdmin.from('sales_imports').update({ status: 'Processed' }).eq('id', importId)

    return NextResponse.json({ success: true, count: lines.length })
  } catch (e) {
    await markError(importId)
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function markError(importId: string) {
  await supabaseAdmin.from('sales_imports').update({ status: 'Error' }).eq('id', importId)
}

interface SalesLine {
  customer_name: string
  item_code: string
  description: string
  quantity: number
  outstanding_qty: number
  delivery_date: string
  location_code: string
}
