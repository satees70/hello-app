'use client'
import ProcessLog, { type Field } from '@/components/ProcessLog'

const GOOD_BROKEN = ['Good', 'Broken']
const fields: Field[] = [
  { key: 'month_year', label: 'Month / Year' },
  { key: 'record_date', label: 'Date', type: 'date', list: true },
  { key: 'product', label: 'Product / Raw Material', type: 'item', list: true },
  { key: 'batch_no_old', label: 'Batch No. (old)', list: true },
  { key: 'batch_no_new', label: 'Batch No. (new) / Assembly No.' },
  { key: 'taken_qty', label: 'Taken Qty In (kg)', type: 'number' },
  { key: 'out_qty', label: 'Out Qty (kg)', type: 'number' },
  { key: 'process_timer', label: 'Process time — in/out (click Start/Finish)', type: 'timer', startKey: 'time_in', finishKey: 'time_out', cancelKey: 'oprp_process', wide: true },
  { key: 'machine', label: 'Machine name' },
  { key: 'machine_before', label: 'Machine cond. — before' },
  { key: 'machine_after', label: 'Machine cond. — after' },
  { key: 'sieve_size', label: 'Sieve size' },
  { key: 'sieve_before', label: 'OPRP2 Sieve — before', type: 'select', options: GOOD_BROKEN },
  { key: 'sieve_after', label: 'OPRP2 Sieve — after', type: 'select', options: GOOD_BROKEN },
  { key: 'weight_residue', label: 'Weight residue (Balance/Rework)', type: 'number' },
  { key: 'weight_waste', label: 'Weight of waste', type: 'number' },
  { key: 'handpick_result', label: 'OPRP1 Handpicking', type: 'select', options: ['Pass', 'Fail'] },
  { key: 'visual_result', label: 'OPRP2 Visual / Colour / Odour', type: 'select', options: ['Pass', 'Fail'] },
  { key: 'needle_condition', label: 'OPRP3 Needle condition', type: 'select', options: GOOD_BROKEN },
  { key: 'seal_integrity', label: 'Seal integrity', type: 'select', options: ['Good', 'Open'] },
  { key: 'done_by', label: 'Done by', list: true },
  { key: 'verified_by', label: 'Verified by' },
  { key: 'remark', label: 'Remarks / Corrective action', wide: true },
]

export default function Page() {
  return <ProcessLog table="oprp_records" moduleKey="production"
    title="OPRP Record" subtitle="Controlled form P07-F03 · Handpicking (OPRP1), Sieving/Visual (OPRP2), Needle/Seal (OPRP3)." fields={fields} />
}
