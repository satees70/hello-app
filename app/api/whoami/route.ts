import { NextResponse } from 'next/server'

// Returns the caller's public IP (as seen by the server/Vercel edge).
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const xff = request.headers.get('x-forwarded-for') || ''
  const ip = xff.split(',')[0].trim() || request.headers.get('x-real-ip') || ''
  return NextResponse.json({ ip })
}
