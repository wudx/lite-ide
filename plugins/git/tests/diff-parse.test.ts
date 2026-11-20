import { describe, expect, it } from 'vitest'
import {
  diffStats,
  parseUnifiedDiff,
  splitHunkRows,
  synthesizeAddedDiff,
} from '../src/diff-parse'

describe('parseUnifiedDiff', () => {
  it('parses hunks with line numbers and row kinds', () => {
    const raw = [
      'diff --git a/a.txt b/a.txt',
      'index 3d2f4a1..b8c9e02 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,4 +1,4 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '+four',
    ].join('\n')

    const parsed = parseUnifiedDiff(raw)
    expect(parsed.oldPath).toBe('a.txt')
    expect(parsed.newPath).toBe('a.txt')
    expect(parsed.isBinary).toBe(false)
    expect(parsed.hunks).toHaveLength(1)

    const rows = parsed.hunks[0].rows
    expect(rows).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, text: 'one' },
      { kind: 'del', oldNo: 2, text: 'two' },
      { kind: 'add', newNo: 2, text: 'TWO' },
      { kind: 'context', oldNo: 3, newNo: 3, text: 'three' },
      { kind: 'add', newNo: 4, text: 'four' },
    ])
  })

  it('advances line numbers across multiple hunks', () => {
    const raw = [
      '--- a/big.txt',
      '+++ b/big.txt',
      '@@ -2,3 +2,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -20,3 +20,4 @@',
      ' x',
      '+y',
      ' z',
    ].join('\n')

    const parsed = parseUnifiedDiff(raw)
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[1].rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['context', 20, 20],
      ['add', undefined, 21],
      ['context', 21, 22],
    ])
  })

  it('tracks added and deleted files through /dev/null headers', () => {
    const added = parseUnifiedDiff(
      ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+hello', '+world'].join('\n'),
    )
    expect(added.oldPath).toBeNull()
    expect(added.newPath).toBe('new.txt')

    const deleted = parseUnifiedDiff(
      ['--- a/gone.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye'].join('\n'),
    )
    expect(deleted.oldPath).toBe('gone.txt')
    expect(deleted.newPath).toBeNull()
  })

  it('flags binary and combined merge diffs', () => {
    const binary = parseUnifiedDiff('Binary files a/img.png and b/img.png differ\n')
    expect(binary.isBinary).toBe(true)
    expect(binary.hunks).toHaveLength(0)

    const combined = parseUnifiedDiff('diff --cc a/conflict.txt\n')
    expect(combined.isCombined).toBe(true)
  })

  it('renders the no-newline notice and blank context rows', () => {
    const raw = ['--- a/tail.txt', '+++ b/tail.txt', '@@ -1,2 +1,2 @@', '-end', '+end', '\\ No newline at end of file'].join(
      '\n',
    )
    const parsed = parseUnifiedDiff(raw)
    expect(parsed.hunks[0].rows).toEqual([
      { kind: 'del', oldNo: 1, text: 'end' },
      { kind: 'add', newNo: 1, text: 'end' },
      { kind: 'context', text: '\\ No newline at end of file' },
    ])
  })

  it('normalizes CRLF line endings from Windows repos', () => {
    const raw = [
      '--- a/win.txt',
      '+++ b/win.txt',
      '@@ -1,2 +1,2 @@',
      ' ctx\r',
      '-old\r',
      '+new\r',
    ].join('\n')

    const parsed = parseUnifiedDiff(raw)
    expect(parsed.hunks[0].rows.map((r) => [r.kind, r.text])).toEqual([
      ['context', 'ctx'],
      ['del', 'old'],
      ['add', 'new'],
    ])
  })

  it('stops at a second file section', () => {
    const raw = [
      'diff --git a/one.txt b/one.txt',
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      'diff --git a/two.txt b/two.txt',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-c',
      '+d',
    ].join('\n')

    const parsed = parseUnifiedDiff(raw)
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0].rows.map((r) => r.text)).toEqual(['a', 'b'])
  })
})

