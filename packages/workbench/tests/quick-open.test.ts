import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend, MOCK_DEMO_PATHS } from '@lite-ide/protocol'
import {
  buildFileIndex,
  createQuickOpenService,
  QUICK_OPEN_MAX_RESULTS,
  scoreQuickOpenMatch,
  searchQuickOpen,
  type QuickOpenFileEntry,
} from '../src/quick-open'

describe('createQuickOpenService', () => {
  it('starts closed and toggles open/close', () => {
    const service = createQuickOpenService()
    expect(service.isOpen()).toBe(false)
    service.open()
    expect(service.isOpen()).toBe(true)
    service.close()
    expect(service.isOpen()).toBe(false)
  })
})

describe('buildFileIndex', () => {
  let backend = createMockBackend()
  let info = { id: '' }

  beforeEach(async () => {
    backend = createMockBackend()
    info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
  })

  it('collects files recursively and skips gitignored entries', async () => {
    const { files, failedDirCount } = await buildFileIndex(backend, info.id)
    const relPaths = files.map((f) => f.relPath)

    expect(failedDirCount).toBe(0)
    expect(relPaths).toContain('README.md')
    expect(relPaths).toContain('src/kernel.ts')
    expect(relPaths).toContain('assets/architecture.svg')
    // dist/ is gitignored in the demo template.
    expect(relPaths).not.toContain('dist/bundle.log')
    // Every indexed entry carries its basename.
    for (const file of files) {
      expect(file.name).toBe(file.relPath.split('/').pop())
    }
  })

  it('rescans the tree after files change', async () => {
    const before = await buildFileIndex(backend, info.id)
    expect(before.files.map((f) => f.relPath)).not.toContain('notes/todo.md')

    await backend.createDir(info.id, 'notes')
    await backend.createFile(info.id, 'notes/todo.md')
    const after = await buildFileIndex(backend, info.id)
    expect(after.files.map((f) => f.relPath)).toContain('notes/todo.md')
  })

  it('throws when the root directory cannot be listed', async () => {
    // A closed backend session rejects every listing, including the root.
    await backend.closeProject(info.id)
    await expect(buildFileIndex(backend, info.id)).rejects.toThrow()
  })
})

describe('scoreQuickOpenMatch', () => {
  it('rejects non-subsequence queries', () => {
    expect(scoreQuickOpenMatch('src/kernel.ts', 'xyz')).toBeNull()
    expect(scoreQuickOpenMatch('README.md', 'readmex')).toBeNull()
    expect(scoreQuickOpenMatch('README.md', '')).toBeNull()
  })

  it('matches case-insensitively as a subsequence', () => {
    const match = scoreQuickOpenMatch('src/kernel.ts', 'KERN')
    expect(match).not.toBeNull()
    expect(match?.indices).toEqual([4, 5, 6, 7])
  })

  it('prefers basename matches over directory-path matches', () => {
    const basename = scoreQuickOpenMatch('src/utils/helpers.ts', 'helpers')
    const dirPath = scoreQuickOpenMatch('helpers/deep/module.ts', 'helpers')
    expect(basename?.score ?? 0).toBeGreaterThan(dirPath?.score ?? 0)
  })

  it('prefers consecutive matches over scattered ones', () => {
    const consecutive = scoreQuickOpenMatch('src/app.tsx', 'app')
    // a-p-p spread across the path instead of adjacent.
    const scattered = scoreQuickOpenMatch('src/apx-pxq.tsx', 'app')
    expect(scattered).not.toBeNull()
    expect(consecutive?.score ?? 0).toBeGreaterThan(scattered?.score ?? 0)
  })

  it('prefers shorter paths for equal-quality matches', () => {
    const short = scoreQuickOpenMatch('a/app.ts', 'app')
    const long = scoreQuickOpenMatch('a/very/deeply/nested/folder/app.ts', 'app')
    expect(short?.score ?? 0).toBeGreaterThan(long?.score ?? 0)
  })

  it('aligns matches into the basename when the directory competes for characters', () => {
    // 'r' exists both in the dir name and the basename; basename must win.
    const match = scoreQuickOpenMatch('src/readme.md', 'readme')
    expect(match).not.toBeNull()
    expect(match?.indices).toEqual([4, 5, 6, 7, 8, 9])

    // A dir name sharing the query's first letter must not skew the score:
    // both paths align identically inside their basename.
    const shared = scoreQuickOpenMatch('a/app.ts', 'app')
    const clean = scoreQuickOpenMatch('b/app.ts', 'app')
    expect(shared?.score).toBe(clean?.score ?? 0)
  })
})

describe('searchQuickOpen', () => {
  const files: QuickOpenFileEntry[] = [
    { relPath: 'src/kernel.ts', name: 'kernel.ts', modifiedMs: 100 },
    { relPath: 'README.md', name: 'README.md', modifiedMs: 300 },
    { relPath: 'src/App.tsx', name: 'App.tsx', modifiedMs: 200 },
    { relPath: 'package.json', name: 'package.json', modifiedMs: 400 },
  ]

  it('returns recent files first on an empty query', () => {
    const results = searchQuickOpen(files, '')
    expect(results.map((r) => r.entry.relPath)).toEqual([
      'package.json',
      'README.md',
      'src/App.tsx',
      'src/kernel.ts',
    ])
  })

  it('filters and ranks by the query', () => {
    const results = searchQuickOpen(files, 'kernel')
    expect(results).toHaveLength(1)
    expect(results[0].entry.relPath).toBe('src/kernel.ts')
    expect(results[0].indices.length).toBeGreaterThan(0)
  })

  it('handles subsequence queries across path segments', () => {
    const results = searchQuickOpen(files, 'sa')
    const relPaths = results.map((r) => r.entry.relPath)
    expect(relPaths).toContain('src/App.tsx')
    expect(relPaths).not.toContain('package.json')
  })

  it('caps results at the limit', () => {
    const many: QuickOpenFileEntry[] = Array.from({ length: 120 }, (_, i) => ({
      relPath: `src/file${i}.ts`,
      name: `file${i}.ts`,
      modifiedMs: i,
    }))
    expect(searchQuickOpen(many, 'file')).toHaveLength(QUICK_OPEN_MAX_RESULTS)
    expect(searchQuickOpen(many, '')).toHaveLength(QUICK_OPEN_MAX_RESULTS)
  })
})
