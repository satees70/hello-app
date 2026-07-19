import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { appForHost } from '@/lib/appIdentity'

// Per-subdomain manifest, so each app installs with its own name / icon / home page and shows as
// a separate app on the phone (Warehouse vs Production vs HR …). The subdomain requesting
// /manifest.webmanifest determines which one is returned.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const h = await headers()
  const app = appForHost(h.get('host'))
  return {
    id: `/app/${app.key}`,
    name: app.name,
    short_name: app.short,
    description: 'SRRI EASWARI MILLS',
    start_url: app.start,
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: app.theme,
    icons: [
      { src: app.icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: app.icon, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }
}
