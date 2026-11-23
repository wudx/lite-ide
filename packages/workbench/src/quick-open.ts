import { createServiceKey } from '@lite-ide/kernel'
import type { WorkspaceBackend } from '@lite-ide/protocol'
import { createSignal, type Accessor } from 'solid-js'

export interface QuickOpenService {
  readonly isOpen: Accessor<boolean>
  open(): void
  close(): void
}

export const QuickOpenKey = createServiceKey<QuickOpenService>('workbench.quickOpen')

export function createQuickOpenService(): QuickOpenService {
  const [isOpen, setIsOpen] = createSignal(false)

  return {
    isOpen,
    open() {
      setIsOpen(true)
    },
    close() {
      setIsOpen(false)
    },
  }
}

export interface QuickOpenFileEntry {
  relPath: string
  name: string
  modifiedMs: number
  size?: number
}

export interface BuildFileIndexOptions {
  /** Include gitignored entries (still skips `.git` and `node_modules`). */
  includeIgnored?: boolean
  /** Hard cap on collected file entries; defaults to `QUICK_OPEN_MAX_FILES`. */
  maxFiles?: number
}

/** Hard cap so a pathological tree can never hang the indexer forever. */
export const QUICK_OPEN_MAX_FILES = 20000

const SKIP_DIR_NAMES = new Set(['node_modules', '.git'])

/** Directories listed concurrently per wave. */
export const WALK_CONCURRENCY = 8

export interface QuickOpenIndexResult {
  files: QuickOpenFileEntry[]
  /**
   * Directories (other than the root) whose listing failed. A non-zero count
   * means the index may be incomplete; callers should avoid caching it.
   */
  failedDirCount: number
}

/**
 * Recursively collect project files via the workspace backend.
 * Directories load lazily through `listDir`, so the walk proceeds
 * breadth-first in bounded chunks of `WALK_CONCURRENCY` calls. Entries
 * flagged `ignored` (gitignored) are skipped, matching VSCode's quick-open
 * behavior. Throws when the root directory itself cannot be listed.
 */
export async function buildFileIndex(
  backend: WorkspaceBackend,
  projectId: string,
  options: BuildFileIndexOptions = {},
): Promise<QuickOpenIndexResult> {
  const includeIgnored = options.includeIgnored ?? false
  const maxFiles = options.maxFiles ?? QUICK_OPEN_MAX_FILES
  const files: QuickOpenFileEntry[] = []
  let failedDirCount = 0
  const queue: string[] = ['']

  while (queue.length > 0) {
    const batch = queue.splice(0, WALK_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (dirPath) => {
        try {
          return { dirPath, entries: await backend.listDir(projectId, dirPath), failed: false }
        } catch (err) {
          if (dirPath === '') throw err
          // Unreadable subdirectory: skip it, the rest of the tree still indexes.
          return { dirPath, entries: [], failed: true }
        }
      }),
    )

    for (const { entries, failed } of results) {
      if (failed) {
        failedDirCount += 1
        continue
      }
      for (const entry of entries) {
        if (!includeIgnored && entry.ignored) continue
        if (entry.isDir) {
          if (!SKIP_DIR_NAMES.has(entry.name)) {
            queue.push(entry.relPath)
          }
          continue
        }
        if (files.length < maxFiles) {
          files.push({
            relPath: entry.relPath,
            name: entry.name,
            modifiedMs: entry.modifiedMs,
            size: entry.size,
          })
        }
      }
    }
    if (files.length >= maxFiles) {
      queue.length = 0
    }
  }

  return { files, failedDirCount }
}

const BOUNDARY_CHARS = new Set(['/\\._- '])

export interface QuickOpenMatchIndices {
  score: number
  /** Character indices of the query inside the lowercased relPath. */
  indices: number[]
}

/**
 * Greedy left-to-right subsequence alignment of `queryLower` inside
 * `pathLower`, starting at `start`. Returns null when the remainder of the
 * path cannot host the whole query.
 */
function alignSubsequence(
  pathLower: string,
  queryLower: string,
  start: number,
): QuickOpenMatchIndices | null {
  const indices: number[] = []
  let score = 0
  let cursor = start
  for (let qi = 0; qi < queryLower.length; qi += 1) {
    const ch = queryLower[qi]
    let found = -1
    for (let pi = cursor; pi < pathLower.length; pi += 1) {
      if (pathLower[pi] === ch) {
        found = pi
        break
      }
    }
    if (found === -1) return null
    const boundary = found === 0 || BOUNDARY_CHARS.has(pathLower[found - 1])
    const consecutive = indices.length > 0 && found === indices[indices.length - 1] + 1
    score += 2
    if (consecutive) score += 5
    if (boundary) score += pathLower[found - 1] === '/' ? 5 : 4
    indices.push(found)
    cursor = found + 1
  }
  return { score, indices }
}

/**
 * Score how well `query` matches `relPath` as a case-insensitive subsequence.
 * Null when the query is not a subsequence. Higher scores win; consecutive and
 * word-boundary matches are preferred, shorter paths break ties. Two greedy
 * alignments are tried (from the path start and from the basename start) and
 * the better one wins, so a query character shared with a directory name
 * cannot starve the basename of its first match.
 */
export function scoreQuickOpenMatch(relPath: string, query: string): QuickOpenMatchIndices | null {
  const pathLower = relPath.toLowerCase()
  const queryLower = query.toLowerCase()
  if (queryLower.length === 0) return null
  if (queryLower.length > pathLower.length) return null

  const nameStart = pathLower.lastIndexOf('/') + 1
  const fromStart = alignSubsequence(pathLower, queryLower, 0)
  const fromName = nameStart > 0 ? alignSubsequence(pathLower, queryLower, nameStart) : null
  const best =
    fromName && (!fromStart || fromName.score > fromStart.score) ? fromName : fromStart
  if (!best) return null

  // Matching entirely inside the basename is a strong signal (VSCode-style).
  if (best.indices[0] >= nameStart) {
    best.score += 8
    if (pathLower.slice(nameStart).startsWith(queryLower)) best.score += 6
  }

  // Prefer shallower paths when scores are otherwise close.
  best.score -= relPath.length * 0.05
  return best
}

export interface QuickOpenResult {
  entry: QuickOpenFileEntry
  score: number
  indices: number[]
}

/** Result cap for the rendered list; the palette scrolls instead of paginating. */
export const QUICK_OPEN_MAX_RESULTS = 50

/**
 * Filter + rank the index against the query. Empty query returns recent files
 * first (by modification time), then the rest of the index in walk order.
 */
export function searchQuickOpen(
  files: readonly QuickOpenFileEntry[],
  query: string,
  limit = QUICK_OPEN_MAX_RESULTS,
): QuickOpenResult[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    const indexed = files.map((entry, order) => ({ entry, order }))
    indexed.sort((a, b) => b.entry.modifiedMs - a.entry.modifiedMs || a.order - b.order)
    return indexed.slice(0, limit).map(({ entry }) => ({ entry, score: 0, indices: [] }))
  }

  const results: QuickOpenResult[] = []
  for (const entry of files) {
    const match = scoreQuickOpenMatch(entry.relPath, trimmed)
    if (match) {
      results.push({ entry, score: match.score, indices: match.indices })
    }
  }
  results.sort((a, b) => b.score - a.score || a.entry.relPath.localeCompare(b.entry.relPath))
  return results.slice(0, limit)
}
