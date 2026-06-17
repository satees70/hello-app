import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const MODEL = 'claude-opus-4-8'

// Structured-output tool: forces Claude to return clean rows instead of prose.
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
- Every numbered line item in the table. For each: Item Code, Description, Qty (the number only — drop the unit word), the unit word, and the Batch value.

Ignore the "Total" row at the bottom. Call record_delivery_order with one entry per numbered line.`

export async function POST(request: Request) {
  const { pdfBase64 } = await request.json()
  if (!pdfBase64) return NextResponse.json({ error: 'No file provided.' }, { status: 400 })
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: 'Extraction is not configured (missing API key).' }, { status: 500 })

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_delivery_order' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })
    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      return NextResponse.json({ error: 'No data could be read from the document.' }, { status: 400 })
    }
    return NextResponse.json(toolUse.input)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Extraction failed.'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
