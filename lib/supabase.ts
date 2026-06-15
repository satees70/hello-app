import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseKey)

// Fetch ALL rows from a table, paging past Supabase's 1000-row default limit.
export async function fetchAll<T = Record<string, unknown>>(table: string, columns: string, orderBy?: string): Promise<T[]> {
  const all: T[] = []
  let from = 0
  const size = 1000
  for (;;) {
    let q = supabase.from(table).select(columns)
    if (orderBy) q = q.order(orderBy)
    const { data, error } = await q.range(from, from + size - 1)
    if (error || !data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < size) break
    from += size
  }
  return all
}
