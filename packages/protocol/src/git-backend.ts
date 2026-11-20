import { invoke } from '@tauri-apps/api/core'
import type {
  GitBackend,
  GitBranchInfo,
  GitCommitResult,
  GitDiffFile,
  GitDiffOptions,
  GitStatus,
} from './types'

/**
 * Desktop implementation backed by the system `git` executable. Every call is
 * scoped to the opened project's canonical root on the Rust side.
 */
export function createTauriGitBackend(): GitBackend {
  return {
    async status(projectId: string): Promise<GitStatus> {
      return invoke<GitStatus>('git_status', { projectId })
    },

    async stage(projectId: string, relPaths: string[]): Promise<void> {
      await invoke<void>('git_stage', { projectId, paths: relPaths })
    },

    async unstage(projectId: string, relPaths: string[]): Promise<void> {
      await invoke<void>('git_unstage', { projectId, paths: relPaths })
    },

    async discard(
      projectId: string,
      untrackedPaths: string[],
      trackedPaths: string[],
    ): Promise<void> {
      await invoke<void>('git_discard', {
        projectId,
        untrackedPaths,
        trackedPaths,
      })
    },

    async commit(projectId: string, message: string): Promise<GitCommitResult> {
      return invoke<GitCommitResult>('git_commit', { projectId, message })
    },

    async push(projectId: string): Promise<void> {
      await invoke<void>('git_push', { projectId })
    },

    async diff(projectId: string, options: GitDiffOptions): Promise<GitDiffFile[]> {
      return invoke<GitDiffFile[]>('git_diff', {
        projectId,
        staged: options.staged,
        paths: options.relPaths ?? [],
      })
    },

    async branches(projectId: string): Promise<GitBranchInfo[]> {
      return invoke<GitBranchInfo[]>('git_branches', { projectId })
    },

    async checkoutBranch(
      projectId: string,
      name: string,
      create = false,
    ): Promise<void> {
      await invoke<void>('git_checkout_branch', { projectId, name, create })
    },
  }
}

interface MockGitRepoState {
  repo: boolean
  branch: string
  upstream: string
  branches: GitBranchInfo[]
  /** Staged entries: relPath -> status letter in the index column. */
  staged: Map<string, string>
  /** Unstaged tracked entries: relPath -> worktree status letter. */
  unstaged: Map<string, string>
  untracked: Set<string>
  commitCount: number
}

const MOCK_REPO_INITIAL: Record<string, Partial<MockGitRepoState>> = {
  // The demo repo starts with one staged and one unstaged modification so the
  // panel (and its e2e coverage) has meaningful state in browser mock mode.
  'mock-lite-ide': {
    repo: true,
    branch: 'main',
    upstream: 'origin/main',
    branches: [
      { name: 'main', current: true, remote: false, upstream: 'origin/main' },
      { name: 'feat/demo', current: false, remote: false, upstream: null },
      { name: 'fix/scroll', current: false, remote: false, upstream: null },
      { name: 'origin/main', current: false, remote: true, upstream: null },
      { name: 'origin/release', current: false, remote: true, upstream: null },
    ],
    staged: new Map([['README.md', 'M']]),
    unstaged: new Map([['src/App.tsx', 'M']]),
    untracked: new Set(),
  },
}

function defaultMockState(): MockGitRepoState {
  return {
    repo: false,
    branch: 'main',
    upstream: '',
    branches: [],
    staged: new Map(),
    unstaged: new Map(),
    untracked: new Set(),
    commitCount: 0,
  }
}

/**
 * Deterministic pseudo-patch so consumers (AI commit-message generation and
 * its e2e coverage) always see a plausible unified diff in mock mode.
 */
