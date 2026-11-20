/** Background/text tone per status letter (M/A/D/R/U/C); unknown letters render neutral. */
const STATUS_TONE: Record<string, string> = {
  M: 'bg-[var(--warning-bg)] text-[var(--warning-text)]',
  A: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  D: 'bg-[var(--danger-bg)] text-[var(--danger-text)]',
  R: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  U: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  C: 'bg-[var(--danger-bg)] text-[var(--danger-text)]',
}

export function statusTone(letter: string): string {
  return STATUS_TONE[letter] ?? 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]'
}
