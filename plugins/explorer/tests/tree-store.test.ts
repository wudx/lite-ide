import type { DirEntry, WorkspaceBackend } from '@lite-ide/protocol'
import { createRoot } from 'solid-js'
import { describe, expect, it, vi } from 'vitest'
import { createFileTreeStore, CREATING_PLACEHOLDER_PATH } from '../src/tree-store'

function makeEntry(name: string, relPath: string, isDir: boolean, ignored = false): DirEntry {
  return {
    name,
    relPath,
    isDir,
    size: isDir ? 0 : 128,
    modifiedMs: 1000,
    ignored,
    hidden: name.startsWith('.'),
  }
}

function createFakeBackend(initialTree: Record<string, DirEntry[]>): WorkspaceBackend {
  const tree: Record<string, DirEntry[]> = {}
  for (const [k, v] of Object.entries(initialTree)) {
    tree[k] = v.map((e) => ({ ...e }))
  }

  return {
    kind: 'mock',
    openProject: vi.fn(),
    closeProject: vi.fn(),
    listDir: vi.fn(async (_projectId: string, relPath: string) =>
      (tree[relPath] ?? []).map((e) => ({ ...e })),
    ),
    statPreview: vi.fn(),
    readText: vi.fn(),
    writeText: vi.fn(),
    createFile: vi.fn(async (projectId: string, relPath: string) => {
      const idx = relPath.lastIndexOf('/')
      const parent = idx === -1 ? '' : relPath.slice(0, idx)
      const name = idx === -1 ? relPath : relPath.slice(idx + 1)
      tree[parent] = [...(tree[parent] ?? []), makeEntry(name, relPath, false)]
      return {
        projectId,
        relPath,
        name,
        ext: name.includes('.') ? name.split('.').pop()! : '',
        size: 0,
        modifiedMs: 2000,
        mime: 'text/plain',
        isBinary: false,
        encoding: 'utf-8',
      }
    }),
    createDir: vi.fn(async (_projectId: string, relPath: string) => {
      const idx = relPath.lastIndexOf('/')
      const parent = idx === -1 ? '' : relPath.slice(0, idx)
      const name = idx === -1 ? relPath : relPath.slice(idx + 1)
      const entry = makeEntry(name, relPath, true)
      tree[parent] = [entry, ...(tree[parent] ?? [])]
      tree[relPath] = []
      return entry
    }),
    renamePath: vi.fn(async (_projectId: string, oldRelPath: string, newRelPath: string) => {
      const oldParent = oldRelPath.includes('/')
        ? oldRelPath.slice(0, oldRelPath.lastIndexOf('/'))
        : ''
      const newName = newRelPath.split('/').pop()!
      let isDir = false
      tree[oldParent] = (tree[oldParent] ?? []).map((e) => {
        if (e.relPath === oldRelPath) {
          isDir = e.isDir
          return { ...e, name: newName, relPath: newRelPath }
        }
        return e
      })
      if (isDir && tree[oldRelPath]) {
        tree[newRelPath] = tree[oldRelPath].map((c) => ({
          ...c,
          relPath: `${newRelPath}/${c.name}`,
        }))
        delete tree[oldRelPath]
      }
      return makeEntry(newName, newRelPath, isDir)
    }),
    deletePath: vi.fn(async (_projectId: string, relPath: string) => {
      const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      tree[parent] = (tree[parent] ?? []).filter((e) => e.relPath !== relPath)
      delete tree[relPath]
    }),
    pickFolder: vi.fn(),
  }
}

