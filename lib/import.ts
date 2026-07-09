// Shared types + helpers for the Import Shipment Management section.
// The DB (db/2026-07-import-shipments.sql) is the source of truth; these types
// mirror those tables. Demurrage/detention day counts come from the
// import_container_charges view, so nothing is recomputed on the client.

export const IMPORT_STATUSES = [
  'Ordered', 'Shipped', 'In Transit', 'Arrived', 'Customs Cleared', 'Received',
] as const
export type ImportStatus = typeof IMPORT_STATUSES[number]

// Badge colours per status, so the list/detail read at a glance.
export const STATUS_STYLE: Record<string, string> = {
  'Ordered': 'bg-gray-100 text-gray-700',
  'Shipped': 'bg-blue-100 text-blue-700',
  'In Transit': 'bg-indigo-100 text-indigo-700',
  'Arrived': 'bg-amber-100 text-amber-700',
  'Customs Cleared': 'bg-teal-100 text-teal-700',
  'Received': 'bg-green-100 text-green-700',
}

export interface ImportSupplier {
  id: string; name: string; country: string | null; contact_person: string | null
  email: string | null; phone: string | null; active: boolean; notes: string | null
}
export interface ImportShipment {
  id: string; reference: string; supplier_id: string | null; status: string
  order_date: string | null; received_date: string | null
  destination_factory_code: string | null; notes: string | null
  created_by: string | null; created_by_name: string | null
  created_at: string; updated_at: string
}
export interface ImportBL {
  id: string; shipment_id: string; bl_number: string | null; shipping_line: string | null
  vessel: string | null; port_of_loading: string | null; port_of_discharge: string | null
  shipped_date: string | null; eta: string | null; arrival_date: string | null
  customs_cleared_date: string | null
  demurrage_free_days: number | null; detention_free_days: number | null; notes: string | null
}
export interface ImportContainer {
  id: string; shipment_id: string; bl_id: string | null; container_no: string | null
  container_type: string | null; available_date: string | null; gate_out_date: string | null
  empty_returned_date: string | null
  demurrage_free_days: number | null; detention_free_days: number | null; notes: string | null
}
export interface ImportItem {
  id: string; shipment_id: string; container_id: string | null; item_id: string | null
  item_code: string; description: string | null; unit: string | null
  quantity: number; declared_weight: number | null
}
export interface ContainerCharge {
  container_id: string; shipment_id: string; container_no: string | null
  demurrage_free_days: number; detention_free_days: number
  demurrage_days: number; detention_days: number
}

// dd/mm/yyyy for display (matches the rest of the portal); em-dash when blank.
export const fmtDate = (d: string | null | undefined) => d ? d.split('-').reverse().join('/') : '—'
// Trim a numeric to at most 3 decimals for display.
export const n3 = (x: number | null | undefined) => Number(Number(x || 0).toFixed(3))
