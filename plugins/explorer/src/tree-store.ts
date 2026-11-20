import { createServiceKey } from '@lite-ide/kernel'
import type { DirEntry, FsDelta, WorkspaceBackend } from '@lite-ide/protocol'
import { createMemo, createSignal, type Accessor } from 'solid-js'
import type { ExplorerExcludeService } from './exclude-patterns'

export interface FlatTreeNode {
  entry: DirEntry
  depth: number
  expanded: boolean
  loading: boolean
  parentPath: string
  creatingKind?: 'file' | 'dir'
}

export type PendingTreeAction =
  | { kind: 'create-file' | 'create-dir'; parentDir: string }
  | { kind: 'rename'; relPath: string; isDir: boolean; originalName: string }

export interface FileTreeStore {
  readonly visibleNodes: Accessor<FlatTreeNode[]>
  readonly showIgnored: Accessor<boolean>
  readonly filterQuery: Accessor<string>
  readonly focusedPath: Accessor<string | null>
  readonly scrollOffset: Accessor<number>
  readonly rootLoading: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly pendingAction: Accessor<PendingTreeAction | null>
  readonly actionError: Accessor<string | null>
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
  startCreate(kind: 'file' | 'dir', parentDir: string): Promise<void>
  startRename(relPath: string, isDir: boolean, originalName: string): void
  cancelAction(): void
  commitCreate(rawName: string): Promise<{ relPath: string; isDir: boolean } | null>
  commitRename(
    rawName: string,
  ): Promise<{ oldRelPath: string; newRelPath: string; isDir: boolean } | null>
  deleteEntry(relPath: string, isDir: boolean): Promise<boolean>
}

export const FileTreeStoreKey = createServiceKey<FileTreeStore>('plugin.explorer.fileTreeStore')

export const CREATING_PLACEHOLDER_PATH = '__lite_ide_creating__'

export function parentDirOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

export function validateEntryName(rawName: string): string | null {
  const name = rawName.trim()
  if (!name) {
    return 'Name cannot be empty.'
  }
  if (name === '.' || name === '..') {
    return 'Name cannot be "." or "..".'
  }
  if (name.includes('/') || name.includes('\\')) {
    return 'Path separators ("/" or "\\") are not allowed.'
  }
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(name)) {
    return 'Contains invalid characters: < > : " | ? *'
  }
  return null
}

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

export interface FileTreeStoreOptions {
  /** 全局排除规则（设置界面维护）；命中的条目从树中彻底隐藏，与 showIgnored 开关独立 */
  readonly excludes?: ExplorerExcludeService
}

