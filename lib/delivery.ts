import { supabase } from './supabase'

// "Now" as a Date whose local fields read in Malaysia time, regardless of the device's timezone.
// (The whole business runs on Malaysia time even if a file is uploaded/viewed from elsewhere.)
function malaysiaNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }))
}
function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// Malaysia-time YYYY-MM-DD for today / tomorrow (delivery_date is a plain date).
export function todayISO(): string {
  return fmtISO(malaysiaNow())
}
export function tomorrowISO(): string {
  const d = malaysiaNow(); d.setDate(d.getDate() + 1)
  return fmtISO(d)
}

// SO numbers scheduled for delivery tomorrow — used to show the TOMORROW DELIVERY tag.
export async function fetchTomorrowDeliverySOs(): Promise<Set<string>> {
  const { data } = await supabase.from('delivery_schedule').select('so_number').eq('delivery_date', tomorrowISO())
  return new Set((data || []).map(r => r.so_number).filter(Boolean) as string[])
}
