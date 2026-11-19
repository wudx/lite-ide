import { createServiceKey } from '@lite-ide/kernel'
import type { DirEntry, FsDelta, WorkspaceBackend } from '@lite-ide/protocol'
import { createMemo, createSignal, type Accessor } from 'solid-js'

export interface FlatTreeNode {
  entry: DirEntry
  depth: number
  expanded: boolean
  loading: boolean
  parentPath: string
}

export interface FileTreeStore {
  readonly visibleNodes: Accessor<FlatTreeNode[]>
  readonly showIgnored: Accessor<boolean>
  readonly filterQuery: Accessor<string>
  readonly focusedPath: Accessor<string | null>
  readonly scrollOffset: Accessor<number>
  readonly rootLoading: Accessor<boolean>
  readonly error: Accessor<string | null>
  setShowIgnored(show: boolean): void
  toggleShowIgnored(): void
  setFilterQuery(query: string): void
  setFocusedPath(relPath: string | null): void
  setScrollOffset(offset: number): void
  ensureRootLoaded(): Promise<void>
  toggleDir(relPath: string): Promise<void>
  expandDir(relPath: string): Promise<void>
  collapseDir(relPath: string): void
  collapseAll(): void
  refreshDir(relPath: string): Promise<void>
  refreshAllExpanded(): Promise<void>
  handleFsDelta(delta: FsDelta): Promise<void>
}

export const FileTreeStoreKey = createServiceKey<FileTreeStore>('plugin.explorer.fileTreeStore')

export function createFileTreeStore(
  projectId: string,
  backend: WorkspaceBackend,
): FileTreeStore {
  const [childrenMap, setChildrenMap] = createSignal<Map<string, DirEntry[]>>(new Map())
  const [expandedSet, setExpandedSet] = createSignal<Set<string>>(new Set())
  const [loadingSet, setLoadingSet] = createSignal<Set<string>>(new Set())
  const [showIgnored, setShowIgnored] = createSignal(true)
  const [filterQuery, setFilterQuery] = createSignal('')
  const [focusedPath, setFocusedPath] = createSignal<string | null>(null)
  const [scrollOffset, setScrollOffset] = createSignal(0)
  const [rootLoading, setRootLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  let rootInitPromise: Promise<void> | null = null
  const dirLoadSeq = new Map<string, number>()

  async function loadDir(relPath: string): Promise<void> {
    const nextSeq = (dirLoadSeq.get(relPath) ?? 0) + 1
    dirLoadSeq.set(relPath, nextSeq)

    if (relPath === '') {
      setRootLoading(true)
    } else {
      setLoadingSet((prev) => {
        const next = new Set(prev)
        next.add(relPath)
        return next
      })
    }
    setError(null)

    try {
      const entries = await backend.listDir(projectId, relPath)
      if (dirLoadSeq.get(relPath) !== nextSeq) return
      setChildrenMap((prev) => {
        const next = new Map(prev)
        next.set(relPath, entries)
        return next
      })
    } catch (err) {
      if (dirLoadSeq.get(relPath) !== nextSeq) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (dirLoadSeq.get(relPath) === nextSeq) {
        if (relPath === '') {
          setRootLoading(false)
        } else {
          setLoadingSet((prev) => {
            const next = new Set(prev)
            next.delete(relPath)
            return next
          })
        }
      }
    }
  }

  const visibleNodes = createMemo<FlatTreeNode[]>(() => {
    const map = childrenMap()
    const expanded = expandedSet()
    const loading = loadingSet()
    const includeIgnored = showIgnored()
    const query = filterQuery().trim().toLowerCase()

    const result: FlatTreeNode[] = []

    const hasMatchingLoadedDescendant = (dirPath: string): boolean => {
      if (!expanded.has(dirPath)) return false
      const children = map.get(dirPath)
      if (!children) return false
      for (const child of children) {
        if (!includeIgnored && child.ignored) continue
        if (child.name.toLowerCase().includes(query)) return true
        if (child.isDir && hasMatchingLoadedDescendant(child.relPath)) return true
      }
      return false
    }

    const walk = (dirPath: string, depth: number) => {
      const entries = map.get(dirPath)
      if (!entries) return

      for (const entry of entries) {
        if (!includeIgnored && entry.ignored) continue

        if (query) {
          const selfMatch = entry.name.toLowerCase().includes(query)
          const childMatch = entry.isDir && hasMatchingLoadedDescendant(entry.relPath)
          if (!selfMatch && !childMatch) continue
        }

        const isExpanded = entry.isDir && expanded.has(entry.relPath)
        result.push({
          entry,
          depth,
          expanded: isExpanded,
          loading: entry.isDir && loading.has(entry.relPath),
          parentPath: dirPath,
        })

        if (isExpanded) {
          walk(entry.relPath, depth + 1)
        }
      }
    }

    walk('', 0)
    return result
  })

  return {
    visibleNodes,
    showIgnored,
    filterQuery,
    focusedPath,
    scrollOffset,
    rootLoading,
    error,
    setShowIgnored,
    toggleShowIgnored() {
      setShowIgnored((v) => !v)
    },
    setFilterQuery,
    setFocusedPath,
    setScrollOffset,

    async ensureRootLoaded() {
      if (childrenMap().has('')) return
      if (!rootInitPromise) {
        rootInitPromise = loadDir('').finally(() => {
          rootInitPromise = null
        })
      }
      await rootInitPromise
    },

    async expandDir(relPath: string) {
      setExpandedSet((prev) => {
        if (prev.has(relPath)) return prev
        const next = new Set(prev)
        next.add(relPath)
        return next
      })
      if (!childrenMap().has(relPath)) {
        await loadDir(relPath)
      }
    },

    collapseDir(relPath: string) {
      setExpandedSet((prev) => {
        if (!prev.has(relPath)) return prev
        const next = new Set(prev)
        next.delete(relPath)
        return next
      })
    },

    async toggleDir(relPath: string) {
      if (expandedSet().has(relPath)) {
        this.collapseDir(relPath)
      } else {
        await this.expandDir(relPath)
      }
    },

    collapseAll() {
      setExpandedSet(new Set<string>())
    },

    async refreshDir(relPath: string) {
      await loadDir(relPath)
    },

    async refreshAllExpanded() {
      const targets = ['', ...expandedSet()]
      await Promise.all(targets.map((dir) => loadDir(dir)))
    },

    async handleFsDelta(delta: FsDelta) {
      if (delta.overflow) {
        await this.refreshAllExpanded()
        return
      }

      const map = childrenMap()
      const expanded = expandedSet()
      const targets = new Set<string>()

      for (const dir of delta.affectedDirs) {
        if (dir === '' && map.has('')) {
          targets.add('')
        } else if (expanded.has(dir) && map.has(dir)) {
          targets.add(dir)
        }
      }

      if (targets.size === 0) return
      await Promise.all([...targets].map((dir) => loadDir(dir)))
    },
  }
}