export function createFileTreeStore(
  projectId: string,
  backend: WorkspaceBackend,
  options?: FileTreeStoreOptions,
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
  const [pendingAction, setPendingAction] = createSignal<PendingTreeAction | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)

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
    // matches 内部读取排除规则的 signal，进入本 memo 的依赖自动重算。
    const isExcluded = options?.excludes
      ? (entry: DirEntry) => options.excludes!.matches(entry)
      : null
    const query = filterQuery().trim().toLowerCase()
    const pending = pendingAction()

    const result: FlatTreeNode[] = []

    const hasMatchingLoadedDescendant = (dirPath: string): boolean => {
      if (!expanded.has(dirPath)) return false
      const children = map.get(dirPath)
      if (!children) return false
      for (const child of children) {
        if ((!includeIgnored && child.ignored) || isExcluded?.(child)) continue
        if (child.name.toLowerCase().includes(query)) return true
        if (child.isDir && hasMatchingLoadedDescendant(child.relPath)) return true
      }
      return false
    }

    const walk = (dirPath: string, depth: number) => {
      if (
        pending &&
        (pending.kind === 'create-file' || pending.kind === 'create-dir') &&
        pending.parentDir === dirPath
      ) {
        const isDir = pending.kind === 'create-dir'
        result.push({
          entry: {
            name: '',
            relPath: CREATING_PLACEHOLDER_PATH,
            isDir,
            size: 0,
            modifiedMs: 0,
            ignored: false,
            hidden: false,
          },
          depth,
          expanded: false,
          loading: false,
          parentPath: dirPath,
          creatingKind: isDir ? 'dir' : 'file',
        })
      }

      const entries = map.get(dirPath)
      if (!entries) return

      for (const entry of entries) {
        if ((!includeIgnored && entry.ignored) || isExcluded?.(entry)) continue

        const hasCreatingChild =
          pending &&
          (pending.kind === 'create-file' || pending.kind === 'create-dir') &&
          entry.isDir &&
          (pending.parentDir === entry.relPath ||
            pending.parentDir.startsWith(`${entry.relPath}/`))

        if (query && !hasCreatingChild) {
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
    pendingAction,
    actionError,
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
      if (relPath === '') {
        await this.ensureRootLoaded()
        return
      }
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

    async startCreate(kind: 'file' | 'dir', parentDir: string) {
      setActionError(null)
      if (parentDir !== '') {
        const parts = parentDir.split('/').filter(Boolean)
        let cursor = ''
        for (const seg of parts) {
          cursor = cursor ? `${cursor}/${seg}` : seg
          await this.expandDir(cursor)
        }
      } else {
        await this.ensureRootLoaded()
      }
      setPendingAction({
        kind: kind === 'file' ? 'create-file' : 'create-dir',
        parentDir,
      })
    },

    startRename(relPath: string, isDir: boolean, originalName: string) {
      setActionError(null)
      setFocusedPath(relPath)
      setPendingAction({
        kind: 'rename',
        relPath,
        isDir,
        originalName,
      })
    },

    cancelAction() {
      setPendingAction(null)
      setActionError(null)
    },

    async commitCreate(rawName: string) {
      const pending = pendingAction()
      if (!pending || (pending.kind !== 'create-file' && pending.kind !== 'create-dir')) {
        return null
      }

      const name = rawName.trim()
      const validationError = validateEntryName(name)
      if (validationError) {
        setActionError(validationError)
        return null
      }

      const targetRel = pending.parentDir ? `${pending.parentDir}/${name}` : name
      const isDir = pending.kind === 'create-dir'

      try {
        if (isDir) {
          await backend.createDir(projectId, targetRel)
        } else {
          await backend.createFile(projectId, targetRel)
        }
        setPendingAction(null)
        setActionError(null)
        await loadDir(pending.parentDir)
        setFocusedPath(targetRel)
        return { relPath: targetRel, isDir }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
        return null
      }
    },

    async commitRename(rawName: string) {
      const pending = pendingAction()
      if (!pending || pending.kind !== 'rename') {
        return null
      }

      const name = rawName.trim()
      const validationError = validateEntryName(name)
      if (validationError) {
        setActionError(validationError)
        return null
      }

      if (name === pending.originalName) {
        setPendingAction(null)
        setActionError(null)
        return null
      }

      const parent = parentDirOf(pending.relPath)
      const newRel = parent ? `${parent}/${name}` : name

      try {
        await backend.renamePath(projectId, pending.relPath, newRel)
        setPendingAction(null)
        setActionError(null)

        if (pending.isDir) {
          setExpandedSet((prev) => {
            const next = new Set<string>()
            for (const dir of prev) {
              const mapped = remapPath(dir, pending.relPath, newRel, true)
              next.add(mapped ?? dir)
            }
            return next
          })

          setChildrenMap((prev) => {
            const next = new Map<string, DirEntry[]>()
            for (const [dirKey, entries] of prev) {
              const mappedKey = remapPath(dirKey, pending.relPath, newRel, true) ?? dirKey
              const updatedEntries = entries.map((entry) => {
                const mappedEntryPath = remapPath(
                  entry.relPath,
                  pending.relPath,
                  newRel,
                  true,
                )
                return mappedEntryPath ? { ...entry, relPath: mappedEntryPath } : entry
              })
              next.set(mappedKey, updatedEntries)
            }
            return next
          })
        }

        await loadDir(parent)

        const focused = focusedPath()
        if (focused) {
          const mappedFocus = remapPath(focused, pending.relPath, newRel, pending.isDir)
          if (mappedFocus) {
            setFocusedPath(mappedFocus)
          }
        }

        return {
          oldRelPath: pending.relPath,
          newRelPath: newRel,
          isDir: pending.isDir,
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
        return null
      }
    },

    async deleteEntry(relPath: string, isDir: boolean) {
      setError(null)
      try {
        await backend.deletePath(projectId, relPath)

        if (isDir) {
          setExpandedSet((prev) => {
            const next = new Set<string>()
            for (const dir of prev) {
              if (!matchesPath(dir, relPath, true)) {
                next.add(dir)
              }
            }
            return next
          })

          setChildrenMap((prev) => {
            const next = new Map<string, DirEntry[]>()
            for (const [dirKey, entries] of prev) {
              if (!matchesPath(dirKey, relPath, true)) {
                next.set(dirKey, entries)
              }
            }
            return next
          })
        }

        const focused = focusedPath()
        if (focused && matchesPath(focused, relPath, isDir)) {
          setFocusedPath(null)
        }

        await loadDir(parentDirOf(relPath))
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
  }
}
