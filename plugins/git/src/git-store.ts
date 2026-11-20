import { createServiceKey } from '@lite-ide/kernel'
import type { GitBackend, GitBranchInfo, GitFileStatus, GitStatus } from '@lite-ide/protocol'
import type { TranslateFn } from '@lite-ide/workbench'
import { batch, createSignal, type Accessor } from 'solid-js'

/** FS-delta events coalesce into one debounced status refresh. */
const FS_REFRESH_DEBOUNCE_MS = 400

function isNoisyGitWatchPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  if (normalized === '.git') return true
  if (normalized.startsWith('.git/')) {
    const gitRel = normalized.slice(5)
    return (
      gitRel === 'objects' ||
      gitRel.startsWith('objects/') ||
      gitRel === 'logs' ||
      gitRel.startsWith('logs/') ||
      gitRel === 'fsmonitor--daemon' ||
      gitRel.startsWith('fsmonitor--daemon/') ||
      gitRel === 'ugit' ||
      gitRel.startsWith('ugit/') ||
      gitRel.endsWith('.lock')
    )
  }
  return normalized
    .split('/')
    .some(
      (seg) =>
        seg === 'node_modules' ||
        seg === 'target' ||
        seg === '.vite' ||
        seg === '.pnpm-store',
    )
}

export interface GitStore {
  readonly status: Accessor<GitStatus | null>
  /** True until the first status response arrives. */
  readonly loading: Accessor<boolean>
  /** True while a non-initial status refresh is in flight (refresh spinner). */
  readonly refreshing: Accessor<boolean>
  readonly error: Accessor<string | null>
  /** Surfaces non-store failures (e.g. AI generation) in the error banner. */
  setError(message: string | null): void
  readonly commitMessage: Accessor<string>
  readonly committing: Accessor<boolean>
  readonly pushing: Accessor<boolean>
  /** True while a stage/unstage/discard/checkout/push write action is in flight. */
  readonly mutating: Accessor<boolean>
  readonly branches: Accessor<GitBranchInfo[]>
  readonly branchesLoading: Accessor<boolean>
  setCommitMessage(message: string): void
  refresh(): Promise<void>
  ensureLoaded(): Promise<void>
  loadBranches(): Promise<void>
  checkoutBranch(name: string, create?: boolean): Promise<boolean>
  handleFsDelta(delta: { affectedPaths: string[]; overflow: boolean }): void
  stage(relPaths: string[]): Promise<void>
  unstage(relPaths: string[]): Promise<void>
  stageAll(): Promise<void>
  unstageAll(): Promise<void>
  discard(untrackedPaths: string[], trackedPaths: string[]): Promise<void>
  /** Resolves false (with `error` set) when the commit was rejected. */
  commit(): Promise<boolean>
  /** Resolves false (with `error` set) when the push failed. */
  push(): Promise<boolean>
  /** Cancels pending debounced refreshes; called when the project scope closes. */
  dispose(): void
}

export const GitStoreKey = createServiceKey<GitStore>('plugin.git.store')

/** Kernel-level backend for git operations (Tauri IPC or mock). */
export const GitBackendKey = createServiceKey<GitBackend>('plugin.git.backend')

export function isUntrackedEntry(entry: GitFileStatus): boolean {
  return entry.x === '?' && entry.y === '?'
}

/** Unmerged index/worktree combinations from `git status --porcelain`. */
const UNMERGED_COMBINATIONS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export function isUnmergedEntry(entry: GitFileStatus): boolean {
  return UNMERGED_COMBINATIONS.has(`${entry.x}${entry.y}`)
}

/** Entry contributes to the staged ("Changes to be committed") section. */
export function hasStagedChanges(entry: GitFileStatus): boolean {
  // Unmerged entries are surfaced in the unstaged section only, where the UI
  // can flag them as conflicts instead of offering stage/unstage actions.
  return !isUnmergedEntry(entry) && entry.x !== ' ' && entry.x !== '?'
}

/** Entry contributes to the unstaged ("Changes") section; untracked included. */
export function hasUnstagedChanges(entry: GitFileStatus): boolean {
  return isUntrackedEntry(entry) || (entry.y !== ' ' && entry.y !== '?')
}

/** Unstaged entries that can be staged in bulk; unmerged conflicts are excluded. */
export function isStageableEntry(entry: GitFileStatus): boolean {
  return hasUnstagedChanges(entry) && !isUnmergedEntry(entry)
}

