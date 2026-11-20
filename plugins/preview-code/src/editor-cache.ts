import type { EditorState } from '@codemirror/state'
import { createServiceKey } from '@lite-ide/kernel'

export interface CachedEditorState {
  state: EditorState
  scrollTop: number
  scrollLeft: number
  diskRevision: number
}

export interface CodeEditorCacheService {
  get(relPath: string): CachedEditorState | undefined
  set(relPath: string, entry: CachedEditorState): void
  delete(relPath: string): void
  renamePaths(oldRelPath: string, newRelPath: string, isDir: boolean): void
  removePaths(relPath: string, isDir: boolean): void
  clear(): void
}

export const CodeEditorCacheKey = createServiceKey<CodeEditorCacheService>(
  'plugin.previewCode.editorCache',
)

function remapPath(target: string, oldRelPath: string, newRelPath: string, isDir: boolean): string | null {
  if (target === oldRelPath) return newRelPath
  if (isDir) {
    const prefix = `${oldRelPath}/`
    if (target.startsWith(prefix)) {
      return `${newRelPath}/${target.slice(prefix.length)}`
    }
  }
  return null
}

function matchesPath(target: string, relPath: string, isDir: boolean): boolean {
  if (target === relPath) return true
  if (isDir && target.startsWith(`${relPath}/`)) return true
  return false
}

export function createCodeEditorCacheService(): CodeEditorCacheService {
  const cache = new Map<string, CachedEditorState>()

  return {
    get(relPath: string) {
      return cache.get(relPath)
    },

    set(relPath: string, entry: CachedEditorState) {
      cache.set(relPath, entry)
    },

    delete(relPath: string) {
      cache.delete(relPath)
    },

    renamePaths(oldRelPath: string, newRelPath: string, isDir: boolean) {
      for (const [path, entry] of [...cache]) {
        const mapped = remapPath(path, oldRelPath, newRelPath, isDir)
        if (mapped && mapped !== path) {
          cache.delete(path)
          cache.set(mapped, entry)
        }
      }
    },

    removePaths(relPath: string, isDir: boolean) {
      for (const path of [...cache.keys()]) {
        if (matchesPath(path, relPath, isDir)) {
          cache.delete(path)
        }
      }
    },

    clear() {
      cache.clear()
    },
  }
}
