import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Keep the login persistent (esp. iOS Home-Screen app): store the session and
// keep refreshing the token so the app doesn't log itself out.
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

// Fetch ALL rows from a table, paging past Supabase's 1000-row default limit.
// `orderByOrModify` may be a column name to order by, or a function that adds
// filters/ordering to the query (e.g. q => q.gt('qty', 0).order('exp_date')).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryModify = (q: any) => any
export async function fetchAll<T = Record<string, unknown>>(table: string, columns: string, orderByOrModify?: string | QueryModify): Promise<T[]> {
  const all: T[] = []
  let from = 0
  const size = 1000
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase.from(table).select(columns)
    if (typeof orderByOrModify === 'string') q = q.order(orderByOrModify)
    else if (orderByOrModify) q = orderByOrModify(q)
    const { data, error } = await q.range(from, from + size - 1)
    if (error || !data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < size) break
    from += size
  }
  return all
}
