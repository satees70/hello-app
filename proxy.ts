import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Subdomain landing pages (Next.js "proxy" = the renamed middleware).
// Opens the right app at the ROOT of each subdomain:
//   hr.srrieaswari.com/        → /hr/attendance
//   driver.srrieaswari.com/    → /driver/today
//   import.srrieaswari.com/    → /import
//   warehouse.srrieaswari.com/ → /warehouse
// Only the root path is rewritten (see config.matcher); every other path
// (/hr/*, /driver/*, /import/*, /warehouse, /login, /api, production.srrieaswari.com)
// is untouched. The warehouse-only menu is applied in the Navbar by host.
export function proxy(request: NextRequest) {
  const host = request.headers.get('host') || ''
  const { pathname } = request.nextUrl
  const isHr = host.startsWith('hr.')
  const isDriver = host.startsWith('driver.')
  const isImport = host.startsWith('import.')
  const isWarehouse = host.startsWith('warehouse.')
  if (!isHr && !isDriver && !isImport && !isWarehouse) return NextResponse.next()

  const appHome = isHr ? '/hr/attendance' : isDriver ? '/driver/today' : isImport ? '/import' : '/warehouse'

  // Root → serve the app (clean URL via rewrite).
  if (pathname === '/') {
    const url = request.nextUrl.clone()
    url.pathname = appHome
    return NextResponse.rewrite(url)
  }
  // Portal home/dashboard on a subdomain → bounce to the app.
  if (pathname === '/dashboard') {
    const url = request.nextUrl.clone()
    url.pathname = appHome
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/dashboard'],
}
