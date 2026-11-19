import type { DirEntry, WorkspaceBackend } from '@lite-ide/protocol'
import { createRoot } from 'solid-js'
import { describe, expect, it, vi } from 'vitest'
import { createFileTreeStore } from '../src/tree-store'

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

function createFakeBackend(tree: Record<string, DirEntry[]>): WorkspaceBackend {
  return {
    kind: 'mock',
    openProject: vi.fn(),
    closeProject: vi.fn(),
    listDir: vi.fn(async (_projectId: string, relPath: string) => tree[relPath] ?? []),
    statPreview: vi.fn(),
    readText: vi.fn(),
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
})
