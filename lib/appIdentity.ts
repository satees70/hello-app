// Each subdomain is its own installable app (separate origin). This gives each one a distinct
// identity — name, home page, colour and icon — so, installed on a phone, the Warehouse app and
// the Production app are clearly separate, not two identical "EASWARI" tiles.
export type AppId = { key: string; name: string; short: string; start: string; theme: string; icon: string }

export function appForHost(host: string | null | undefined): AppId {
  const h = (host || '').toLowerCase()
  if (h.startsWith('warehouse.')) return { key: 'warehouse', name: 'EASWARI Warehouse', short: 'Warehouse', start: '/warehouse', theme: '#047857', icon: '/icon-warehouse.svg' }
  if (h.startsWith('hr.'))        return { key: 'hr',        name: 'EASWARI HR',        short: 'HR',        start: '/hr/attendance', theme: '#7c3aed', icon: '/icon-hr.svg' }
  if (h.startsWith('driver.'))    return { key: 'driver',    name: 'EASWARI Driver',    short: 'Driver',    start: '/driver/today',  theme: '#b45309', icon: '/icon-driver.svg' }
  if (h.startsWith('import.'))    return { key: 'import',    name: 'EASWARI Import',    short: 'Import',    start: '/import',        theme: '#0e7490', icon: '/icon-import.svg' }
  // production subdomain and the bare portal
  return { key: 'production', name: 'EASWARI Production', short: 'EASWARI', start: '/dashboard', theme: '#1d4ed8', icon: '/icon.svg' }
}
