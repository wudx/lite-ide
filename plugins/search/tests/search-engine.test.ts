import { describe, expect, it } from 'vitest'
import {
  compileSearchPattern,
  computeReplacementPreview,
  hasNullByte,
  isLikelyBinaryPath,
  parseFilterPatterns,
  replaceAllInContent,
  replaceSingleMatchInContent,
  searchFileContent,
  shouldIncludeRelPath,
} from '../src/search-engine'

describe('compileSearchPattern', () => {
  it('returns null for empty query', () => {
    expect(
      compileSearchPattern({
        query: '',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      }),
    ).toBeNull()
  })

  it('compiles literal queries case-insensitively by default', () => {
    const res = compileSearchPattern({
      query: 'a.b[0]',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    })
    expect(res?.ok).toBe(true)
    if (!res || !res.ok) return
    expect('A.B[0]'.match(res.pattern.regex)).toEqual(['A.B[0]'])
    expect('axb0'.match(res.pattern.regex)).toBeNull()
  })

  it('respects caseSensitive and wholeWord options', () => {
    const res = compileSearchPattern({
      query: 'Store',
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
    })
    expect(res?.ok).toBe(true)
    if (!res || !res.ok) return

    const matches = searchFileContent(
      'src/a.ts',
      'const Store = new FileStore()\nconst store = Store',
      res.pattern,
    )
    expect(matches.map((m) => [m.line, m.column])).toEqual([
      [1, 7],
      [2, 15],
    ])
  })

  it('handles wholeWord with non-word boundary symbols cleanly', () => {
    const res = compileSearchPattern({
      query: '->',
      caseSensitive: false,
      wholeWord: true,
      useRegex: false,
    })
    expect(res?.ok).toBe(true)
    if (!res || !res.ok) return
    const matches = searchFileContent('main.rs', 'fn foo() -> i32 {}', res.pattern)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.matchText).toBe('->')
  })

  it('reports invalid regular expressions cleanly', () => {
    const res = compileSearchPattern({
      query: '[unclosed',
      caseSensitive: false,
      wholeWord: false,
      useRegex: true,
    })
    expect(res?.ok).toBe(false)
  })
})

describe('searchFileContent', () => {
  it('finds multiple matches per line with exact 1-based line and column', () => {
    const compiled = compileSearchPattern({
      query: 'foo',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    })
    if (!compiled || !compiled.ok) throw new Error('expected valid pattern')

    const matches = searchFileContent('test.ts', 'foo bar Foo\n  baz foo', compiled.pattern)
    expect(matches).toEqual([
      {
        id: 'test.ts:1:1',
        relPath: 'test.ts',
        line: 1,
        column: 1,
        length: 3,
        matchText: 'foo',
        lineText: 'foo bar Foo',
        lineOffset: 0,
      },
      {
        id: 'test.ts:1:9',
        relPath: 'test.ts',
        line: 1,
        column: 9,
        length: 3,
        matchText: 'Foo',
        lineText: 'foo bar Foo',
        lineOffset: 8,
      },
      {
        id: 'test.ts:2:7',
        relPath: 'test.ts',
        line: 2,
        column: 7,
        length: 3,
        matchText: 'foo',
        lineText: '  baz foo',
        lineOffset: 6,
      },
    ])
  })

  it('guards against zero-width regex loops and respects remainingBudget', () => {
    const compiled = compileSearchPattern({
      query: 'a*',
      caseSensitive: false,
      wholeWord: false,
      useRegex: true,
    })
    if (!compiled || !compiled.ok) throw new Error('expected valid pattern')

    const matches = searchFileContent('test.ts', 'aba\naaa\na', compiled.pattern, 2)
    expect(matches).toHaveLength(2)
    expect(matches.map((m) => m.matchText)).toEqual(['a', 'a'])
  })

  it('skips files containing null bytes', () => {
    const compiled = compileSearchPattern({
      query: 'hello',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    })
    if (!compiled || !compiled.ok) throw new Error('expected valid pattern')

    expect(hasNullByte('hello\0world')).toBe(true)
    expect(searchFileContent('bin.dat', 'hello\0world', compiled.pattern)).toEqual([])
  })
})

