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
            so_number: { type: 'string', description: 'The sales order / document number for THIS line, from the "Doc No" column, e.g. SO-40434.' },
            item_code: { type: 'string', description: 'The item / product code, e.g. HE4424-25UN/PACK.' },
            description: { type: 'string', description: 'The full item description.' },
            quantity: { type: 'number', description: 'The original order quantity (Orig Qty).' },
            outstanding_qty: { type: 'number', description: 'The outstanding quantity (O/Stding).' },
            delivery_date: { type: 'string', description: 'The delivery date exactly as printed, e.g. 13/06/26.' },
            location_code: { type: 'string', description: 'The LOCATION code for THIS line, e.g. AVINA14 or AVINA102. This is per line, not per document.' },
          },
          required: ['customer_name', 'so_number', 'item_code', 'description', 'quantity', 'outstanding_qty', 'delivery_date', 'location_code'],
        },
      },
    },
    required: ['lines'],
  },
}

const PROMPT = `This is an "Outstanding Sales Order Listing" PDF. Extract every numbered line item (the rows with sequence numbers 1, 2, 3, …).

How customers work — read this carefully:
- The company whose name and registration number appear at the very TOP of the listing (e.g. "SRRI EASWARI MILLS SDN BHD (198601008174 (157367-T))") is the SELLER / our own company. Do NOT treat it as a customer.
- The CUSTOMER is the buyer. Customer names appear as header rows above their line items, often prefixed by a document number like "SO-40434" (e.g. "SO-40434 MY HERO HYPERMARKET SDN. BHD."). The customer name is the company name itself, without the SO number.
- The document can contain MULTIPLE customers. Each numbered line item belongs to the customer header that appears above it, and keeps belonging to that customer until the next customer header appears.

Other rules:
- The LOCATION code (e.g. AVINA14, AVINA102) is PER LINE, not per document — read it from the LOCATION column for that specific row.
- Ignore the "Back Order Summary" section at the bottom; only extract the main numbered line-item rows.
- The SO NUMBER comes from the "Doc No" column (e.g. SO-40434) and is per line — production staff use it to know which order a line is for.
- For each line capture: customer name, SO number (Doc No), item code, description, original quantity (Orig Qty), outstanding quantity (O/Stding), delivery date, and location code.

Call the record_sales_order_lines tool with one entry per numbered line item, in the order they appear.`

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

    // 3. Auto-fill each line's factory by looking its location code up in the map.
    const { data: lmRows } = await supabaseAdmin
      .from('location_map')
      .select('location_code, factory_code')
    const lmMap = new Map((lmRows || []).map(r => [r.location_code, r.factory_code]))

    // 4. Replace any previous lines for this import, then insert the fresh set.
    //    Unmapped locations get an empty factory; the user resolves them on the
    //    confirmation screen before anything is marked Processed.
    await supabaseAdmin.from('sales_order_lines').delete().eq('import_id', importId)
    if (lines.length > 0) {
      const rows = lines.map(l => ({
        ...l,
        import_id: importId,
        factory_code: lmMap.get(l.location_code) || '',
      }))
      const { error: insErr } = await supabaseAdmin.from('sales_order_lines').insert(rows)
      if (insErr) {
        await markError(importId)
        return NextResponse.json({ error: `Saving lines failed: ${insErr.message}` }, { status: 400 })
      }
    }

    // 5. Mark the document for review — NOT processed. The user confirms.
    await supabaseAdmin.from('sales_imports').update({ status: 'Review' }).eq('id', importId)

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
  so_number: string
  item_code: string
  description: string
  quantity: number
  outstanding_qty: number
  delivery_date: string
  location_code: string
}
