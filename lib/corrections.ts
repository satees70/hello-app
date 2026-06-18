import { supabase } from './supabase'

// Raise a "cancel this timer" request → goes to Pending Changes for HO approval.
// Returns: null if the user cancelled the prompt, '' on success, or an error message.
export async function requestTimerCancel(p: {
  table: string; record_id: string; timer_key: string; label: string; factory_code: string; requested_by_name?: string
}): Promise<string | null> {
  const reason = window.prompt(`Request to cancel "${p.label}".\nReason (sent to Head Office):`)
  if (reason === null) return null
  const { data: sess } = await supabase.auth.getSession()
  const { error } = await supabase.from('correction_requests').insert({
    table_name: p.table, record_id: p.record_id, timer_key: p.timer_key, label: p.label,
    reason: reason || null, factory_code: p.factory_code,
    requested_by: sess.session?.user.id || null, requested_by_name: p.requested_by_name || null,
  })
  return error ? error.message : ''
}
