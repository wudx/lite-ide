/**
 * Extracts a human-readable message from JS Errors, plain strings, or
 * serialized Tauri `AppError` objects (`{ code, message, detail? }`).
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message
    }
    if (typeof record.detail === 'string' && record.detail.trim()) {
      return record.detail
    }
    try {
      return JSON.stringify(err) ?? String(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}