function buildMockPatch(relPath: string, letter: string): string {
  const name = relPath.split('/').pop() ?? relPath
  if (letter === 'A') {
    return [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      'index 0000000..1a2b3c4',
      '--- /dev/null',
      `+++ b/${relPath}`,
      '@@ -0,0 +1,1 @@',
      `+// added ${name}`,
    ].join('\n')
  }
  if (letter === 'D') {
    return [
      `diff --git a/${relPath} b/${relPath}`,
      'deleted file mode 100644',
      'index 1a2b3c4..0000000',
      `--- a/${relPath}`,
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      `-// removed ${name}`,
    ].join('\n')
  }
  return [
    `diff --git a/${relPath} b/${relPath}`,
    'index 1a2b3c4..5d6e7f8 100644',
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    '@@ -1,1 +1,1 @@',
    `-// original ${name}`,
    `+// modified ${name}`,
  ].join('\n')
}

/**
 * In-memory simulation used by the pure-browser mock mode: state is created
 * per repository on first touch and lives for the page session. Repos without
 * a preset report `repo: false`, mirroring folders outside version control.
 */
export function createMockGitBackend(): GitBackend {
  const repoStates = new Map<string, MockGitRepoState>()

  function getState(projectId: string): MockGitRepoState {
    let state = repoStates.get(projectId)
    if (!state) {
      state = { ...defaultMockState(), ...(MOCK_REPO_INITIAL[projectId] ?? {}) }
      state.staged = new Map(MOCK_REPO_INITIAL[projectId]?.staged ?? [])
      state.unstaged = new Map(MOCK_REPO_INITIAL[projectId]?.unstaged ?? [])
      state.untracked = new Set(MOCK_REPO_INITIAL[projectId]?.untracked ?? [])
      state.branches = (MOCK_REPO_INITIAL[projectId]?.branches ?? []).map((b) => ({ ...b }))
      repoStates.set(projectId, state)
    }
    return state
  }

  function buildStatus(state: MockGitRepoState): GitStatus {
    // Merge per-path state into single XY entries, mirroring the real
    // porcelain shape (one row can carry both staged and unstaged letters).
    const byPath = new Map<string, { x: string; y: string }>()
    for (const [relPath, y] of state.unstaged) {
      byPath.set(relPath, { x: ' ', y })
    }
    for (const [relPath, x] of state.staged) {
      const existing = byPath.get(relPath)
      byPath.set(relPath, { x, y: existing?.y ?? ' ' })
    }
    for (const relPath of state.untracked) {
      byPath.set(relPath, { x: '?', y: '?' })
    }
    const entries = [...byPath].map(([relPath, xy]) => ({ ...xy, relPath }))
    return {
      repo: state.repo,
      branch: state.repo ? state.branch : null,
      upstream: state.repo && state.upstream ? state.upstream : null,
      ahead: state.commitCount,
      behind: 0,
      entries,
    }
  }

  return {
    async status(projectId: string): Promise<GitStatus> {
      return buildStatus(getState(projectId))
    },

    async stage(projectId: string, relPaths: string[]): Promise<void> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      for (const relPath of relPaths) {
        const unstaged = state.unstaged.get(relPath)
        if (unstaged !== undefined) {
          if (state.staged.get(relPath) !== 'A') {
            state.staged.set(relPath, unstaged)
          }
          state.unstaged.delete(relPath)
        } else if (state.untracked.has(relPath)) {
          state.untracked.delete(relPath)
          state.staged.set(relPath, 'A')
        }
      }
    },

    async unstage(projectId: string, relPaths: string[]): Promise<void> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      for (const relPath of relPaths) {
        const staged = state.staged.get(relPath)
        if (staged === undefined) continue
        state.staged.delete(relPath)
        if (staged === 'A') {
          state.untracked.add(relPath)
          state.unstaged.delete(relPath)
        } else {
          state.unstaged.set(relPath, staged)
        }
      }
    },

    async discard(
      projectId: string,
      untrackedPaths: string[],
      trackedPaths: string[],
    ): Promise<void> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      for (const relPath of untrackedPaths) {
        state.untracked.delete(relPath)
      }
      for (const relPath of trackedPaths) {
        state.unstaged.delete(relPath)
      }
    },

    async commit(projectId: string, message: string): Promise<GitCommitResult> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      if (!message.trim()) throw new Error('commit message must not be empty')
      if (state.staged.size === 0) {
        throw new Error('nothing to commit, working tree clean')
      }
      state.staged.clear()
      state.commitCount += 1
      // Deterministic pseudo-sha so assertions stay stable across runs.
      const sha = (0x1000000 + state.commitCount * 0x9e3779)
        .toString(16)
        .padStart(7, '0')
      return { sha }
    },

    async push(projectId: string): Promise<void> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      if (!state.branch) throw new Error('HEAD is detached')
      if (!state.upstream) {
        const remoteName = `origin/${state.branch}`
        state.upstream = remoteName
        const localBranch = state.branches.find((b) => !b.remote && b.name === state.branch)
        if (localBranch) {
          localBranch.upstream = remoteName
        }
        if (!state.branches.some((b) => b.remote && b.name === remoteName)) {
          state.branches.push({
            name: remoteName,
            current: false,
            remote: true,
            upstream: null,
          })
        }
      }
      state.commitCount = 0
    },

    async diff(projectId: string, options: GitDiffOptions): Promise<GitDiffFile[]> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      const wanted = options.relPaths
      const files: GitDiffFile[] = []
      // Untracked files have no diff content (mirrors real `git diff`).
      const source = options.staged ? state.staged : state.unstaged
      for (const [relPath, letter] of source) {
        if (wanted && !wanted.includes(relPath)) continue
        files.push({ relPath, patch: buildMockPatch(relPath, letter) })
      }
      return files
    },

    async branches(projectId: string): Promise<GitBranchInfo[]> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      return state.branches
        .map((b) => ({ ...b }))
        .sort((a, b) => {
          if (a.current !== b.current) return a.current ? -1 : 1
          if (a.remote !== b.remote) return a.remote ? 1 : -1
          return a.name.localeCompare(b.name)
        })
    },

    async checkoutBranch(
      projectId: string,
      name: string,
      create = false,
    ): Promise<void> {
      const state = getState(projectId)
      if (!state.repo) throw new Error('not a git repository')
      if (!name || name.startsWith('-') || /\s/.test(name)) {
        throw new Error(`invalid branch name '${name}'`)
      }

      if (create) {
        if (state.branches.some((b) => !b.remote && b.name === name)) {
          throw new Error(`fatal: a branch named '${name}' already exists`)
        }
        for (const b of state.branches) b.current = false
        state.branches.push({
          name,
          current: true,
          remote: false,
          upstream: null,
        })
        state.branch = name
        state.upstream = ''
        return
      }

      const localTarget = state.branches.find((b) => !b.remote && b.name === name)
      if (localTarget) {
        for (const b of state.branches) b.current = false
        localTarget.current = true
        state.branch = localTarget.name
        state.upstream = localTarget.upstream ?? ''
        return
      }

      const remoteTarget = state.branches.find((b) => b.remote && b.name === name)
      if (remoteTarget) {
        const slashIdx = name.indexOf('/')
        const localName = slashIdx === -1 ? name : name.slice(slashIdx + 1)
        const existingLocal = state.branches.find((b) => !b.remote && b.name === localName)
        for (const b of state.branches) b.current = false
        if (existingLocal) {
          existingLocal.current = true
          state.branch = existingLocal.name
          state.upstream = existingLocal.upstream ?? ''
        } else {
          state.branches.push({
            name: localName,
            current: true,
            remote: false,
            upstream: remoteTarget.name,
          })
          state.branch = localName
          state.upstream = remoteTarget.name
        }
        return
      }

      throw new Error(`error: pathspec '${name}' did not match any file(s) known to git`)
    },
  }
}
