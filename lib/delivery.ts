import { supabase } from './supabase'

// Local YYYY-MM-DD for "tomorrow" (delivery_date is a plain date).
export function tomorrowISO(): string {
  const d = new Date(); d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// SO numbers scheduled for delivery tomorrow — used to show the TOMORROW DELIVERY tag.
export async function fetchTomorrowDeliverySOs(): Promise<Set<string>> {
  const { data } = await supabase.from('delivery_schedule').select('so_number').eq('delivery_date', tomorrowISO())
  return new Set((data || []).map(r => r.so_number).filter(Boolean) as string[])
}
