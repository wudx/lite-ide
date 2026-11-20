/** Copies text to the system clipboard. Prefers the async Clipboard API and
 *  falls back to a hidden-textarea `execCommand` copy for non-secure contexts
 *  (e.g. Tauri's `http://tauri.localhost` origin on Windows). */
export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall through to the legacy copy path
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}