describe('diffStats', () => {
  it('counts additions and deletions', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@', ' keep', '-old1', '-old2', '+new1', '+new2', '+new3'].join(
        '\n',
      ),
    )
    expect(diffStats(parsed)).toEqual({ additions: 3, deletions: 2 })
  })
})

describe('synthesizeAddedDiff', () => {
  it('marks every line as an addition', () => {
    const raw = synthesizeAddedDiff('notes/draft.md', 'hello\nworld\n')
    const parsed = parseUnifiedDiff(raw)
    expect(parsed.oldPath).toBeNull()
    expect(parsed.newPath).toBe('notes/draft.md')
    expect(diffStats(parsed)).toEqual({ additions: 2, deletions: 0 })
    expect(parsed.hunks[0].header).toBe('@@ -0,0 +1,2 @@')
    expect(parsed.hunks[0].rows.map((r) => r.text)).toEqual(['hello', 'world'])
  })

  it('handles empty and non-newline-terminated content', () => {
    const empty = parseUnifiedDiff(synthesizeAddedDiff('empty.txt', ''))
    expect(diffStats(empty)).toEqual({ additions: 0, deletions: 0 })

    const noTrailing = parseUnifiedDiff(synthesizeAddedDiff('a.txt', 'one\ntwo'))
    expect(diffStats(noTrailing)).toEqual({ additions: 2, deletions: 0 })
    expect(noTrailing.hunks[0].rows.at(-1)?.text).toBe('two')
  })
})

describe('splitHunkRows', () => {
  function rowsOf(raw: string) {
    return parseUnifiedDiff(raw).hunks[0].rows
  }

  it('zips equal del/add runs and puts context on both sides', () => {
    const rows = rowsOf(
      ['--- a/x', '+++ b/x', '@@ -1,4 +1,4 @@', ' keep', '-old', '+new', ' tail'].join('\n'),
    )
    expect(splitHunkRows(rows)).toEqual([
      { left: rows[0], right: rows[0] },
      { left: rows[1], right: rows[2] },
      { left: rows[3], right: rows[3] },
    ])
  })

  it('null-fills the shorter side when runs are unbalanced', () => {
    const rows = rowsOf(
      ['--- a/x', '+++ b/x', '@@ -1,4 +1,3 @@', '-a', '-b', '-c', '+only', ' ctx'].join('\n'),
    )
    const paired = splitHunkRows(rows)
    expect(paired).toHaveLength(4)
    expect(paired[0]).toEqual({ left: rows[0], right: rows[3] })
    expect(paired[1]).toEqual({ left: rows[1], right: null })
    expect(paired[2]).toEqual({ left: rows[2], right: null })
    expect(paired[3].left).toBe(rows[4])
    expect(paired[3].right).toBe(rows[4])
  })

  it('handles additions without deletions and multiple runs', () => {
    const rows = rowsOf(
      ['--- a/x', '+++ b/x', '@@ -1,3 +1,5 @@', ' a', '+n1', '+n2', '+n3', ' b', '-z', '+y'].join(
        '\n',
      ),
    )
    const paired = splitHunkRows(rows)
    expect(paired.map((p) => [p.left?.kind ?? null, p.right?.kind ?? null])).toEqual([
      ['context', 'context'],
      [null, 'add'],
      [null, 'add'],
      [null, 'add'],
      ['context', 'context'],
      ['del', 'add'],
    ])
  })

  it('pairs every hunk of a full parsed diff', () => {
    const parsed = parseUnifiedDiff(
      ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '-a', '+b', '@@ -10,1 +10,1 @@', ' c'].join('\n'),
    )
    const allPaired = parsed.hunks.flatMap((hunk) => splitHunkRows(hunk.rows))
    expect(allPaired).toHaveLength(2)
    expect(allPaired[0]).toEqual({ left: parsed.hunks[0].rows[0], right: parsed.hunks[0].rows[1] })
  })
})
