// Per-section user permissions (view / edit / delete).
// Stored on profiles.permissions as jsonb:
//   { "sales": { "view": true, "edit": true, "delete": false }, ... }

export const PERMISSION_MODULES = [
  { key: 'sales', label: 'Sales orders', desc: 'Upload & view sales orders' },
  { key: 'dispatch', label: 'Delivery orders', desc: 'Send finished goods to warehouse & return raw materials' },
  { key: 'changes', label: 'Pending changes', desc: 'Change-request approvals & status' },
  { key: 'order_board', label: 'Order board', desc: 'Production batches & planning' },
  { key: 'packing', label: 'Packing schedule', desc: 'What to pack, by line & date' },
  { key: 'packing_lines', label: 'Packing lines', desc: 'Maintain the list of packing lines' },
  { key: 'inspection', label: 'Inspection', desc: 'Finished-good QC (P07-F01)' },
  { key: 'drying', label: 'Drying & roasting', desc: 'Oven drying & roasting (P07-F05)' },
  { key: 'moisture', label: 'Moisture', desc: 'Moisture content reading (P07-F08)' },
  { key: 'oprp', label: 'OPRP', desc: 'OPRP record (P07-F03)' },
  { key: 'grinding', label: 'Grinding', desc: 'Grinding & mixing record / QC (P07-F10)' },
  { key: 'grinding_recipe', label: 'Grinding recipe', desc: 'Raw-material mixture / formula (secret)' },
  { key: 'material_requests', label: 'Material requests', desc: 'Request materials from the warehouse' },
  { key: 'goods_received', label: 'Goods received', desc: 'Receive deliveries into stock' },
  { key: 'stock', label: 'Stock', desc: 'Stock on hand' },
  { key: 'stock_adjustment', label: 'Stock adjustment', desc: 'Manual stock in/out (HOD approval)' },
  { key: 'items', label: 'Items', desc: 'Items master' },
  { key: 'bom', label: 'BOM', desc: 'Bill of materials' },
  { key: 'traceability', label: 'Traceability', desc: 'Recall report' },
  { key: 'users', label: 'Users', desc: 'User management' },
] as const

// Sections that are HIDDEN by default — a user sees them ONLY if explicitly
// granted (the opposite of the normal "open unless restricted" rule). Used for
// sensitive processes like Grinding that most staff shouldn't see.
export const RESTRICTED_MODULES: ModuleKey[] = ['grinding', 'grinding_recipe']

export type ModuleKey = typeof PERMISSION_MODULES[number]['key']
export type Action = 'view' | 'edit' | 'delete'
export type ModulePerm = { view?: boolean; edit?: boolean; delete?: boolean }
export type Permissions = Record<string, ModulePerm>

// Sensible starting grid for a user who has never been configured: can view &
// edit everything (matching today's behaviour), but cannot delete. Head Office
// then tightens or loosens from here.
export function defaultGrid(): Permissions {
  const g: Permissions = {}
  for (const m of PERMISSION_MODULES) {
    g[m.key] = RESTRICTED_MODULES.includes(m.key)
      ? { view: false, edit: false, delete: false }   // restricted sections start OFF
      : { view: true, edit: true, delete: false }
  }
  return g
}

// Has this profile been given an explicit permission grid yet?
export function isConfigured(perms: Permissions | null | undefined): boolean {
  return !!perms && Object.keys(perms).length > 0
}

// Can this profile perform `action` in `module`?
//  - admins: always
//  - not-yet-configured (empty {}): legacy full access (don't break existing users)
//  - otherwise: the explicit tick (delete implies nothing; each action is independent)
export function can(
  profile: { role?: string; permissions?: Permissions | null; readonly_factories?: string[] | null } | null | undefined,
  module: ModuleKey,
  action: Action,
  factoryCode?: string,   // pass a record's factory to honour per-factory view-only
): boolean {
  if (!profile) return false
  if (profile.role === 'admin') return true
  // View-only at certain factories: the user may see records there but not edit/delete them.
  if (action !== 'view' && factoryCode && (profile.readonly_factories || []).includes(factoryCode)) return false
  // Restricted sections need an explicit grant (no legacy-full default).
  if (!isConfigured(profile.permissions)) return !RESTRICTED_MODULES.includes(module)
  return !!profile.permissions?.[module]?.[action]
}