describe('filter patterns', () => {
  it('matches folder prefixes, basenames, and globs', () => {
    const include = parseFilterPatterns('src, *.md')
    const exclude = parseFilterPatterns('src/ignored/**, *.test.ts')

    expect(shouldIncludeRelPath('src/kernel.ts', include, exclude)).toBe(true)
    expect(shouldIncludeRelPath('README.md', include, exclude)).toBe(true)
    expect(shouldIncludeRelPath('src/kernel.test.ts', include, exclude)).toBe(false)
    expect(shouldIncludeRelPath('src/ignored/a.ts', include, exclude)).toBe(false)
    expect(shouldIncludeRelPath('package.json', include, exclude)).toBe(false)
  })

  it('identifies likely binary extensions', () => {
    expect(isLikelyBinaryPath('assets/logo.png')).toBe(true)
    expect(isLikelyBinaryPath('assets/chime.wav')).toBe(true)
    expect(isLikelyBinaryPath('assets/architecture.svg')).toBe(false)
    expect(isLikelyBinaryPath('src/index.ts')).toBe(false)
  })
})

describe('replace helpers', () => {
  it('replaces single and all occurrences while preserving CRLF line endings', () => {
    const compiled = compileSearchPattern({
      query: 'foo',
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    })
    if (!compiled || !compiled.ok) throw new Error('expected valid pattern')

    const original = 'const foo = foo + 1\r\nreturn foo\r\n'
    const matches = searchFileContent('a.ts', original, compiled.pattern)
    expect(matches).toHaveLength(3)

    // Literal $ in replacement should not be treated as a capture group.
    const single = replaceSingleMatchInContent(original, matches[1]!, compiled.pattern, '$bar')
    expect(single).toBe('const foo = $bar + 1\r\nreturn foo\r\n')

    // Stale match returns null.
    expect(replaceSingleMatchInContent(single!, matches[1]!, compiled.pattern, 'x')).toBeNull()

    const all = replaceAllInContent(original, compiled.pattern, 'qux')
    expect(all).toEqual({
      nextContent: 'const qux = qux + 1\r\nreturn qux\r\n',
      count: 3,
    })
  })

  it('expands capture groups and lookarounds in regex replacement mode', () => {
    const compiled = compileSearchPattern({
      query: 'fn (\\w+)',
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    })
    if (!compiled || !compiled.ok) throw new Error('expected valid pattern')

    const matches = searchFileContent('a.rs', 'fn alpha() {}\nfn beta() {}', compiled.pattern)
    expect(matches).toHaveLength(2)
    expect(computeReplacementPreview(matches[0]!, 'async fn $1', compiled.pattern)).toBe(
      'async fn alpha',
    )
    const res = replaceAllInContent('fn alpha() {}\nfn beta() {}', compiled.pattern, 'pub fn $1')
    expect(res).toEqual({
      nextContent: 'pub fn alpha() {}\npub fn beta() {}',
      count: 2,
    })

    // Lookbehind regexes must evaluate identically in preview, single replace, and replaceAll.
    const lookbehind = compileSearchPattern({
      query: '(?<=const )\\w+',
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    })
    if (!lookbehind || !lookbehind.ok) throw new Error('expected valid lookbehind pattern')
    const lbMatches = searchFileContent('b.ts', 'const foo = 1', lookbehind.pattern)
    expect(lbMatches).toHaveLength(1)
    expect(computeReplacementPreview(lbMatches[0]!, 'new_$&', lookbehind.pattern)).toBe('new_foo')
    expect(
      replaceSingleMatchInContent('const foo = 1', lbMatches[0]!, lookbehind.pattern, 'new_$&'),
    ).toBe('const new_foo = 1')
    expect(replaceAllInContent('const foo = 1', lookbehind.pattern, 'new_$&')).toEqual({
      nextContent: 'const new_foo = 1',
      count: 1,
    })
  })
})
