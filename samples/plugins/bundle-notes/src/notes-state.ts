import { createServiceKey } from '@lite-ide/kernel'

/** Per-project sticky notes owned by the sample plugin. */
export interface NotesState {
  /** Snapshot of stored notes, oldest first. */
  notes: () => readonly string[]
  /** Subscribe to note mutations; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  addNote(text: string): void
  removeNote(index: number): void
}

export const NotesStateKey = createServiceKey<NotesState>('plugin.bundleNotes.notesState')

const STORAGE_PREFIX = 'lite-ide.sample.bundle-notes.'

export function createNotesState(projectId: string): NotesState {
  const storageKey = `${STORAGE_PREFIX}${projectId}`
  const listeners = new Set<() => void>()
  let current: string[] = readStorage()

  function readStorage(): string[] {
    try {
      const raw = localStorage.getItem(storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }

  function persist(): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify(current))
    } catch {
      // Quota / privacy errors: keep in-memory state working.
    }
    for (const listener of listeners) listener()
  }

  return {
    notes: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    addNote(text: string) {
      current = [...current, text]
      persist()
    },
    removeNote(index: number) {
      current = current.filter((_, i) => i !== index)
      persist()
    },
  }
}
