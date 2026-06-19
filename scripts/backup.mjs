import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

// Read Supabase credentials from .env.local (run from the hello-app folder)
const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const tables = [
  // master / setup (kept) — backed up too, just in case
  'items', 'bom_components', 'customers', 'factories', 'location_map', 'profiles',
  'allowed_networks', 'app_config', 'grinding_recipes', 'grinding_recipe_components',
  // transactional (about to be wiped)
  'sales_imports', 'sales_order_lines', 'change_requests', 'document_confirmations',
  'production_batches', 'production_batch_items', 'production_consumption',
  'material_requests', 'material_request_items', 'stock_lots', 'item_stock',
  'delivery_orders', 'delivery_order_lines', 'do_change_requests', 'inspection_records',
  'grinding_records', 'grinding_materials', 'drying_roasting_records', 'moisture_records',
  'oprp_records', 'correction_requests',
]

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
const dir = path.join(process.env.HOME, 'Downloads', `easwari_backup_${stamp}`)
fs.mkdirSync(dir, { recursive: true })

const summary = {}
for (const t of tables) {
  const all = []
  let from = 0
  for (;;) {
    const { data, error } = await sb.from(t).select('*').range(from, from + 999)
    if (error) { summary[t] = 'ERROR: ' + error.message; break }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  if (summary[t] === undefined) {
    fs.writeFileSync(path.join(dir, t + '.json'), JSON.stringify(all, null, 2))
    summary[t] = all.length
  }
}
fs.writeFileSync(path.join(dir, '_summary.json'), JSON.stringify(summary, null, 2))
console.log('Backup folder:', dir)
console.log(JSON.stringify(summary, null, 2))
