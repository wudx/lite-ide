import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, synthesizeAddedDiff } from '../src/diff-parse'
import {
  buildTableDiff,
  isTabularFile,
  parseCsvRecord,
  sniffTabularDelimiter,
} from '../src/table-diff'

describe('isTabularFile', () => {
  it('matches case-insensitive csv/tsv/tab extensions', () => {
    expect(isTabularFile('data/metrics.csv')).toBe(true)
    expect(isTabularFile('EXPORT.CSV')).toBe(true)
    expect(isTabularFile('log.tsv')).toBe(true)
    expect(isTabularFile('list.tab')).toBe(true)
    expect(isTabularFile('src/App.tsx')).toBe(false)
    expect(isTabularFile('readme.md')).toBe(false)
    expect(isTabularFile('data.csvx')).toBe(false)
  })
})

describe('parseCsvRecord', () => {
  it('splits plain records', () => {
    expect(parseCsvRecord('a,b,c', ',')).toEqual(['a', 'b', 'c'])
    expect(parseCsvRecord('a,,c', ',')).toEqual(['a', '', 'c'])
    expect(parseCsvRecord('single', ',')).toEqual(['single'])
    expect(parseCsvRecord('a,b,', ',')).toEqual(['a', 'b', ''])
  })

  it('keeps delimiters and escaped quotes inside quoted fields', () => {
    expect(parseCsvRecord('"x,1",plain,"say ""hi"""', ',')).toEqual(['x,1', 'plain', 'say "hi"'])
    expect(parseCsvRecord('leading,"quoted,newline",tail', ',')).toEqual([
      'leading',
      'quoted,newline',
      'tail',
    ])
  })

  it('splits on the requested delimiter (tab/semicolon)', () => {
    expect(parseCsvRecord('a\tb\tc', '\t')).toEqual(['a', 'b', 'c'])
    expect(parseCsvRecord('a;b', ';')).toEqual(['a', 'b'])
    expect(parseCsvRecord('"semi;colon";x', ';')).toEqual(['semi;colon', 'x'])
  })

  it('treats an unterminated quote as literal field text', () => {
    // Multi-line quoted records arrive fragmented through the line-based
    // diff; the fragment renders best-effort instead of throwing.
    expect(parseCsvRecord('a,"unterminated', ',')).toEqual(['a', 'unterminated'])
  })
})

describe('sniffTabularDelimiter', () => {
  it('prefers the delimiter that splits the most fields', () => {
    expect(sniffTabularDelimiter(['a,b,c', 'x,y,z'])).toBe(',')
    expect(sniffTabularDelimiter(['a;b;c', 'x;y'])).toBe(';')
    expect(sniffTabularDelimiter(['a\tb', 'x\ty\tz'])).toBe('\t')
    expect(sniffTabularDelimiter(['a,b', 'p;q'])).toBe(',')
  })

  it('ignores delimiters inside quotes', () => {
    expect(sniffTabularDelimiter(['"a,b";2', '"c,d";3'])).toBe(';')
  })

  it('falls back to comma for unrecognizable input', () => {
    expect(sniffTabularDelimiter(['plain line'])).toBe(',')
    expect(sniffTabularDelimiter([])).toBe(',')
    expect(sniffTabularDelimiter([], '\t')).toBe('\t')
  })
})

function parseTable(raw: string) {
  return buildTableDiff(parseUnifiedDiff(raw))
}

