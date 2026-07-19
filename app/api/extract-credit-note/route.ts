import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { getCaller } from '@/lib/apiAuth'
import { can } from '@/lib/permissions'
import { logError, MAX_UPLOAD_BYTES } from '@/lib/log'

// Reads a customer Credit Note PDF (raised in SQL Account) and returns its header + line items so
// the upload form can auto-fill. Nothing is written to the DB here — the page saves after review.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
export const maxDuration = 60
const MODEL = 'claude-sonnet-4-6'

const TOOL: Anthropic.Tool = {
  name: 'record_credit_note',
  description: 'Record the header and line items of the customer credit note.',
  input_schema: {
    type: 'object',
    properties: {
      cn_number: { type: 'string', description: 'The credit note number / document number, e.g. CN-2607/0012.' },
      customer_name: { type: 'string', description: 'The customer (buyer) the credit note is issued to. NOT the seller (SRRI EASWARI MILLS at the top).' },
      cn_date: { type: 'string', description: 'The credit note date in YYYY-MM-DD format. Convert from whatever format is printed (e.g. 17/07/2026 → 2026-07-17).' },
      so_number: { type: 'string', description: 'Any referenced sales order / invoice / DO number this credit note relates to, if shown. Empty if none.' },
      lines: {
        type: 'array',
        description: 'The product line items being credited/returned.',
        items: {
          type: 'object',
          properties: {
            item_code: { type: 'string', description: 'Item / product code.' },
            description: { type: 'string', description: 'Item description.' },
            quantity: { type: 'number', description: 'Quantity credited / returned (a positive number).' },
          },
          required: ['item_code', 'description', 'quantity'],
        },
      },
    },
    required: ['cn_number', 'customer_name', 'cn_date', 'so_number', 'lines'],
  },
}

const PROMPT = `This is a customer CREDIT NOTE (CN) PDF from an accounting system (SQL Account).
- The company at the very TOP (SRRI EASWARI MILLS SDN BHD) is the SELLER / us — NOT the customer.
- The CUSTOMER is the buyer the credit note is issued to.
- Capture the credit note number, the customer name, the CN date (return it as YYYY-MM-DD), and any referenced sales order / invoice / DO number if present.
- Capture each product line being credited/returned: item code, description, and quantity (as a positive number). Ignore tax/rounding/summary rows.
Call record_credit_note with what you find. If a field isn't present, use an empty string (or an empty list for lines).`

export async function POST(request: Request) {
  // Credit Notes live in the warehouse app but are also sales data — allow either grant.
  const caller = await getCaller(request)
  if (!caller) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  if (!can(caller.profile, 'warehouse', 'view') && !can(caller.profile, 'sales', 'view')) {
    return NextResponse.json({ error: 'You don’t have permission to do that.' }, { status: 403 })
  }
  try {
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof Blob)) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 })
    if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).` }, { status: 413 })
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    const media = (file.type || 'application/pdf')
    const isPdf = media.includes('pdf')

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'record_credit_note' },
      messages: [{
        role: 'user',
        content: [
          isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
            : { type: 'image', source: { type: 'base64', media_type: (media as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'), data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') return NextResponse.json({ error: 'Could not read the document.' }, { status: 400 })
    return NextResponse.json({ success: true, data: toolUse.input })
  } catch (e) {
    logError('extract-credit-note', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: 500 })
  }
}
