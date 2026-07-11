import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Subdomain landing pages (Next.js "proxy" = the renamed middleware).
// Opens the right app at the ROOT of each subdomain:
//   hr.srrieaswari.com/     → /hr/attendance
//   driver.srrieaswari.com/ → /driver/today
//   import.srrieaswari.com/ → /import
// Only the root path is rewritten (see config.matcher); every other path
// (/hr/*, /driver/*, /import/*, /login, /api, production.srrieaswari.com) is untouched.
export function proxy(request: NextRequest) {
  const host = request.headers.get('host') || ''
  const { pathname } = request.nextUrl
  const isHr = host.startsWith('hr.')
  const isDriver = host.startsWith('driver.')
  const isImport = host.startsWith('import.')
  if (!isHr && !isDriver && !isImport) return NextResponse.next()

  const appHome = isHr ? '/hr/attendance' : isDriver ? '/driver/today' : '/import'

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
