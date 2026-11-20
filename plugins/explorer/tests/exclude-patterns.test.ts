import { describe, expect, it } from 'vitest'
import {
  compileExcludeRule,
  createExplorerExcludeService,
  EXCLUDE_STORAGE_KEY,
  globToRegExp,
  sanitizeExcludePatterns,
} from '../src/exclude-patterns'

function entry(name: string, relPath: string, isDir: boolean) {
  return { name, relPath, isDir }
}

describe('globToRegExp', () => {
  it('supports *, ** and ? wildcards with full-string anchoring', () => {
    expect(globToRegExp('*.meta').test('scene.meta')).toBe(true)
    expect(globToRegExp('*.meta').test('App.tsx.meta')).toBe(true)
    expect(globToRegExp('*.meta').test('metadata')).toBe(false)
    expect(globToRegExp('*.meta').test('assets/scene.meta')).toBe(false)

    expect(globToRegExp('**/temp').test('temp')).toBe(true)
    expect(globToRegExp('**/temp').test('a/b/temp')).toBe(true)
    expect(globToRegExp('a/**/d').test('a/d')).toBe(true)
    expect(globToRegExp('a/**/d').test('a/b/c/d')).toBe(true)

    expect(globToRegExp('file?.ts').test('file1.ts')).toBe(true)
    expect(globToRegExp('file?.ts').test('file10.ts')).toBe(false)
  })

  it('escapes literal regex characters', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false)
    expect(globToRegExp('a.b').test('a.b')).toBe(true)
    expect(globToRegExp('(x)').test('(x)')).toBe(true)
  })
})

describe('compileExcludeRule', () => {
  it('marks trailing-slash patterns as dir-only and slash-containing patterns as path-scoped', () => {
    // 尾随 `/` 只表达目录限定，不参与路径锚定（gitignore 惯例）。
    const dirOnly = compileExcludeRule('build/')
    expect(dirOnly.dirOnly).toBe(true)
    expect(dirOnly.pathScoped).toBe(false)

    const pathScoped = compileExcludeRule('src/*.tmp')
    expect(pathScoped.dirOnly).toBe(false)
    expect(pathScoped.pathScoped).toBe(true)

    const nameScoped = compileExcludeRule('*.log')
    expect(nameScoped.dirOnly).toBe(false)
    expect(nameScoped.pathScoped).toBe(false)
  })

  it('treats a leading slash as root anchoring', () => {
    const anchored = compileExcludeRule('/build')
    expect(anchored.pathScoped).toBe(true)
    expect(anchored.regex.test('build')).toBe(true)
    expect(anchored.regex.test('lib/build')).toBe(false)
  })
})

describe('sanitizeExcludePatterns', () => {
  it('trims, drops empty lines and dedupes preserving order', () => {
    expect(sanitizeExcludePatterns(['  *.meta ', '', '*.meta', 'node_modules', '   '])).toEqual([
      '*.meta',
      'node_modules',
    ])
  })
})

describe('createExplorerExcludeService', () => {
  it('matches entries by name, relPath and dir-only rules', () => {
    const service = createExplorerExcludeService()
    service.setPatterns(['*.meta', 'node_modules', 'build/', 'src/*.tmp'])

    expect(service.matches(entry('scene.meta', 'scene.meta', false))).toBe(true)
    expect(service.matches(entry('logo.psd.meta', 'assets/logo.psd.meta', false))).toBe(true)
    expect(service.matches(entry('kernel.ts', 'src/kernel.ts', false))).toBe(false)

    expect(service.matches(entry('node_modules', 'lib/node_modules', true))).toBe(true)
    expect(service.matches(entry('node_modules', 'node_modules', false))).toBe(true)

    expect(service.matches(entry('build', 'build', true))).toBe(true)
    expect(service.matches(entry('build', 'build', false))).toBe(false)

    expect(service.matches(entry('a.tmp', 'src/a.tmp', false))).toBe(true)
    expect(service.matches(entry('a.tmp', 'lib/a.tmp', false))).toBe(false)

    // 根目录锚定：只隐藏根下的同名条目。
    service.setPatterns(['/build'])
    expect(service.matches(entry('build', 'build', true))).toBe(true)
    expect(service.matches(entry('build', 'lib/build', true))).toBe(false)

    // 空规则集不隐藏任何条目。
    service.setPatterns([])
    expect(service.matches(entry('scene.meta', 'scene.meta', false))).toBe(false)
  })

  it('sanitizes on write and persists across instances via localStorage', () => {
    localStorage.removeItem(EXCLUDE_STORAGE_KEY)
    try {
      const service = createExplorerExcludeService()
      expect(service.patterns()).toEqual([])

      service.setPatterns([' *.meta ', '', '*.meta'])
      expect(service.patterns()).toEqual(['*.meta'])
      expect(localStorage.getItem(EXCLUDE_STORAGE_KEY)).toBe(JSON.stringify(['*.meta']))

      // 新实例（重载 / 内核重建）从存储恢复。
      const revived = createExplorerExcludeService()
      expect(revived.patterns()).toEqual(['*.meta'])

      // 存储损坏时回退为空集而不是抛错。
      localStorage.setItem(EXCLUDE_STORAGE_KEY, '{broken json')
      expect(createExplorerExcludeService().patterns()).toEqual([])
    } finally {
      localStorage.removeItem(EXCLUDE_STORAGE_KEY)
    }
  })
})
