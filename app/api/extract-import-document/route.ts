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

// Reading a PDF can run longer than the default ~10s limit; allow up to 60s.
export const maxDuration = 60

// Sonnet is fast + cheap for this extraction (same choice as extract-sales-order).
const MODEL = 'claude-sonnet-4-6'

// Structured-output tool: forces clean fields instead of prose. Only doc_type is
// strictly required — a given document (sales order / invoice / BL) will only
// carry some of these, and blanks are expected.
const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_import_document',
  description: 'Record the shipment details found in this import document.',
  input_schema: {
    type: 'object',
    properties: {
      doc_type: { type: 'string', enum: ['sales_order', 'invoice', 'bill_of_lading', 'packing_list', 'other'], description: 'What kind of document this is.' },
      supplier_name: { type: 'string', description: 'The overseas SUPPLIER / seller / shipper name exactly as printed. This is the company sending the goods TO us, NOT the buyer (SRRI EASWARI MILLS / AVINA).' },
      supplier_match: { type: 'string', description: 'If the supplier clearly matches one of the KNOWN SUPPLIERS provided, copy that exact known name here; otherwise leave empty.' },
      reference: { type: 'string', description: 'The main reference number: invoice no., proforma-invoice no., or the supplier sales-order no. Empty if none.' },
      bl: {
        type: 'object',
        description: 'Bill of Lading details, if this document has them (typically only a BL does).',
        properties: {
          bl_number: { type: 'string' },
          shipping_line: { type: 'string' },
          vessel: { type: 'string' },
          port_of_loading: { type: 'string' },
          port_of_discharge: { type: 'string' },
          shipped_date: { type: 'string', description: 'ISO yyyy-mm-dd if determinable, else empty.' },
          eta: { type: 'string', description: 'ISO yyyy-mm-dd if determinable, else empty.' },
          arrival_date: { type: 'string', description: 'ISO yyyy-mm-dd if determinable, else empty.' },
        },
      },
      containers: {
        type: 'array',
        description: 'Every container number mentioned. Empty if none.',
        items: {
          type: 'object',
          properties: {
            container_no: { type: 'string' },
            container_type: { type: 'string', description: 'e.g. 20GP / 40HC, if stated.' },
          },
          required: ['container_no'],
        },
      },
      items: {
        type: 'array',
        description: 'Every product line on the document.',
        items: {
          type: 'object',
          properties: {
            description_en: { type: 'string', description: 'The product description as printed on the document (English).' },
            matched_item_code: { type: 'string', description: 'The CODE of the best-matching item from the KNOWN ITEMS list, or empty if no confident match.' },
            match_confidence: { type: 'string', enum: ['high', 'low', 'none'], description: 'How confident the match is.' },
            quantity: { type: 'number' },
            declared_weight: { type: 'number', description: 'Declared/net/gross weight in kg for this line, if stated.' },
          },
          required: ['description_en', 'match_confidence'],
        },
      },
    },
    required: ['doc_type', 'containers', 'items'],
  },
}

interface KnownItem { code: string; description: string }

function buildPrompt(suppliers: string[], items: KnownItem[]): string {
  // Keep the item list compact — one line each — so the model can map against it.
  const itemList = items.map(i => `${i.code}\t${i.description}`).join('\n')
  const supplierList = suppliers.length ? suppliers.map(s => `- ${s}`).join('\n') : '(none yet)'
  return `This is a document for an IMPORT shipment of goods coming INTO our company (SRRI EASWARI MILLS / AVINA) from an overseas supplier. It may be a supplier's sales order, a commercial/proforma invoice, a packing list, or a Bill of Lading. Read it and record what it contains with the record_import_document tool.

Important:
- We are the BUYER. The SUPPLIER is the seller/shipper sending goods to us — never record our own company as the supplier.
- A document usually contains only SOME of the fields (e.g. a BL has containers + shipping details but maybe no prices). Leave anything not present empty.
- Dates: give ISO yyyy-mm-dd when you can work them out; otherwise leave empty.

Matching products across languages — READ CAREFULLY:
- Our item master descriptions are in MALAY. This document is in ENGLISH.
- For EACH product line, translate the English description and find the closest item in the KNOWN ITEMS list below by MEANING (not by literal text). Put that item's CODE in matched_item_code and set match_confidence to "high" when you are sure, "low" when it is a plausible guess, and leave matched_item_code empty with "none" when nothing fits. A human will confirm low/none matches — do not force a wrong match.

KNOWN SUPPLIERS (copy the exact name into supplier_match only if it clearly matches):
${supplierList}

KNOWN ITEMS (code<TAB>Malay description):
${itemList}
`
}

export async function POST(request: Request) {
  const auth = await requirePerm(request, 'import', 'edit')
  if (auth instanceof NextResponse) return auth

  const { documentId, filePath } = await request.json()

  try {
    // 1. Pull the PDF back out of storage.
    const { data: fileBlob, error: dlError } = await supabaseAdmin.storage
      .from('import-docs')
      .download(filePath)
    if (dlError || !fileBlob) {
      await markError(documentId, dlError?.message || 'Could not read file')
      return NextResponse.json({ error: `Could not read file: ${dlError?.message}` }, { status: 400 })
    }
    const base64 = Buffer.from(await fileBlob.arrayBuffer()).toString('base64')

    // 2. Load the lists the model matches against (supplier names + item master).
    const [{ data: sup }, itemRows] = await Promise.all([
      supabaseAdmin.from('import_suppliers').select('name').eq('active', true),
      fetchAllItems(),
    ])
    const supplierNames = (sup || []).map(s => s.name as string)

    // 3. Ask Claude to read the PDF and return structured fields.
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_import_document' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: buildPrompt(supplierNames, itemRows) },
        ],
      }],
    })

    const toolUse = message.content.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      await markError(documentId, 'No data extracted from the document.')
      return NextResponse.json({ error: 'No data extracted from the document.' }, { status: 400 })
    }
    const extracted = toolUse.input as Record<string, unknown>

    // 4. Save the extraction for review and record the detected type.
    const docType = typeof extracted.doc_type === 'string' ? extracted.doc_type : 'other'
    await supabaseAdmin.from('import_documents')
      .update({ extracted, doc_type: docType, status: 'Review', error_message: null })
      .eq('id', documentId)

    return NextResponse.json({ success: true, extracted })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    await markError(documentId, msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// Page past the 1000-row default so the whole item master is available to match.
async function fetchAllItems(): Promise<KnownItem[]> {
  const all: KnownItem[] = []
  let from = 0
  const size = 1000
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('items').select('code, description').order('code').range(from, from + size - 1)
    if (error || !data || data.length === 0) break
    all.push(...data.map(d => ({ code: d.code as string, description: (d.description as string) || '' })))
    if (data.length < size) break
    from += size
  }
  return all
}

async function markError(documentId: string, msg: string) {
  await supabaseAdmin.from('import_documents')
    .update({ status: 'Error', error_message: msg }).eq('id', documentId)
}
