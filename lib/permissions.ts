// Per-section user permissions (view / edit / delete).
// Stored on profiles.permissions as jsonb:
//   { "sales": { "view": true, "edit": true, "delete": false }, ... }

// `group` clusters sections the way the menu does, so the permission grid is easy
// to scan. `needsApproval: true` means a factory user's Edit there doesn't change
// things directly — it submits a request Head Office approves (HO edits apply at once).
export const PERMISSION_MODULES = [
  { key: 'sales', label: 'Sales orders', desc: 'Upload & view sales orders', group: 'Sales', needsApproval: true },
  { key: 'dispatch', label: 'Delivery orders', desc: 'Send finished goods to warehouse & return raw materials', group: 'Sales', needsApproval: false },
  { key: 'changes', label: 'Pending changes', desc: 'See & approve change requests', group: 'Sales', needsApproval: false },
  { key: 'material_requests', label: 'Material requests', desc: 'Request materials from the warehouse', group: 'Receiving', needsApproval: true },
  { key: 'goods_received', label: 'Goods received', desc: 'Receive deliveries into stock', group: 'Receiving', needsApproval: true },
  { key: 'order_board', label: 'Order board', desc: 'Production batches & planning', group: 'Production', needsApproval: true },
  { key: 'packing', label: 'Packing schedule', desc: 'What to pack, by line & date', group: 'Production', needsApproval: false },
  { key: 'inspection', label: 'Inspection', desc: 'Finished-good QC (P07-F01)', group: 'Production', needsApproval: false },
  { key: 'drying', label: 'Drying & roasting', desc: 'Oven drying & roasting (P07-F05)', group: 'Production', needsApproval: false },
  { key: 'moisture', label: 'Moisture', desc: 'Moisture content reading (P07-F08)', group: 'Production', needsApproval: false },
  { key: 'oprp', label: 'OPRP', desc: 'OPRP record (P07-F03)', group: 'Production', needsApproval: false },
  { key: 'grinding', label: 'Grinding', desc: 'Grinding & mixing record / QC (P07-F10)', group: 'Production', needsApproval: false },
  { key: 'grinding_recipe', label: 'Grinding recipe', desc: 'Raw-material mixture / formula (secret)', group: 'Production', needsApproval: false },
  { key: 'stock', label: 'Stock', desc: 'Stock on hand', group: 'Reports', needsApproval: false },
  { key: 'stock_adjustment', label: 'Stock adjustment', desc: 'Manual stock in/out (HOD approval)', group: 'Reports', needsApproval: true },
  { key: 'traceability', label: 'Traceability', desc: 'Recall report', group: 'Reports', needsApproval: false },
  { key: 'items', label: 'Items', desc: 'Items master', group: 'Setup', needsApproval: true },
  { key: 'bom', label: 'BOM', desc: 'Bill of materials', group: 'Setup', needsApproval: false },
  { key: 'packing_lines', label: 'Packing lines', desc: 'Maintain the list of packing lines', group: 'Setup', needsApproval: false },
  { key: 'users', label: 'Users', desc: 'User management', group: 'Setup', needsApproval: false },
] as const

// Sections that are HIDDEN by default — a user sees them ONLY if explicitly
// granted (the opposite of the normal "open unless restricted" rule). Used for
// sensitive processes like Grinding that most staff shouldn't see.
export const RESTRICTED_MODULES: ModuleKey[] = ['grinding', 'grinding_recipe']

// Fine-grained "special" capabilities the admin can tick/untick per user, on top
// of the section grid. Each is allowed by default (legacy behaviour) unless the
// admin explicitly turns it OFF for that user. They are AND-ed with the normal
// section/factory checks — turning one off hides that action even if the user can
// otherwise edit the section.
export const CAPABILITIES = [
  { key: 'so_edit', label: 'Edit pick-run SO number', desc: 'Enter & change the SO number on a released pick run' },
  { key: 'move_received_qty', label: 'Move received quantity', desc: 'Shift received qty between material requests (HO approves)' },
  { key: 'request_mr_cancel', label: 'Request material-request cancel', desc: 'Ask to cancel a material request / released pick run' },
  { key: 'request_doc_delete', label: 'Request sales-document delete', desc: 'Ask Head Office to delete a Sales Order document' },
  { key: 'request_item_change', label: 'Request item-master change', desc: 'Edit item fields (sent to Head Office for approval)' },
  { key: 'request_return_edit', label: 'Edit material return', desc: 'Change a recorded raw-material return (HO approves)' },
  { key: 'request_split', label: 'Request batch split / un-combine', desc: 'Split or un-combine a production batch (Order Board)' },
  { key: 'request_run_mode', label: 'Request run-mode change', desc: 'Change Auto / Manual run mode (Order Board)' },
] as const
export type CapabilityKey = typeof CAPABILITIES[number]['key']

// Is this capability allowed for the user? Allowed unless explicitly set false.
export function hasCap(
  profile: { role?: string; capabilities?: Record<string, boolean> | null } | null | undefined,
  cap: CapabilityKey,
): boolean {
  if (!profile) return false
  if (profile.role === 'admin') return true
  if (!profile.capabilities) return true   // never configured → legacy allow
  return profile.capabilities[cap] !== false
}
export function defaultCaps(): Record<string, boolean> {
  const c: Record<string, boolean> = {}
  for (const cap of CAPABILITIES) c[cap.key] = true
  return c
}

export type ModuleKey = typeof PERMISSION_MODULES[number]['key']
export type Action = 'view' | 'edit' | 'delete'
export type ModulePerm = { view?: boolean; edit?: boolean; delete?: boolean }
export type Permissions = Record<string, ModulePerm>
// Optional per-location overrides: factory_code -> its own grid. A location without
// an override falls back to the default grid (+ view-only list).
export type LocationPerms = Record<string, Permissions>

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
  profile: { role?: string; permissions?: Permissions | null; readonly_factories?: string[] | null; location_perms?: LocationPerms | null } | null | undefined,
  module: ModuleKey,
  action: Action,
  factoryCode?: string,   // pass a record's factory to honour per-location rules
): boolean {
  if (!profile) return false
  if (profile.role === 'admin') return true
  // Per-location override wins when we know the record's location and one is set.
  const ov = factoryCode ? profile.location_perms?.[factoryCode] : undefined
  if (ov && ov[module]) return !!ov[module][action]
  // View-only at certain factories: the user may see records there but not edit/delete them.
  if (action !== 'view' && factoryCode && (profile.readonly_factories || []).includes(factoryCode)) return false
  // Restricted sections need an explicit grant (no legacy-full default).
  if (!isConfigured(profile.permissions)) return !RESTRICTED_MODULES.includes(module)
  return !!profile.permissions?.[module]?.[action]
}
