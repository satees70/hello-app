'use client'
import ProcessLog, { type Field } from '@/components/ProcessLog'

const fields: Field[] = [
  { key: 'month_year', label: 'Month / Year' },
  { key: 'record_date', label: 'Date', type: 'date', list: true },
  { key: 'product', label: 'Product / Raw Material', list: true },
  { key: 'rm_batch_no', label: 'Raw Material Batch No.', list: true },
  { key: 'product_batch_no', label: 'Product Batch No.', list: true },
  { key: 'qty_in', label: 'Qty in (kg)', type: 'number' },
  { key: 'qty_out', label: 'Qty out (kg)', type: 'number' },
  { key: 'machine', label: 'Machine name & condition' },
  { key: 'oven_temp', label: 'CCP1 Oven — Temp (°C)' },
  { key: 'oven_achieve_temp', label: 'Oven — starts at (°C, 30/60 min)' },
  { key: 'oven_time_start', label: 'Oven — time start', type: 'time' },
  { key: 'oven_time_finish', label: 'Oven — time finish', type: 'time' },
  { key: 'roast_temp', label: 'CCP4 Roasting — Temp (°C)' },
  { key: 'roast_achieve_temp', label: 'Roasting — starts at (°C, 30/60 min)' },
  { key: 'roast_time_start', label: 'Roasting — time start', type: 'time' },
  { key: 'roast_time_finish', label: 'Roasting — time finish', type: 'time' },
  { key: 'moisture_before', label: 'Moisture % — before' },
  { key: 'moisture_after', label: 'Moisture % — after' },
  { key: 'done_by', label: 'Done by', list: true },
  { key: 'verified_by', label: 'Verified by' },
  { key: 'remark', label: 'Remark / Corrective action', wide: true },
]

export default function Page() {
  return <ProcessLog table="drying_roasting_records" moduleKey="production"
    title="Oven Drying & Roasting Inspection" subtitle="Controlled form P07-F05 (CCP1 Oven Drying · CCP4 Roasting)." fields={fields} />
}
