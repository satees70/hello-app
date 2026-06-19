'use client'
import ProcessLog, { type Field } from '@/components/ProcessLog'

const fields: Field[] = [
  { key: 'month_year', label: 'Month / Year' },
  { key: 'record_date', label: 'Date', type: 'date', list: true },
  { key: 'product', label: 'Product / Raw Material', type: 'item', list: true },
  { key: 'batch_no', label: 'Batch number', list: true },
  { key: 'sample_from', label: 'Sample collect from' },
  { key: 'product_desc', label: 'Describe of product' },
  { key: 'sample_prep', label: 'Sample preparation' },
  { key: 'weight_g', label: 'Weight (g)', type: 'number' },
  { key: 'time_min', label: 'Time (min)', type: 'number' },
  { key: 'moisture_pct', label: 'Moisture (%)', list: true },
  { key: 'checked_by', label: 'Checked by', list: true },
  { key: 'verified_by', label: 'Verified by' },
  { key: 'remarks', label: 'Remarks', wide: true },
]

export default function Page() {
  return <ProcessLog table="moisture_records" moduleKey="moisture"
    title="Moisture Content Reading" subtitle="Controlled form P07-F08 · Machine temp 130°C · Sample weight 3 ± 0.1 g." fields={fields} />
}
