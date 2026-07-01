import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Subdomain landing pages (Next.js "proxy" = the renamed middleware).
// Opens the right app at the ROOT of each subdomain:
//   hr.srrieaswari.com/     → /hr/attendance
//   driver.srrieaswari.com/ → /driver/today
// Only the root path is rewritten (see config.matcher); every other path
// (/hr/*, /driver/*, /login, /api, production.srrieaswari.com) is untouched.
export function proxy(request: NextRequest) {
  const host = request.headers.get('host') || ''
  const url = request.nextUrl.clone()

  if (host.startsWith('hr.')) {
    url.pathname = '/hr/attendance'
    return NextResponse.rewrite(url)
  }
  if (host.startsWith('driver.')) {
    url.pathname = '/driver/today'
    return NextResponse.rewrite(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/',
}
