// Placeholder auth for the HR + Driver modules during local testing.
// ----------------------------------------------------------------------------
// TODO(auth): replace ALL of this with real Supabase Auth + role checks before
// launch. For now identity comes from request headers so the new routes can be
// exercised without a full login.
//
//   requireAdmin(request) — gates HR/admin endpoints. Returns null if allowed,
//     or a 401 NextResponse to short-circuit the handler. For local testing,
//     send header `x-admin: 1`, or set ALLOW_ALL=1 in .env.local to open
//     everything (dev only — never in production).
//   getDriverId(request)  — the signed-in driver's id for the driver app,
//     read from the `x-driver-id` header for now.

import { NextResponse } from 'next/server'

export function requireAdmin(request: Request): NextResponse | null {
  if (process.env.ALLOW_ALL === '1') return null
  if (request.headers.get('x-admin') === '1') return null
  return NextResponse.json(
    { error: 'Admin only (placeholder auth: send header x-admin: 1, or set ALLOW_ALL=1 for dev)' },
    { status: 401 },
  )
}

export function getDriverId(request: Request): string | null {
  return request.headers.get('x-driver-id')
}
