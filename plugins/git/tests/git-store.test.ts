import { createMockGitBackend, type GitBackend, type GitCommitInfo, type GitStatus } from '@lite-ide/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  commitFileLetter,
  COMMITS_PAGE_SIZE,
  createGitStore,
  hasStagedChanges,
  hasUnstagedChanges,
  isStageableEntry,
  isUnmergedEntry,
  statusLetter,
  unstagePathsForEntry,
  type GitStore,
} from '../src/git-store'

const DEMO_PROJECT = 'mock-lite-ide'
const PLAIN_PROJECT = 'mock-plain-folder'

function entryOf(store: GitStore, relPath: string) {
  const entry = store.status()?.entries.find((e) => e.relPath === relPath)
  expect(entry, `status entry for ${relPath}`).toBeDefined()
  return entry!
}

describe('git store (mock backend)', () => {
  it('loads initial repository status', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    expect(store.status()).toBeNull()
    expect(store.loading()).toBe(true)

    await store.refresh()

    expect(store.loading()).toBe(false)
    expect(store.error()).toBeNull()
    const status = store.status()
    expect(status?.repo).toBe(true)
    expect(status?.branch).toBe('main')
    expect(status?.upstream).toBe('origin/main')
    expect(entryOf(store, 'README.md')).toMatchObject({ x: 'M', y: ' ' })
    expect(entryOf(store, 'src/App.tsx')).toMatchObject({ x: ' ', y: 'M' })
    expect(entryOf(store, 'data/metrics.csv')).toMatchObject({ x: ' ', y: 'M' })
  })

  it('reports folders outside version control as non-repositories', async () => {
    const store = createGitStore(PLAIN_PROJECT, createMockGitBackend())
    await store.refresh()

    expect(store.status()?.repo).toBe(false)
    expect(store.error()).toBeNull()
  })

  it('stages and unstages files', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()

    await store.stage(['src/App.tsx'])
    expect(entryOf(store, 'src/App.tsx')).toMatchObject({ x: 'M', y: ' ' })
    // Only data/metrics.csv remains unstaged.
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(1)

    await store.unstage(['src/App.tsx'])
    expect(entryOf(store, 'src/App.tsx')).toMatchObject({ x: ' ', y: 'M' })
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(1)
  })

  it('commits staged changes and clears the message', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()

    // Guards: empty message and nothing staged.
    await store.stage(['src/App.tsx'])
    expect(await store.commit()).toBe(false)
    expect(store.error()).toContain('message')

    store.setCommitMessage('feat: demo commit')
    expect(await store.commit()).toBe(true)
    expect(store.error()).toBeNull()
    expect(store.commitMessage()).toBe('')
    // The commit includes every staged entry (README.md and src/App.tsx); the
    // unstaged data/metrics.csv change stays behind.
    expect(store.status()?.entries.map((e) => e.relPath)).toEqual(['data/metrics.csv'])
    expect(store.status()?.ahead).toBe(1)
  })

  it('discards worktree changes per category', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()

    await store.discard([], ['src/App.tsx'])
    expect(store.status()?.entries.some((e) => e.relPath === 'src/App.tsx')).toBe(false)
    // Discarding the untracked bucket leaves tracked entries untouched.
    await store.discard(['src/App.tsx'], [])
    expect(entryOf(store, 'README.md')).toMatchObject({ x: 'M', y: ' ' })
  })

  it('surfaces backend failures as store errors', async () => {
    const store = createGitStore(PLAIN_PROJECT, createMockGitBackend())
    await store.refresh()

    await store.stage(['README.md'])
    expect(store.error()).toContain('not a git repository')
  })

  it('classifies status letters for section rendering', () => {
    expect(statusLetter({ x: ' ', y: 'M', relPath: 'a' }, 'unstaged')).toBe('M')
    expect(statusLetter({ x: '?', y: '?', relPath: 'a' }, 'unstaged')).toBe('U')
    expect(statusLetter({ x: 'R', y: ' ', relPath: 'a' }, 'staged')).toBe('R')
    expect(hasStagedChanges({ x: 'A', y: ' ', relPath: 'a' })).toBe(true)
    expect(hasStagedChanges({ x: ' ', y: 'M', relPath: 'a' })).toBe(false)
    expect(hasUnstagedChanges({ x: '?', y: '?', relPath: 'a' })).toBe(true)
    expect(hasUnstagedChanges({ x: 'M', y: ' ', relPath: 'a' })).toBe(false)
  })

  it('flags unmerged entries as conflicts kept out of the staged section', () => {
    expect(isUnmergedEntry({ x: 'U', y: 'U', relPath: 'a' })).toBe(true)
    expect(isUnmergedEntry({ x: 'A', y: 'A', relPath: 'a' })).toBe(true)
    expect(isUnmergedEntry({ x: 'D', y: 'U', relPath: 'a' })).toBe(true)
    expect(isUnmergedEntry({ x: 'M', y: 'M', relPath: 'a' })).toBe(false)
    expect(statusLetter({ x: 'U', y: 'U', relPath: 'a' }, 'unstaged')).toBe('C')
    expect(hasStagedChanges({ x: 'A', y: 'A', relPath: 'a' })).toBe(false)
    expect(hasUnstagedChanges({ x: 'U', y: 'U', relPath: 'a' })).toBe(true)
    expect(isStageableEntry({ x: 'U', y: 'U', relPath: 'a' })).toBe(false)
    expect(isStageableEntry({ x: ' ', y: 'M', relPath: 'a' })).toBe(true)
    expect(isStageableEntry({ x: '?', y: '?', relPath: 'a' })).toBe(true)
    expect(unstagePathsForEntry({ x: 'R', y: ' ', relPath: 'new.ts', origPath: 'old.ts' })).toEqual([
      'new.ts',
      'old.ts',
    ])
    expect(unstagePathsForEntry({ x: 'M', y: ' ', relPath: 'a.ts' })).toEqual(['a.ts'])
  })

  it('stages all and unstages all changes across multiple files', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()

    await store.stageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(3)
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(0)

    // Calling stageAll again when nothing is unstaged is a safe no-op.
    await store.stageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(3)

    await store.unstageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(0)
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(3)

    // Calling unstageAll again when nothing is staged is a safe no-op.
    await store.unstageAll()
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(3)

    await store.stageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(3)
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(0)
  })

  it('skips unmerged conflicts during stageAll and includes rename origPath during unstageAll', async () => {
    let currentStatus: GitStatus = {
      repo: true,
      branch: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [
        { x: 'U', y: 'U', relPath: 'conflict.ts' },
        { x: ' ', y: 'M', relPath: 'edited.ts' },
        { x: '?', y: '?', relPath: 'added.ts' },
        { x: 'R', y: ' ', relPath: 'new.ts', origPath: 'old.ts' },
      ],
    }
    const stageSpy = vi.fn(async () => {
      currentStatus = {
        ...currentStatus,
        entries: [
          { x: 'U', y: 'U', relPath: 'conflict.ts' },
          { x: 'M', y: ' ', relPath: 'edited.ts' },
          { x: 'A', y: ' ', relPath: 'added.ts' },
          { x: 'R', y: ' ', relPath: 'new.ts', origPath: 'old.ts' },
        ],
      }
    })
    const unstageSpy = vi.fn(async () => {})
    const fakeBackend: GitBackend = {
      status: async () => currentStatus,
      stage: stageSpy,
      unstage: unstageSpy,
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {},
      branches: async () => [],
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: async () => {},
      stashPaths: async () => {},
      stashList: async () => [],
      stashRestore: async () => {},
      stashDrop: async () => {},
      log: async () => [],
      show: async () => [],
    }

    const store = createGitStore('custom', fakeBackend)
    await store.refresh()

    await store.stageAll()
    expect(stageSpy).toHaveBeenCalledWith('custom', ['edited.ts', 'added.ts'])

    await store.unstageAll()
    expect(unstageSpy).toHaveBeenCalledWith('custom', [
      'edited.ts',
      'added.ts',
      'new.ts',
      'old.ts',
    ])
  })

  it('serializes concurrent write actions and exposes mutating state', async () => {
    let activeWrites = 0
    let maxConcurrentWrites = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const slowBackend: GitBackend = {
      status: async () => ({
        repo: true,
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [{ x: ' ', y: 'M', relPath: 'a.ts' }],
      }),
      stage: async () => {
        activeWrites += 1
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
        if (maxConcurrentWrites === 1) {
          await firstGate
        }
        activeWrites -= 1
      },
      unstage: async () => {
        activeWrites += 1
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
        activeWrites -= 1
      },
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {},
      branches: async () => [],
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: async () => {},
      stashPaths: async () => {},
      stashList: async () => [],
      stashRestore: async () => {},
      stashDrop: async () => {},
      log: async () => [],
      show: async () => [],
    }

    const store = createGitStore('slow', slowBackend)
    await store.refresh()
    store.setCommitMessage('feat: test')

    expect(store.mutating()).toBe(false)
    const p1 = store.stage(['a.ts'])
    expect(store.mutating()).toBe(true)
    const p2 = store.unstage(['a.ts'])
    // Commit refuses to start while a stage/unstage write is in flight.
    expect(await store.commit()).toBe(false)

    releaseFirst()
    await Promise.all([p1, p2])
    expect(store.mutating()).toBe(false)
    expect(maxConcurrentWrites).toBe(1)
  })

  it('lists, switches, and creates branches via the mock backend', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()
    await store.loadBranches()

    expect(store.branches().map((b) => b.name)).toContain('feat/demo')
    expect(store.status()?.branch).toBe('main')

    // Switch to an existing local branch.
    expect(await store.checkoutBranch('feat/demo')).toBe(true)
    expect(store.error()).toBeNull()
    expect(store.status()?.branch).toBe('feat/demo')
    expect(store.branches().find((b) => b.current)?.name).toBe('feat/demo')

    // Create and switch to a new branch.
    expect(await store.checkoutBranch('feat/new-branch', true)).toBe(true)
    expect(store.status()?.branch).toBe('feat/new-branch')
    expect(store.branches().find((b) => b.name === 'feat/new-branch')?.current).toBe(true)

    // Switching to a nonexistent branch fails cleanly and surfaces an error.
    expect(await store.checkoutBranch('does-not-exist')).toBe(false)
    expect(store.error()).toContain('did not match')
    expect(store.status()?.branch).toBe('feat/new-branch')
  })

  it('preserves loadBranches error during checkoutBranch and ignores stale branch responses', async () => {
    let resolveFirst!: (val: { name: string; current: boolean; remote: boolean }[]) => void
    let callCount = 0
    const racyBackend: GitBackend = {
      status: async () => ({
        repo: true,
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [],
      }),
      stage: async () => {},
      unstage: async () => {},
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {},
      branches: async () => {
        callCount += 1
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve
          })
        }
        if (callCount === 2) {
          return [{ name: 'fresh', current: true, remote: false }]
        }
        throw new Error('branch list unavailable')
      },
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: async () => {},
      stashPaths: async () => {},
      stashList: async () => [],
      stashRestore: async () => {},
      stashDrop: async () => {},
      log: async () => [],
      show: async () => [],
    }

    const store = createGitStore('race', racyBackend)
    const p1 = store.loadBranches()
    const p2 = store.loadBranches()
    await p2
    resolveFirst([{ name: 'stale', current: true, remote: false }])
    await p1
    expect(store.branches().map((b) => b.name)).toEqual(['fresh'])

    // When checkoutBranch succeeds but post-checkout loadBranches fails,
    // a succeeding status refresh must not wipe the branch error.
    expect(await store.checkoutBranch('fresh')).toBe(true)
    expect(store.error()).toBe('branch list unavailable')
  })

  it('uses provided translator for validation error messages', async () => {
    const messages: Record<string, string> = {
      'git.error.emptyBranch': '分支名称不能为空。',
      'git.error.emptyCommit': '提交信息不能为空。',
      'git.error.noStaged': '没有已暂存的更改可供提交。',
    }
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend(), {
      t: (key, _params, fallback) => messages[key] ?? fallback ?? key,
    })
    await store.refresh()

    expect(await store.checkoutBranch('   ')).toBe(false)
    expect(store.error()).toBe('分支名称不能为空。')

    expect(await store.commit()).toBe(false)
    expect(store.error()).toBe('提交信息不能为空。')

    await store.unstageAll()
    store.setCommitMessage('feat: test')
    expect(await store.commit()).toBe(false)
    expect(store.error()).toBe('没有已暂存的更改可供提交。')
  })

  it('coalesces concurrent refresh calls and avoids duplicate ensureLoaded fetches', async () => {
    let statusCalls = 0
    let activeCalls = 0
    let maxConcurrent = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const slowBackend: GitBackend = {
      status: async () => {
        statusCalls += 1
        activeCalls += 1
        maxConcurrent = Math.max(maxConcurrent, activeCalls)
        if (statusCalls === 1) {
          await firstGate
        }
        activeCalls -= 1
        return {
          repo: true,
          branch: 'main',
          upstream: null,
          ahead: 0,
          behind: 0,
          entries: [],
        }
      },
      stage: async () => {},
      unstage: async () => {},
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {},
      branches: async () => [],
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: async () => {},
      stashPaths: async () => {},
      stashList: async () => [],
      stashRestore: async () => {},
      stashDrop: async () => {},
      log: async () => [],
      show: async () => [],
    }

    const store = createGitStore('coalesce', slowBackend)
    const p1 = store.refresh()
    const pEnsure = store.ensureLoaded()
    // Multiple refreshes while one is in flight coalesce into a single follow-up.
    const p2 = store.refresh()
    const p3 = store.refresh()

    releaseFirst()
    await Promise.all([p1, pEnsure, p2, p3])
    expect(maxConcurrent).toBe(1)
    expect(statusCalls).toBe(2)

    // Subsequent ensureLoaded does not re-fetch once loaded.
    await store.ensureLoaded()
    expect(statusCalls).toBe(2)
  })

  it('ignores noisy fsmonitor/lock/target deltas when scheduling refreshes', async () => {
    vi.useFakeTimers()
    try {
      let statusCalls = 0
      const backend: GitBackend = {
        status: async () => {
          statusCalls += 1
          return {
            repo: true,
            branch: 'main',
            upstream: null,
            ahead: 0,
            behind: 0,
            entries: [],
          }
        },
        stage: async () => {},
        unstage: async () => {},
        discard: async () => {},
        commit: async () => ({ sha: 'abc1234' }),
        push: async () => {},
        branches: async () => [],
        diff: async () => [],
        checkoutBranch: async () => {},
        stashAll: async () => {},
        stashPaths: async () => {},
        stashList: async () => [],
        stashRestore: async () => {},
        stashDrop: async () => {},
        log: async () => [],
        show: async () => [],
      }

      const store = createGitStore('delta-filter', backend)
      await store.refresh()
      expect(statusCalls).toBe(1)

      store.handleFsDelta({
        affectedPaths: [
          '.git/fsmonitor--daemon/cookies/123',
          '.git/index.lock',
          'src-tauri/target/release/lite-ide.exe',
        ],
        overflow: false,
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(statusCalls).toBe(1)

      store.handleFsDelta({
        affectedPaths: ['src/App.tsx'],
        overflow: false,
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(statusCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pushes committed changes, clears ahead count, and surfaces push errors', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()

    store.setCommitMessage('feat: demo commit')
    expect(await store.commit()).toBe(true)
    expect(store.status()?.ahead).toBe(1)

    expect(await store.push()).toBe(true)
    expect(store.error()).toBeNull()
    expect(store.pushing()).toBe(false)
    expect(store.status()?.ahead).toBe(0)

    // Pushing on a new local branch without an upstream sets one up in mock mode.
    expect(await store.checkoutBranch('feat/new-push', true)).toBe(true)
    expect(store.status()?.upstream).toBeNull()
    expect(await store.push()).toBe(true)
    expect(store.status()?.upstream).toBe('origin/feat/new-push')

    // Backend push failures surface as store errors and reset pushing state.
    const failingBackend: GitBackend = {
      status: async () => ({
        repo: true,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        entries: [],
      }),
      stage: async () => {},
      unstage: async () => {},
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {
        throw new Error('git push: failed to push some refs')
      },
      branches: async () => [],
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: async () => {},
      stashPaths: async () => {},
      stashList: async () => [],
      stashRestore: async () => {},
      stashDrop: async () => {},
      log: async () => [],
      show: async () => [],
    }
    const failingStore = createGitStore('fail-push', failingBackend)
    await failingStore.refresh()
    expect(await failingStore.push()).toBe(false)
    expect(failingStore.pushing()).toBe(false)
    expect(failingStore.error()).toContain('failed to push some refs')
  })

  it('lists preset stashes for the demo repository', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    expect(store.stashesLoading()).toBe(false)

    await store.loadStashes()

    expect(store.stashesLoading()).toBe(false)
    const stashes = store.stashes()
    expect(stashes.length).toBeGreaterThanOrEqual(2)
    expect(stashes[0].index).toBe(0)
    expect(stashes[0].refName).toBe('stash@{0}')
    expect(stashes[0].message).toContain('WIP on main')
  })

  it('stashes all changes, restores them via apply and drops the entry', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()
    await store.loadStashes()
    // One staged plus two unstaged preset changes (src/App.tsx and data/metrics.csv).
    expect(store.status()?.entries.length).toBe(3)
    const presetCount = store.stashes().length

    await store.stashAll()

    expect(store.status()?.entries.length).toBe(0)
    expect(store.stashes().length).toBe(presetCount + 1)
    expect(store.stashes()[0].refName).toBe('stash@{0}')

    // Restore (apply) reinstates the worktree state while keeping the entry
    // in the stack.
    await store.stashRestore(0)
    expect(store.stashes().length).toBe(presetCount + 1)
    expect(entryOf(store, 'README.md')).toMatchObject({ x: 'M', y: ' ' })
    expect(entryOf(store, 'src/App.tsx')).toMatchObject({ x: ' ', y: 'M' })

    // Dropping the kept entry leaves the restored worktree untouched.
    await store.stashDrop(0)
    expect(store.stashes().length).toBe(presetCount)
    expect(entryOf(store, 'README.md')).toMatchObject({ x: 'M', y: ' ' })
    expect(entryOf(store, 'src/App.tsx')).toMatchObject({ x: ' ', y: 'M' })

    // The next stashAll sweeps the worktree away again; drop only removes
    // the entry.
    await store.stashAll()
    expect(store.status()?.entries.length).toBe(0)
    expect(store.stashes().length).toBe(presetCount + 1)
    await store.stashDrop(0)
    expect(store.stashes().length).toBe(presetCount)
    expect(store.status()?.entries.length).toBe(0)
  })

  it('stashes only the selected paths and restores them', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()
    await store.loadStashes()
    const presetCount = store.stashes().length

    await store.stashPaths(['src/App.tsx'])

    expect(entryOf(store, 'README.md')).toMatchObject({ x: 'M', y: ' ' })
    expect(store.status()?.entries.some((e) => e.relPath === 'src/App.tsx')).toBe(false)
    expect(store.stashes().length).toBe(presetCount + 1)

    await store.stashRestore(0)
    expect(entryOf(store, 'src/App.tsx')).toMatchObject({ x: ' ', y: 'M' })
    expect(store.stashes().length).toBe(presetCount + 1)
  })

  it('surfaces stash failures as store errors', async () => {
    const store = createGitStore(PLAIN_PROJECT, createMockGitBackend())
    await store.refresh()

    await store.stashAll()
    expect(store.error()).toContain('not a git repository')

    // The list call mirrors the Rust backend and resolves to an empty stack
    // for folders outside version control (no error).
    await store.loadStashes()
    expect(store.stashes()).toHaveLength(0)
    expect(store.error()).toBeNull()

    await store.stashRestore(0)
    expect(store.error()).toContain('not a git repository')
    await store.stashDrop(0)
    expect(store.error()).toContain('not a git repository')
  })

  it('routes stash writes through the backend with project id and payload', async () => {
    const stashAllSpy = vi.fn(async () => {})
    const stashPathsSpy = vi.fn(async () => {})
    const stashRestoreSpy = vi.fn(async () => {})
    const stashDropSpy = vi.fn(async () => {})
    const fakeBackend: GitBackend = {
      status: async () => ({
        repo: true,
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [{ x: ' ', y: 'M', relPath: 'a.ts' }],
      }),
      stage: async () => {},
      unstage: async () => {},
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {},
      branches: async () => [],
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: stashAllSpy,
      stashPaths: stashPathsSpy,
      stashList: async () => [],
      stashRestore: stashRestoreSpy,
      stashDrop: stashDropSpy,
      log: async () => [],
      show: async () => [],
    }

    const store = createGitStore('stash-project', fakeBackend)
    await store.refresh()

    await store.stashAll('demo message')
    expect(stashAllSpy).toHaveBeenCalledWith('stash-project', 'demo message')

    // Pathspecs pass through verbatim (rename paths are resolved by the view).
    await store.refresh()
    await store.stashPaths(['new.ts', 'old.ts'])
    expect(stashPathsSpy).toHaveBeenCalledWith('stash-project', ['new.ts', 'old.ts'])

    await store.stashRestore(0)
    expect(stashRestoreSpy).toHaveBeenCalledWith('stash-project', 0)

    await store.stashDrop(1)
    expect(stashDropSpy).toHaveBeenCalledWith('stash-project', 1)
  })
})

describe('git store history (mock backend)', () => {
  it('loads the seeded commit history newest first', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    expect(store.commits()).toEqual([])
    expect(store.hasMoreCommits()).toBe(false)

    await store.ensureCommitsLoaded()

    expect(store.commitsLoading()).toBe(false)
    expect(store.commitsError()).toBeNull()
    expect(store.hasMoreCommits()).toBe(false)
    const commits = store.commits()
    expect(commits.length).toBe(3)
    expect(commits[0].subject).toBe('feat: 示例面板支持提交与推送流程')
    expect(commits[2].subject).toBe('init: 初始化示例项目')
    expect(commits.every((c) => c.sha.length === 40)).toBe(true)
    expect(commits.every((c) => c.author === 'Demo User')).toBe(true)

    // Repeated ensure does not re-fetch (commits stay the same objects).
    await store.ensureCommitsLoaded()
    expect(store.commits()).toBe(commits)
  })

  it('prepends freshly committed changes to the history', async () => {
    const store = createGitStore(DEMO_PROJECT, createMockGitBackend())
    await store.refresh()
    await store.ensureCommitsLoaded()
    expect(store.commits().length).toBe(3)

    const staged = store
      .status()!
      .entries.filter(hasStagedChanges)
      .map((e) => e.relPath)
    await store.stage(staged)
    store.setCommitMessage('feat: e2e style commit')
    expect(await store.commit()).toBe(true)

    // commit() awaits the history reload when one is already loaded.
    const commits = store.commits()
    expect(commits.length).toBe(4)
    expect(commits[0].subject).toBe('feat: e2e style commit')
    expect(commits[1].subject).toBe('feat: 示例面板支持提交与推送流程')
  })

  it('reports history errors for folders outside version control', async () => {
    const store = createGitStore(PLAIN_PROJECT, createMockGitBackend())
    await store.ensureCommitsLoaded()
    expect(store.commits()).toEqual([])
    expect(store.commitsError()).toContain('not a git repository')
    expect(store.hasMoreCommits()).toBe(false)
  })
})

