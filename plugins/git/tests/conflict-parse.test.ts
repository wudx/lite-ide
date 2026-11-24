import { describe, expect, it } from 'vitest'
import {
  hasConflictMarkers,
  parseConflictFile,
  serializeResolvedDocument,
} from '../src/conflict-parse'

describe('conflict-parse', () => {
  it('parses 2-way conflict markers and resolves individual hunks', () => {
    const source = [
      'line 1',
      '<<<<<<< HEAD',
      'const mode = "current"',
      '=======',
      'const mode = "incoming"',
      '>>>>>>> feat/new-mode',
      'line 2',
      '',
    ].join('\n')

    expect(hasConflictMarkers(source)).toBe(true)
    const doc = parseConflictFile(source)
    expect(doc.eol).toBe('\n')
    expect(doc.conflictCount).toBe(1)
    expect(doc.segments).toHaveLength(3)

    const hunk = doc.segments[1]
    expect(hunk.kind).toBe('conflict')
    if (hunk.kind === 'conflict') {
      expect(hunk.oursLabel).toBe('HEAD')
      expect(hunk.theirsLabel).toBe('feat/new-mode')
      expect(hunk.oursLines).toEqual(['const mode = "current"'])
      expect(hunk.theirsLines).toEqual(['const mode = "incoming"'])
    }

    const oursResolved = serializeResolvedDocument(doc, new Map([[0, 'ours']]))
    expect(oursResolved).toBe('line 1\nconst mode = "current"\nline 2\n')
    expect(hasConflictMarkers(oursResolved)).toBe(false)

    const theirsResolved = serializeResolvedDocument(doc, new Map([[0, 'theirs']]))
    expect(theirsResolved).toBe('line 1\nconst mode = "incoming"\nline 2\n')

    const bothResolved = serializeResolvedDocument(doc, new Map([[0, 'both']]))
    expect(bothResolved).toBe('line 1\nconst mode = "current"\nconst mode = "incoming"\nline 2\n')
  })

  it('supports diff3 base markers and preserves CRLF line endings', () => {
    const source = [
      'a',
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base',
      '=======',
      'theirs',
      '>>>>>>> branch',
      'b',
    ].join('\r\n')

    const doc = parseConflictFile(source)
    expect(doc.eol).toBe('\r\n')
    expect(doc.conflictCount).toBe(1)
    const hunk = doc.segments[1]
    if (hunk.kind === 'conflict') {
      expect(hunk.baseLines).toEqual(['base'])
    }
    const resolved = serializeResolvedDocument(doc, new Map([[0, 'theirs']]))
    expect(resolved).toBe('a\r\ntheirs\r\nb')
  })

  it('keeps partial/unclosed conflict markers as plain context', () => {
    const source = '<<<<<<< HEAD\nno separator here\n'
    expect(hasConflictMarkers(source)).toBe(false)
    const doc = parseConflictFile(source)
    expect(doc.conflictCount).toBe(0)
    expect(doc.segments).toHaveLength(1)
    expect(doc.segments[0].kind).toBe('context')
  })
})
