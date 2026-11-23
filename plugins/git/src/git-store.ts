import { createServiceKey } from '@lite-ide/kernel'
import type {
  GitBackend,
  GitBranchInfo,
  GitCommitInfo,
  GitFileStatus,
  GitStashEntry,
  GitStatus,
} from '@lite-ide/protocol'
import type { TranslateFn } from '@lite-ide/workbench'
import { batch, createSignal, type Accessor } from 'solid-js'

/** FS-delta events coalesce into one debounced status refresh. */
const FS_REFRESH_DEBOUNCE_MS = 400

/** Commits fetched per history page ("load more" extends by this size). */
export const COMMITS_PAGE_SIZE = 50

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
  readonly error: Accessor<string | null>
  /** Surfaces non-store failures (e.g. AI generation) in the error banner. */
  setError(message: string | null): void
  readonly commitMessage: Accessor<string>
  readonly committing: Accessor<boolean>
  readonly pulling: Accessor<boolean>
  readonly pushing: Accessor<boolean>
  /** True while a stage/unstage/discard/checkout/pull/push write action is in flight. */
  readonly mutating: Accessor<boolean>
  readonly branches: Accessor<GitBranchInfo[]>
  readonly branchesLoading: Accessor<boolean>
  /** The project's stash stack, newest entry first. */
  readonly stashes: Accessor<GitStashEntry[]>
  readonly stashesLoading: Accessor<boolean>
  /** Commit history on the current branch, newest first. */
  readonly commits: Accessor<GitCommitInfo[]>
  /** True until the first history page arrives. */
  readonly commitsLoading: Accessor<boolean>
  /** True while a "load more" page request is in flight. */
  readonly commitsLoadingMore: Accessor<boolean>
  /** History fetch failure, surfaced inside the history view. */
  readonly commitsError: Accessor<string | null>
  /** True when the last page was full, so more commits may exist. */
  readonly hasMoreCommits: Accessor<boolean>
  /**
   * Last Git-panel row the user asked a diff for; the diff previewer reads it
   * to pick the staged/unstaged comparison for the file it renders. `sha`
   * selects a single commit's comparison (history view).
   */
  readonly diffFocus: Accessor<GitDiffFocus | null>
  setCommitMessage(message: string): void
  setDiffFocus(focus: GitDiffFocus | null): void
  refresh(): Promise<void>
  ensureLoaded(): Promise<void>
  loadBranches(): Promise<void>
  /** Fetches the stash stack; called when the panel opens and after stash writes. */
  loadStashes(): Promise<void>
  /** Loads the first history page unless one is already in memory. */
  ensureCommitsLoaded(): Promise<void>
  /** Reloads the first history page (after commit / branch switch). */
  reloadCommits(): Promise<void>
  /** Fetches the next history page and appends it. */
  loadMoreCommits(): Promise<void>
  checkoutBranch(name: string, create?: boolean): Promise<boolean>
  /**
   * Resets the current branch to `sha` (mixed): the index follows the target
   * commit and every difference stays in the worktree as unstaged changes.
   * Resolves false (with `error` set) when the reset failed.
   */
  resetToCommit(sha: string): Promise<boolean>
  /** Creates a local branch pointing at `sha` without switching to it. */
  createBranchAt(name: string, sha: string): Promise<boolean>
  /** Applies commit `sha` as a new commit on the current branch. */
  cherryPick(sha: string): Promise<boolean>
  handleFsDelta(delta: { affectedPaths: string[]; overflow: boolean }): void
  stage(relPaths: string[]): Promise<void>
  unstage(relPaths: string[]): Promise<void>
  stageAll(): Promise<void>
  unstageAll(): Promise<void>
  discard(untrackedPaths: string[], trackedPaths: string[]): Promise<void>
  /** Stashes all tracked + untracked changes; optional stash message. */
  stashAll(message?: string): Promise<void>
  /** Stashes only the given paths' changes (tracked and untracked). */
  stashPaths(relPaths: string[]): Promise<void>
  /** Applies stash@{index} to the worktree, keeping the entry in the stack. */
  stashRestore(index: number): Promise<void>
  /** Removes stash@{index} without applying it. */
  stashDrop(index: number): Promise<void>
  /** Resolves false (with `error` set) when the commit was rejected. */
  commit(): Promise<boolean>
  /** Resolves false (with `error` set) when the pull failed. */
  pull(): Promise<boolean>
  /** Resolves false (with `error` set) when the push failed. */
  push(): Promise<boolean>
  /** Cancels pending debounced refreshes; called when the project scope closes. */
  dispose(): void
}

/** Which comparison a Git-panel row points at when opening the diff preview. */
export type GitDiffSection = 'staged' | 'unstaged'

export interface GitDiffFocus {
  relPath: string
  section: GitDiffSection
  /** Set when the preview compares the file inside one commit (history view). */
  sha?: string
}

