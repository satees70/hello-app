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
  description: 'Record the header and every line item of an SQL Account picking list the warehouse must pick.',
  input_schema: {
    type: 'object',
    properties: {
      order_no: { type: 'string', description: 'The SO / order number at the top (e.g. SO-41596). Empty string if none.' },
      customer_name: { type: 'string', description: 'The customer / outlet the goods go to, e.g. "TF VALUE MART SDN.BHD. (SRI DAMANSARA)". NOT our own company "SRRI EASWARI MILLS". Empty string if unclear.' },
      order_date: { type: 'string', description: 'The "SO Date" exactly as printed (e.g. 13/7/2026). Empty string if none.' },
      delivery_date: { type: 'string', description: 'The "Delivery Date" exactly as printed (e.g. 15/7/2026). Empty string if none.' },
      lines: {
        type: 'array',
        description: 'One entry per numbered product line.',
        items: {
          type: 'object',
          properties: {
            item_code: { type: 'string', description: 'The Item Code, e.g. D225-10KG/BAG, E3694-10UN/BAG.' },
            description: { type: 'string', description: 'The item description, e.g. "KACANG HITAM 10KG".' },
            quantity: { type: 'number', description: 'The Qty number, e.g. 1.00, 3.00.' },
            uom: { type: 'string', description: 'The unit next to the quantity, e.g. BAG, CTN, UNIT. Empty string if none.' },
            source_location: { type: 'string', description: 'The "Picked Location" shown for this line, e.g. SUPPLIER, G202, F113, AVINA101. Empty string if none.' },
            remarks: { type: 'string', description: 'The Remarks text for this line — usually a batch number (e.g. 260630) or an expiry note (e.g. EXP08022027). Empty string if none.' },
          },
          required: ['item_code', 'description', 'quantity', 'uom', 'source_location', 'remarks'],
        },
      },
    },
    required: ['order_no', 'customer_name', 'order_date', 'delivery_date', 'lines'],
  },
}

const PROMPT = `This PDF is an SQL Account "PICKING LIST" for a sales order our warehouse must pick and ship.

Header to capture:
- order_no: the SO number at the top (e.g. SO-41596).
- customer_name: the customer / outlet (e.g. "TF VALUE MART SDN.BHD. (SRI DAMANSARA)"). NOT our own company "SRRI EASWARI MILLS" (the seller).
- order_date: the "SO Date".
- delivery_date: the "Delivery Date".

For each NUMBERED product line (1, 2, 3, …) capture:
- item_code (the Item Code column, e.g. D225-10KG/BAG),
- description (e.g. KACANG HITAM 10KG),
- quantity (the Qty number) and uom (the unit beside it: BAG / CTN / UNIT),
- source_location (the "Picked Location" for that row: SUPPLIER, a bin like G202/F113, or a factory like AVINA101),
- remarks (the Remarks for that row — a batch number like 260630 or an expiry like EXP08022027).

Ignore the "Total" row, the header/sign-off fields (Pick By, Truck No, Driver, Pending…, Print Date, etc.) and any URL. Call record_warehouse_order once with the header and one entry per numbered line, in order.`

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
    const out = toolUse.input as { order_no?: string; customer_name?: string; order_date?: string; delivery_date?: string; lines?: OrderLine[] }
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
        source_hint: l.source_location || null,
        remarks: l.remarks || null,
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
      delivery_date: out.delivery_date?.trim() || null,
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

interface OrderLine { item_code: string; description: string; quantity: number; uom: string; source_location: string; remarks: string }