describe('git store history pagination', () => {
  /** Minimal backend serving `commits` through log(); other ops are no-ops. */
  function logOnlyBackend(
    commits: GitCommitInfo[],
    calls: Array<number>,
  ): GitBackend {
    return {
      status: async () => ({
        repo: true,
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [],
      }),
      stage: async () => {},
      unstage: async () => {},
      discard: async () => {},
      commit: async () => ({ sha: 'abc1234' }),
      push: async () => {},
      branches: async () => [],
      diff: async () => [],
      checkoutBranch: async () => {},
      stashAll: async () => {},
      stashPaths: async () => {},
      stashList: async () => [],
      stashRestore: async () => {},
      stashDrop: async () => {},
      log: async (_projectId, options) => {
        const skip = options?.skip ?? 0
        calls.push(skip)
        return commits.slice(skip, skip + (options?.limit ?? 50))
      },
      show: async () => [],
    }
  }

  it('reloads a loaded history on fs deltas but not before it was opened', async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<number> = []
      const store = createGitStore('delta-history', logOnlyBackend([commitAt(1)], calls))

      await store.refresh()
      store.handleFsDelta({ affectedPaths: ['src/App.tsx'], overflow: false })
      await vi.advanceTimersByTimeAsync(500)
      // History was never opened: fs deltas must not fetch log pages.
      expect(calls).toEqual([])

      await store.ensureCommitsLoaded()
      expect(calls).toEqual([0])

      store.handleFsDelta({ affectedPaths: ['src/App.tsx'], overflow: false })
      await vi.advanceTimersByTimeAsync(500)
      expect(calls).toEqual([0, 0])
      expect(store.commits()[0].subject).toBe('commit 1')
    } finally {
      vi.useRealTimers()
    }
  })

  function commitAt(index: number): GitCommitInfo {
    return {
      sha: String(index).padStart(40, 'a'),
      shortSha: String(index).padStart(7, 'a'),
      subject: `commit ${index}`,
      body: null,
      author: 'Test',
      email: 'test@example.com',
      dateMs: 1_700_000_000 + index,
    }
  }

  it('pages through a long history via loadMoreCommits', async () => {
    const calls: Array<number> = []
    const total = COMMITS_PAGE_SIZE + 70
    const store = createGitStore('paged', logOnlyBackend(
      Array.from({ length: total }, (_, i) => commitAt(total - 1 - i)),
      calls,
    ))

    await store.ensureCommitsLoaded()
    expect(calls).toEqual([0])
    expect(store.commits().length).toBe(COMMITS_PAGE_SIZE)
    expect(store.commits()[0].subject).toBe(`commit ${total - 1}`)
    expect(store.hasMoreCommits()).toBe(true)

    await store.loadMoreCommits()
    expect(calls).toEqual([0, COMMITS_PAGE_SIZE])
    expect(store.commits().length).toBe(2 * COMMITS_PAGE_SIZE)
    expect(store.hasMoreCommits()).toBe(true)

    await store.loadMoreCommits()
    expect(calls).toEqual([0, COMMITS_PAGE_SIZE, 2 * COMMITS_PAGE_SIZE])
    expect(store.commits().length).toBe(total)
    // The tail page is short, so no further page exists.
    expect(store.hasMoreCommits()).toBe(false)

    await store.loadMoreCommits()
    expect(calls).toEqual([0, COMMITS_PAGE_SIZE, 2 * COMMITS_PAGE_SIZE])
    expect(store.commits().length).toBe(total)
  })

  it('reloadCommits replaces the list and reports backend failures', async () => {
    let fail = false
    const backend = logOnlyBackend([commitAt(1)], [])
    backend.log = async () => {
      if (fail) throw new Error('git log blew up')
      return [commitAt(1)]
    }
    const store = createGitStore('relog', backend)

    await store.ensureCommitsLoaded()
    expect(store.commits()[0].subject).toBe('commit 1')

    fail = true
    await store.reloadCommits()
    expect(store.commitsError()).toContain('git log blew up')
    // The previously loaded list stays visible beside the error.
    expect(store.commits().length).toBe(1)

    fail = false
    await store.reloadCommits()
    expect(store.commitsError()).toBeNull()
    expect(store.commits()[0].subject).toBe('commit 1')
  })
})

describe('commitFileLetter', () => {
  it('derives the status letter from the patch header', () => {
    expect(commitFileLetter('diff --git a/x b/x\nnew file mode 100644\n')).toBe('A')
    expect(commitFileLetter('diff --git a/x b/x\ndeleted file mode 100644\n')).toBe('D')
    expect(commitFileLetter('diff --git a/x b/x\nrename from old.txt\nrename to new.txt\n')).toBe('R')
    expect(commitFileLetter('diff --git a/x b/x\nindex 111..222\n--- a/x\n+++ b/x\n')).toBe('M')
  })
})