/** previewer.provider id contributed by this plugin for diff previews. */
export const GIT_DIFF_PREVIEWER_ID = 'git-diff'

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

/**
 * Status letter for one file inside a commit, derived from its patch header
 * (the history view shows patches, not porcelain status).
 */
export function commitFileLetter(patch: string): string {
  if (patch.includes('new file mode')) return 'A'
  if (patch.includes('deleted file mode')) return 'D'
  if (/^rename from /m.test(patch)) return 'R'
  return 'M'
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
  const [error, setError] = createSignal<string | null>(null)
  const [commitMessage, setCommitMessage] = createSignal('')
  const [committing, setCommitting] = createSignal(false)
  const [pulling, setPulling] = createSignal(false)
  const [pushing, setPushing] = createSignal(false)
  const [pendingWrites, setPendingWrites] = createSignal(0)
  const mutating = () => pendingWrites() > 0
  const [branches, setBranches] = createSignal<GitBranchInfo[]>([])
  const [branchesLoading, setBranchesLoading] = createSignal(false)
  const [stashes, setStashes] = createSignal<GitStashEntry[]>([])
  const [stashesLoading, setStashesLoading] = createSignal(false)
  const [commits, setCommits] = createSignal<GitCommitInfo[]>([])
  const [commitsLoading, setCommitsLoading] = createSignal(false)
  const [commitsLoadingMore, setCommitsLoadingMore] = createSignal(false)
  const [commitsError, setCommitsError] = createSignal<string | null>(null)
  const [hasMoreCommits, setHasMoreCommits] = createSignal(false)
  const [diffFocus, setDiffFocus] = createSignal<GitDiffFocus | null>(null)

  let requestSeq = 0
  let branchRequestSeq = 0
  let stashRequestSeq = 0
  let commitsRequestSeq = 0
  let commitsLoaded = false
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

  async function fetchStashes(syncError: boolean): Promise<string | null> {
    const seq = ++stashRequestSeq
    setStashesLoading(true)
    try {
      const next = await backend.stashList(projectId)
      if (seq !== stashRequestSeq) return null
      batch(() => {
        setStashes(next)
        if (syncError) setError(null)
      })
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (seq !== stashRequestSeq) return null
      if (syncError) setError(message)
      return message
    } finally {
      if (seq === stashRequestSeq) {
        setStashesLoading(false)
      }
    }
  }

  /**
   * Fetches one history page. `next` appends to the list ("load more");
   * otherwise the first page replaces whatever is held. The sequence guard
   * keeps reloads from racing an in-flight "load more" append.
   */
  async function loadCommitsPage(next: boolean): Promise<void> {
    const seq = ++commitsRequestSeq
    if (next) {
      setCommitsLoadingMore(true)
    } else if (commits().length === 0) {
      // First-page spinner only on the initial load; background reloads
      // (commit / branch switch / fs delta) swap the list in place.
      setCommitsLoading(true)
    }
    setCommitsError(null)
    try {
      const page = await backend.log(projectId, {
        skip: next ? commits().length : 0,
        limit: COMMITS_PAGE_SIZE,
      })
      if (seq !== commitsRequestSeq) return
      batch(() => {
        setCommits(next ? [...commits(), ...page] : page)
        setHasMoreCommits(page.length >= COMMITS_PAGE_SIZE)
      })
      commitsLoaded = true
    } catch (err) {
      if (seq !== commitsRequestSeq) return
      setCommitsError(err instanceof Error ? err.message : String(err))
      // A failed first load must not leave a dangling "load more" button.
      if (!next) setHasMoreCommits(false)
    } finally {
      if (seq === commitsRequestSeq) {
        setCommitsLoading(false)
        setCommitsLoadingMore(false)
      }
    }
  }

  async function loadStashes(): Promise<void> {
    await fetchStashes(true)
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

  /**
   * Like `runAction`, but also refreshes the stash stack: every stash write
   * mutates both the worktree (status) and the stash list.
   */
  function runStashAction(action: () => Promise<void>): Promise<void> {
    return enqueueWrite(async () => {
      let actionError: string | null = null
      try {
        await action()
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err)
      }
      const [statusError, stashError] = await Promise.all([
        fetchStatus(true),
        fetchStashes(false),
      ])
      setError(actionError ?? statusError ?? stashError)
    })
  }

  async function runRemoteAction(
    setBusy: (busy: boolean) => void,
    action: () => Promise<void>,
    options?: { reloadBranches?: boolean; reloadCommits?: boolean },
  ): Promise<boolean> {
    if (pulling() || pushing() || committing() || mutating()) return false

    setError(null)
    setBusy(true)
    try {
      return await enqueueWrite(async () => {
        let actionError: string | null = null
        let ok = false
        try {
          await action()
          ok = true
        } catch (err) {
          actionError = err instanceof Error ? err.message : String(err)
        }
        const [statusError, branchError] = await Promise.all([
          fetchStatus(false),
          options?.reloadBranches ? fetchBranches(false) : Promise.resolve(null),
        ])
        setError(actionError ?? statusError ?? branchError)
        if (ok && options?.reloadCommits && commitsLoaded) {
          await loadCommitsPage(false)
        }
        return ok
      })
    } finally {
      setBusy(false)
    }
  }

  return {
    status,
    loading,
    error,
    setError(message: string | null) {
      setError(message)
    },
    commitMessage,
    committing,
    pulling,
    pushing,
    mutating,
    branches,
    branchesLoading,
    stashes,
    stashesLoading,
    commits,
    commitsLoading,
    commitsLoadingMore,
    commitsError,
    hasMoreCommits,
    diffFocus,

    setCommitMessage(message: string) {
      setCommitMessage(message)
    },

    setDiffFocus(focus: GitDiffFocus | null) {
      setDiffFocus(focus)
    },

    refresh,

    ensureLoaded,

    loadBranches,

    loadStashes,

    ensureCommitsLoaded(): Promise<void> {
      if (commitsLoaded || commitsLoading()) return Promise.resolve()
      return loadCommitsPage(false)
    },

    reloadCommits(): Promise<void> {
      return loadCommitsPage(false)
    },

    loadMoreCommits(): Promise<void> {
      if (!hasMoreCommits() || commitsLoading() || commitsLoadingMore()) {
        return Promise.resolve()
      }
      return loadCommitsPage(true)
    },

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
        // A branch switch points HEAD at different history.
        if (ok && commitsLoaded) {
          await loadCommitsPage(false)
        }
        return ok
      })
    },

    async resetToCommit(sha: string): Promise<boolean> {
      if (committing() || mutating()) return false
      return enqueueWrite(async () => {
        let resetError: string | null = null
        let ok = false
        try {
          await backend.resetMixed(projectId, sha)
          ok = true
        } catch (err) {
          resetError = err instanceof Error ? err.message : String(err)
        }
        const statusError = await fetchStatus(false)
        setError(resetError ?? statusError)
        // The branch pointer moved: history restarts from the target commit.
        if (ok && commitsLoaded) {
          await loadCommitsPage(false)
        }
        return ok
      })
    },

    async createBranchAt(name: string, sha: string): Promise<boolean> {
      const trimmed = name.trim()
      if (!trimmed) {
        setError(t('git.error.emptyBranch', undefined, 'Branch name is empty.'))
        return false
      }
      if (committing() || mutating()) return false
      return enqueueWrite(async () => {
        let createError: string | null = null
        let ok = false
        try {
          await backend.createBranchAt(projectId, trimmed, sha)
          ok = true
        } catch (err) {
          createError = err instanceof Error ? err.message : String(err)
        }
        // Only the branch list changes; status and history are untouched.
        const branchError = await fetchBranches(false)
        setError(createError ?? branchError)
        return ok
      })
    },

    async cherryPick(sha: string): Promise<boolean> {
      if (committing() || mutating()) return false
      return enqueueWrite(async () => {
        let pickError: string | null = null
        let ok = false
        try {
          await backend.cherryPick(projectId, sha)
          ok = true
        } catch (err) {
          pickError = err instanceof Error ? err.message : String(err)
        }
        // A picked commit lands on top of the current branch: status refreshes
        // (cherry-pick conflicts surface here) and history gains a head row.
        const statusError = await fetchStatus(false)
        setError(pickError ?? statusError)
        if (ok && commitsLoaded) {
          await loadCommitsPage(false)
        }
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
        // External commits (e.g. made in a terminal) change the log too; a
        // no-op when the history view was never opened this session.
        if (commitsLoaded) {
          void loadCommitsPage(false)
        }
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

    stashAll(message?: string) {
      return runStashAction(() => backend.stashAll(projectId, message))
    },

    stashPaths(relPaths: string[]) {
      if (relPaths.length === 0) return Promise.resolve()
      return runStashAction(() => backend.stashPaths(projectId, relPaths))
    },

    stashRestore(index: number) {
      return runStashAction(() => backend.stashRestore(projectId, index))
    },

    stashDrop(index: number) {
      return runStashAction(() => backend.stashDrop(projectId, index))
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
            // The new commit lands on top of the current branch's history.
            if (commitsLoaded) {
              await loadCommitsPage(false)
            }
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

    pull(): Promise<boolean> {
      return runRemoteAction(setPulling, () => backend.pull(projectId), {
        reloadBranches: true,
        reloadCommits: true,
      })
    },

    push(): Promise<boolean> {
      return runRemoteAction(setPushing, () => backend.push(projectId))
    },

    dispose() {
      if (fsRefreshTimer) {
        clearTimeout(fsRefreshTimer)
        fsRefreshTimer = null
      }
    },
  }
}
