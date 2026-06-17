// Per-section user permissions (view / edit / delete).
// Stored on profiles.permissions as jsonb:
//   { "sales": { "view": true, "edit": true, "delete": false }, ... }

export const PERMISSION_MODULES = [
  { key: 'sales', label: 'Sales', desc: 'Sales orders & change requests' },
  { key: 'production', label: 'Production', desc: 'Order board, packing, inspection' },
  { key: 'receiving', label: 'Receiving', desc: 'Material requests, goods received' },
  { key: 'stock', label: 'Stock', desc: 'Stock on hand' },
  { key: 'items', label: 'Items', desc: 'Items master' },
  { key: 'bom', label: 'BOM', desc: 'Bill of materials' },
  { key: 'traceability', label: 'Traceability', desc: 'Recall report' },
  { key: 'users', label: 'Users', desc: 'User management' },
] as const

export type ModuleKey = typeof PERMISSION_MODULES[number]['key']
export type Action = 'view' | 'edit' | 'delete'
export type ModulePerm = { view?: boolean; edit?: boolean; delete?: boolean }
export type Permissions = Record<string, ModulePerm>

// Sensible starting grid for a user who has never been configured: can view &
// edit everything (matching today's behaviour), but cannot delete. Head Office
// then tightens or loosens from here.
export function defaultGrid(): Permissions {
  const g: Permissions = {}
  for (const m of PERMISSION_MODULES) g[m.key] = { view: true, edit: true, delete: false }
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
  profile: { role?: string; permissions?: Permissions | null } | null | undefined,
  module: ModuleKey,
  action: Action,
): boolean {
  if (!profile) return false
  if (profile.role === 'admin') return true
  if (!isConfigured(profile.permissions)) return true
  return !!profile.permissions?.[module]?.[action]
}