describe('buildTableDiff', () => {
  it('pairs records and flags cell-level changes', () => {
    const model = parseTable(
      [
        'diff --git a/data/metrics.csv b/data/metrics.csv',
        '--- a/data/metrics.csv',
        '+++ b/data/metrics.csv',
        '@@ -1,5 +1,6 @@',
        ' metric,week1,week2,week3',
        '-uptime,99.95,99.97,99.99',
        '+uptime,99.95,99.97,99.98',
        ' error_rate,0.4,0.3,0.2',
        ' coverage,71,74,79',
        '+throughput,1200,1350,1480',
        ' build_time,42,39,31',
      ].join('\n'),
    )

    expect(model.delimiter).toBe(',')
    expect(model.columnCount).toBe(4)

    const pairs = model.groups.flatMap((group) => group.pairs)
    expect(pairs).toHaveLength(6)

    // Header row: line 1 on both sides, flagged for header styling.
    expect(pairs[0].header).toBe(true)
    expect(pairs[0].left?.cells).toEqual(['metric', 'week1', 'week2', 'week3'])
    expect(pairs[0].changedCells).toEqual([])

    // The uptime pair differs only in the week3 cell.
    expect(pairs[1].changedCells).toEqual([3])
    expect(pairs[1].left?.cells[3]).toBe('99.99')
    expect(pairs[1].right?.cells[3]).toBe('99.98')

    expect(pairs[2].header).toBe(false)
    expect(pairs[2].changedCells).toEqual([])

    // The added throughput row has no left counterpart.
    expect(pairs[4].left).toBeNull()
    expect(pairs[4].right?.cells).toEqual(['throughput', '1200', '1350', '1480'])
    expect(pairs[5].changedCells).toEqual([])
  })

  it('sniffs semicolon and tab delimiters from the diff rows', () => {
    const semi = parseTable(
      ['--- a/x.csv', '+++ b/x.csv', '@@ -1,2 +1,2 @@', ' a;b;c', '-d;e', '+d;e;f'].join('\n'),
    )
    expect(semi.delimiter).toBe(';')
    expect(semi.columnCount).toBe(3)

    const tsv = parseTable(
      ['--- a/x.tsv', '+++ b/x.tsv', '@@ -1,2 +1,2 @@', ' a\tb', '-c\td', '+c\td\te'].join('\n'),
    )
    expect(tsv.delimiter).toBe('\t')
    expect(tsv.columnCount).toBe(3)
  })

  it('caps the column count for pathological wide records', () => {
    const oldWide = Array.from({ length: 100 }, (_, i) => `v${i}`).join(',')
    const newWide = Array.from({ length: 100 }, (_, i) => (i === 10 ? 'CHANGED' : `v${i}`)).join(
      ',',
    )
    const model = parseTable(
      ['--- a/wide.csv', '+++ b/wide.csv', '@@ -1 +1 @@', `-${oldWide}`, `+${newWide}`].join('\n'),
    )
    expect(model.columnCount).toBe(64)
    const pair = model.groups.flatMap((g) => g.pairs)[0]
    // Only the in-grid change (index 10) is flagged; fields beyond the cap
    // still parse but stay outside the rendered grid.
    expect(pair.changedCells).toEqual([10])
  })

  it('renders the synthesized added-file diff of an untracked csv', () => {
    const synthesized = synthesizeAddedDiff('data/new.csv', 'a,b\n1,2\n')
    const model = buildTableDiff(parseUnifiedDiff(synthesized))
    const pairs = model.groups.flatMap((group) => group.pairs)
    expect(pairs).toHaveLength(2)
    expect(pairs[0].header).toBe(true)
    expect(pairs[0].right?.cells).toEqual(['a', 'b'])
    expect(pairs[1].right?.cells).toEqual(['1', '2'])
    expect(model.groups[0].pairs.every((p) => p.left === null)).toBe(true)
  })

  it('keeps hunk grouping for multi-hunk diffs', () => {
    const model = parseTable(
      [
        '--- a/big.csv',
        '+++ b/big.csv',
        '@@ -2,3 +2,3 @@',
        ' a,b',
        '-c,d',
        '+C,D',
        ' e,f',
        '@@ -20,2 +20,2 @@',
        ' x,y',
        '-z,w',
        '+Z,W',
      ].join('\n'),
    )
    expect(model.groups).toHaveLength(2)
    expect(model.groups[0].header).toContain('@@ -2,3 +2,3 @@')
    expect(model.groups[0].pairs[1].changedCells).toEqual([0, 1])
    expect(model.groups[1].pairs[1].changedCells).toEqual([0, 1])
  })

  it('keeps records starting with a backslash and drops only the no-newline notice', () => {
    const model = parseTable(
      [
        '--- a/unc.csv',
        '+++ b/unc.csv',
        '@@ -1,2 +1,2 @@',
        '-\\N,5',
        '+\\N,6',
        '\\ No newline at end of file',
      ].join('\n'),
    )
    // Only the del/add pair survives; the `\ No newline` notice (no line
    // numbers) is filtered out instead of rendering as a fake record.
    const pairs = model.groups.flatMap((group) => group.pairs)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].left?.cells).toEqual(['\\N', '5'])
    expect(pairs[0].right?.cells).toEqual(['\\N', '6'])
    expect(pairs[0].changedCells).toEqual([1])
  })

  it('styles a modified first record as a changed pair, not a header', () => {
    const model = parseTable(
      ['--- a/x.csv', '+++ b/x.csv', '@@ -1,2 +1,2 @@', '-h1,h2', '+H1,h2', ' a,b'].join('\n'),
    )
    const pairs = model.groups.flatMap((group) => group.pairs)
    expect(pairs[0].header).toBe(false)
    expect(pairs[0].changedCells).toEqual([0])
    // The intact context row after it carries no header flag either.
    expect(pairs[1].header).toBe(false)
    expect(pairs[1].changedCells).toEqual([])
  })
})
