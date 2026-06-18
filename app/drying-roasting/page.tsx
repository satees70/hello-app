'use client'
import ProcessLog, { type Field } from '@/components/ProcessLog'

const fields: Field[] = [
  { key: 'month_year', label: 'Month / Year' },
  { key: 'record_date', label: 'Date', type: 'date', list: true },
  { key: 'product', label: 'Product / Raw Material', type: 'item', list: true },
  { key: 'rm_batch_no', label: 'Batch before oven (e.g. 260606)', list: true },
  { key: 'product_batch_no', label: 'New batch after oven (e.g. 260606AH)', list: true },
  { key: 'qty_in', label: 'Qty in (kg) — taken from stock', type: 'number' },
  { key: 'qty_out', label: 'Qty out (kg) — back into stock', type: 'number' },
  { key: 'machine', label: 'Machine name & condition' },
  { key: 'oven_temp', label: 'CCP1 Oven — Temp (°C)' },
  { key: 'oven_achieve_temp', label: 'Oven — starts at (°C, 30/60 min)' },
  { key: 'oven_timer', label: 'Oven — drying time (click Start/Finish)', type: 'timer', startKey: 'oven_time_start', finishKey: 'oven_time_finish', cancelKey: 'drying_oven', wide: true },
  { key: 'roast_temp', label: 'CCP4 Roasting — Temp (°C)' },
  { key: 'roast_achieve_temp', label: 'Roasting — starts at (°C, 30/60 min)' },
  { key: 'roast_timer', label: 'Roasting — time (click Start/Finish)', type: 'timer', startKey: 'roast_time_start', finishKey: 'roast_time_finish', cancelKey: 'drying_roast', wide: true },
  { key: 'moisture_before', label: 'Moisture % — before' },
  { key: 'moisture_after', label: 'Moisture % — after' },
  { key: 'done_by', label: 'Done by', list: true },
  { key: 'verified_by', label: 'Verified by' },
  { key: 'remark', label: 'Remark / Corrective action', wide: true },
]

export default function Page() {
  return <ProcessLog table="drying_roasting_records" moduleKey="production"
    title="Oven Drying & Roasting Inspection" subtitle="Controlled form P07-F05 (CCP1 Oven Drying · CCP4 Roasting). Same item; after the oven it gets a new batch and the weight change moves stock."
    fields={fields}
    applyAction={{ rpc: 'process_drying_stock', flagField: 'stock_applied', label: 'Move to stock (apply weight change)', doneLabel: 'Stock moved' }} />
}