describe('FileTreeStore', () => {
  it('lazily loads directories on expand and flattens visible hierarchy', async () => {
    const backend = createFakeBackend({
      '': [
        makeEntry('src', 'src', true),
        makeEntry('dist', 'dist', true, true),
        makeEntry('README.md', 'README.md', false),
      ],
      src: [makeEntry('main.ts', 'src/main.ts', false)],
      dist: [makeEntry('out.js', 'dist/out.js', false, true)],
    })

    const { store, dispose } = createRoot((d) => ({
      store: createFileTreeStore('p1', backend),
      dispose: d,
    }))
    try {
      await store.ensureRootLoaded()
      expect(backend.listDir).toHaveBeenCalledTimes(1)
      expect(store.visibleNodes().map((n) => n.entry.relPath)).toEqual([
        'src',
        'dist',
        'README.md',
      ])

      await store.expandDir('src')
      expect(backend.listDir).toHaveBeenCalledWith('p1', 'src')
      expect(store.visibleNodes().map((n) => [n.entry.relPath, n.depth])).toEqual([
        ['src', 0],
        ['src/main.ts', 1],
        ['dist', 0],
        ['README.md', 0],
      ])

      store.setShowIgnored(false)
      expect(store.visibleNodes().map((n) => n.entry.relPath)).toEqual([
        'src',
        'src/main.ts',
        'README.md',
      ])

      store.setFilterQuery('main')
      expect(store.visibleNodes().map((n) => n.entry.relPath)).toEqual([
        'src',
        'src/main.ts',
      ])

      store.setFilterQuery('')
      store.collapseAll()
      expect(store.visibleNodes().map((n) => n.entry.relPath)).toEqual([
        'src',
        'README.md',
      ])
    } finally {
      dispose()
    }
  })

  it('refreshes only affected and currently expanded directories on FsDelta', async () => {
    const backend = createFakeBackend({
      '': [makeEntry('src', 'src', true), makeEntry('docs', 'docs', true)],
      src: [makeEntry('a.ts', 'src/a.ts', false)],
      docs: [makeEntry('guide.md', 'docs/guide.md', false)],
    })

    const { store, dispose } = createRoot((d) => ({
      store: createFileTreeStore('p1', backend),
      dispose: d,
    }))
    try {
      await store.ensureRootLoaded()
      await store.expandDir('src')
      vi.mocked(backend.listDir).mockClear()

      // `docs` was never expanded, so a change inside `docs` should not trigger an IPC read.
      await store.handleFsDelta({
        projectId: 'p1',
        affectedDirs: ['docs', 'src'],
        affectedPaths: ['docs/guide.md', 'src/a.ts'],
        overflow: false,
      })

      expect(backend.listDir).toHaveBeenCalledTimes(1)
      expect(backend.listDir).toHaveBeenCalledWith('p1', 'src')
    } finally {
      dispose()
    }
  })

  it('supports inline create, rename with expanded subtree migration, and delete', async () => {
    const backend = createFakeBackend({
      '': [makeEntry('src', 'src', true), makeEntry('README.md', 'README.md', false)],
      src: [makeEntry('old.ts', 'src/old.ts', false)],
    })

    const { store, dispose } = createRoot((d) => ({
      store: createFileTreeStore('p1', backend),
      dispose: d,
    }))
    try {
      await store.ensureRootLoaded()
      await store.startCreate('file', 'src')
      expect(store.visibleNodes().some((n) => n.entry.relPath === CREATING_PLACEHOLDER_PATH)).toBe(
        true,
      )

      // Invalid name fails validation and preserves pending action.
      expect(await store.commitCreate('bad/name.ts')).toBeNull()
      expect(store.actionError()).toBeTruthy()
      expect(store.pendingAction()).not.toBeNull()

      const created = await store.commitCreate('new.ts')
      expect(created).toEqual({ relPath: 'src/new.ts', isDir: false })
      expect(store.visibleNodes().some((n) => n.entry.relPath === 'src/new.ts')).toBe(true)

      // Rename expanded directory `src` -> `app` preserves expansion & updates child paths.
      store.startRename('src', true, 'src')
      const renamed = await store.commitRename('app')
      expect(renamed).toEqual({ oldRelPath: 'src', newRelPath: 'app', isDir: true })
      expect(store.visibleNodes().map((n) => n.entry.relPath)).toEqual([
        'app',
        'app/old.ts',
        'app/new.ts',
        'README.md',
      ])

      // Delete file updates visible tree and clears focus.
      store.setFocusedPath('app/new.ts')
      expect(await store.deleteEntry('app/new.ts', false)).toBe(true)
      expect(store.focusedPath()).toBeNull()
      expect(store.visibleNodes().some((n) => n.entry.relPath === 'app/new.ts')).toBe(false)
    } finally {
      dispose()
    }
  })
})