/** Paths to pass to `git reset` when unstaging one entry (includes rename source). */
export function unstagePathsForEntry(entry: GitFileStatus): string[] {
  if (entry.x === 'R' && entry.origPath) {
    return [entry.relPath, entry.origPath]
  }
  return [entry.relPath]
}

/**
 * Status letter shown on a section row: `?` renders as `U` (untracked),
 * unmerged combinations render as `C` (conflict), and staged/unstaged pick
 * their own column.
 */
export function statusLetter(entry: GitFileStatus, section: 'staged' | 'unstaged'): string {
  if (isUnmergedEntry(entry)) return 'C'
  if (section === 'staged') return entry.x === '?' ? 'U' : entry.x
  return entry.y === '?' ? 'U' : entry.y
}

export interface GitStoreOptions {
  readonly t?: TranslateFn
}

export function createGitStore(
  projectId: string,
  backend: GitBackend,
  options?: GitStoreOptions,
): GitStore {
  const t: TranslateFn = options?.t ?? ((_key, _params, fallback) => fallback ?? _key)
  const [status, setStatus] = createSignal<GitStatus | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [commitMessage, setCommitMessage] = createSignal('')
  const [committing, setCommitting] = createSignal(false)
  const [pushing, setPushing] = createSignal(false)
  const [pendingWrites, setPendingWrites] = createSignal(0)
  const mutating = () => pendingWrites() > 0
  const [branches, setBranches] = createSignal<GitBranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = createSignal(false)

  let requestSeq = 0
  let branchRequestSeq = 0
  let fsRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let writeChain: Promise<void> = Promise.resolve()
  let statusInFlight: Promise<string | null> | null = null
  let queuedStatusSyncError: boolean | null = null
  let lastStatusResult: string | null = null
  let hasStartedStatusLoad = false

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    setPendingWrites((n) => n + 1)
    const run = writeChain.then(task, task)
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run.finally(() => {
      setPendingWrites((n) => Math.max(0, n - 1))
    })
  }

  async function fetchStatus(syncError: boolean): Promise<string | null> {
    hasStartedStatusLoad = true
    while (statusInFlight) {
      queuedStatusSyncError =
        queuedStatusSyncError === null ? syncError : queuedStatusSyncError || syncError
      await statusInFlight
      if (queuedStatusSyncError === null) {
        return statusInFlight ? await statusInFlight : lastStatusResult
      }
      syncError = queuedStatusSyncError
      queuedStatusSyncError = null
    }

    const run = (async (): Promise<string | null> => {
      const seq = ++requestSeq
      const firstLoad = status() === null
      if (firstLoad) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }

      try {
        const next = await backend.status(projectId)
        if (seq !== requestSeq) return null
        batch(() => {
          setStatus(next)
          if (syncError) setError(null)
        })
        lastStatusResult = null
        return null
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (seq !== requestSeq) return null
        if (syncError) setError(message)
        lastStatusResult = message
        return message
      } finally {
        if (seq === requestSeq) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    })()

    statusInFlight = run
    try {
      return await run
    } finally {
      if (statusInFlight === run) {
        statusInFlight = null
      }
    }
  }

  async function refresh(): Promise<void> {
    await fetchStatus(true)
  }

  async function ensureLoaded(): Promise<void> {
    if (hasStartedStatusLoad) {
      if (statusInFlight) {
        await statusInFlight
      }
      return
    }
    await refresh()
  }

  async function fetchBranches(syncError: boolean): Promise<string | null> {
    const seq = ++branchRequestSeq
    setBranchesLoading(true)
    try {
      const next = await backend.branches(projectId)
      if (seq !== branchRequestSeq) return null
      batch(() => {
        setBranches(next)
        if (syncError) setError(null)
      })
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (seq !== branchRequestSeq) return null
      if (syncError) setError(message)
      return message
    } finally {
      if (seq === branchRequestSeq) {
        setBranchesLoading(false)
      }
    }
  }

  async function loadBranches(): Promise<void> {
    await fetchBranches(true)
  }

  function runAction(action: () => Promise<void>): Promise<void> {
    return enqueueWrite(async () => {
      let actionError: string | null = null
      try {
        await action()
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err)
      }
      // Refresh even after failures: operations may partially apply. The action
      // error is applied afterwards so the follow-up refresh cannot wipe it.
      await refresh()
      if (actionError) {
        setError(actionError)
      }
    })
  }

  return {
    status,
    loading,
    refreshing,
    error,
    setError(message: string | null) {
      setError(message)
    },
    commitMessage,
    committing,
    pushing,
    mutating,
    branches,
    branchesLoading,

    setCommitMessage(message: string) {
      setCommitMessage(message)
    },

    refresh,

    ensureLoaded,

    loadBranches,

    async checkoutBranch(name: string, create = false): Promise<boolean> {
      const trimmed = name.trim()
      if (!trimmed) {
        setError(t('git.error.emptyBranch', undefined, 'Branch name is empty.'))
        return false
      }
      if (committing() || mutating()) return false

      return enqueueWrite(async () => {
        let checkoutError: string | null = null
        let ok = false
        try {
          await backend.checkoutBranch(projectId, trimmed, create)
          ok = true
        } catch (err) {
          checkoutError = err instanceof Error ? err.message : String(err)
        }
        const [statusError, branchError] = await Promise.all([
          fetchStatus(false),
          fetchBranches(false),
        ])
        setError(checkoutError ?? statusError ?? branchError)
        return ok
      })
    },

    handleFsDelta(delta: { affectedPaths: string[]; overflow: boolean }) {
      // Only track repositories; a folder outside version control never
      // changes its "not a repository" verdict from filesystem noise.
      if (!status()?.repo) return
      if (
        !delta.overflow &&
        delta.affectedPaths.length > 0 &&
        delta.affectedPaths.every(isNoisyGitWatchPath)
      ) {
        return
      }
      if (fsRefreshTimer) clearTimeout(fsRefreshTimer)
      fsRefreshTimer = setTimeout(() => {
        fsRefreshTimer = null
        void refresh()
      }, FS_REFRESH_DEBOUNCE_MS)
    },

    stage(relPaths: string[]) {
      if (relPaths.length === 0) return Promise.resolve()
      return runAction(() => backend.stage(projectId, relPaths))
    },

    unstage(relPaths: string[]) {
      if (relPaths.length === 0) return Promise.resolve()
      return runAction(() => backend.unstage(projectId, relPaths))
    },

    stageAll() {
      const paths = (status()?.entries ?? [])
        .filter(isStageableEntry)
        .map((entry) => entry.relPath)
      if (paths.length === 0) return Promise.resolve()
      return runAction(() => backend.stage(projectId, paths))
    },

    unstageAll() {
      const paths = [
        ...new Set(
          (status()?.entries ?? [])
            .filter(hasStagedChanges)
            .flatMap(unstagePathsForEntry),
        ),
      ]
      if (paths.length === 0) return Promise.resolve()
      return runAction(() => backend.unstage(projectId, paths))
    },

    discard(untrackedPaths: string[], trackedPaths: string[]) {
      if (untrackedPaths.length === 0 && trackedPaths.length === 0) {
        return Promise.resolve()
      }
      return runAction(() => backend.discard(projectId, untrackedPaths, trackedPaths))
    },

    async commit(): Promise<boolean> {
      if (committing() || mutating()) return false
      const message = commitMessage().trim()
      if (!message) {
        setError(t('git.error.emptyCommit', undefined, 'Commit message is empty.'))
        return false
      }
      const stagedCount = status()?.entries.filter(hasStagedChanges).length ?? 0
      if (stagedCount === 0) {
        setError(t('git.error.noStaged', undefined, 'No staged changes to commit.'))
        return false
      }

      setError(null)
      setCommitting(true)
      try {
        return await enqueueWrite(async () => {
          try {
            await backend.commit(projectId, message)
            setCommitMessage('')
            await refresh()
            return true
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            return false
          }
        })
      } finally {
        setCommitting(false)
      }
    },

    async push(): Promise<boolean> {
      if (pushing() || committing() || mutating()) return false

      setError(null)
      setPushing(true)
      try {
        return await enqueueWrite(async () => {
          let pushError: string | null = null
          let ok = false
          try {
            await backend.push(projectId)
            ok = true
          } catch (err) {
            pushError = err instanceof Error ? err.message : String(err)
          }
          const statusError = await fetchStatus(false)
          setError(pushError ?? statusError)
          return ok
        })
      } finally {
        setPushing(false)
      }
    },

    dispose() {
      if (fsRefreshTimer) {
        clearTimeout(fsRefreshTimer)
        fsRefreshTimer = null
      }
    },
  }
}
