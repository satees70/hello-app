// Minimal server-side error logging so failed API mutations are visible in the
// Vercel function logs (previously most routes returned a JSON error but logged
// nothing, so failures were invisible unless the caller inspected the response).
export function logError(context: string, err: unknown, extra?: Record<string, unknown>) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err)
  const tail = extra ? ' ' + JSON.stringify(extra) : ''
  console.error(`[error] ${context}${tail}\n${detail}`)
}

// Shared cap for user-uploaded documents we base64 + send to the model.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024   // 15 MB
