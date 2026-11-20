import { createMockGitBackend, type GitBackend, type GitStatus } from '@lite-ide/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
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
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(0)

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
    // The commit includes every staged entry (README.md and src/App.tsx).
    expect(store.status()?.entries).toHaveLength(0)
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
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(2)
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(0)

    // Calling stageAll again when nothing is unstaged is a safe no-op.
    await store.stageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(2)

    await store.unstageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(0)
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(2)

    // Calling unstageAll again when nothing is staged is a safe no-op.
    await store.unstageAll()
    expect(store.status()?.entries.filter(hasUnstagedChanges)).toHaveLength(2)

    await store.stageAll()
    expect(store.status()?.entries.filter(hasStagedChanges)).toHaveLength(2)
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
      branches: async () => [],
      checkoutBranch: async () => {},
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
      branches: async () => [],
      checkoutBranch: async () => {},
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
      checkoutBranch: async () => {},
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
})
