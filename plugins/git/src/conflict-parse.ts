export type ConflictResolutionChoice = 'ours' | 'theirs' | 'both'

export interface ConflictHunk {
  kind: 'conflict'
  /** Zero-based index among conflict hunks in this document. */
  index: number
  oursLabel: string
  theirsLabel: string
  oursLines: string[]
  baseLines: string[] | null
  theirsLines: string[]
  /** 1-based starting line number in the source text. */
  startLine: number
}

export interface ConflictContextSegment {
  kind: 'context'
  lines: string[]
  /** 1-based starting line number in the source text. */
  startLine: number
}

export type ConflictSegment = ConflictContextSegment | ConflictHunk

export interface ConflictDocument {
  segments: ConflictSegment[]
  conflictCount: number
  eol: '\r\n' | '\n'
}

export function detectEol(content: string): '\r\n' | '\n' {
  const crlf = content.indexOf('\r\n')
  if (crlf === -1) return '\n'
  const lf = content.indexOf('\n')
  return crlf < lf ? '\r\n' : '\n'
}

export function hasConflictMarkers(content: string): boolean {
  return /^<<<<<<<(?:\s|$)/m.test(content) && /^=======\s*$/m.test(content) && /^>>>>>>>(?:\s|$)/m.test(content)
}

/**
 * Parses standard Git 2-way (`<<<<<<<` / `=======` / `>>>>>>>`) and diff3
 * 3-way (`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`) conflict markers.
 * Unclosed conflict blocks are kept as plain context so partial edits never
 * lose user code.
 */
export function parseConflictFile(content: string): ConflictDocument {
  const eol = detectEol(content)
  const rawLines = content.split(/\r?\n/)
  const segments: ConflictSegment[] = []
  let contextLines: string[] = []
  let contextStartLine = 1
  let conflictCount = 0

  const flushContext = () => {
    if (contextLines.length > 0) {
      segments.push({
        kind: 'context',
        lines: contextLines,
        startLine: contextStartLine,
      })
      contextLines = []
    }
  }

  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]
    const startMatch = line.match(/^<<<<<<<(?:\s+(.*))?$/)
    if (!startMatch) {
      if (contextLines.length === 0) contextStartLine = i + 1
      contextLines.push(line)
      i += 1
      continue
    }

    const oursLabel = (startMatch[1] ?? 'HEAD').trim() || 'HEAD'
    const oursLines: string[] = []
    let baseLines: string[] | null = null
    const theirsLines: string[] = []

    let section: 'ours' | 'base' | 'theirs' = 'ours'
    let endIdx = -1
    let theirsLabel = ''

    let j = i + 1
    while (j < rawLines.length) {
      const candidate = rawLines[j]
      if (section === 'ours' && /^\|{7}(?:\s.*)?$/.test(candidate)) {
        section = 'base'
        baseLines = []
        j += 1
        continue
      }
      if ((section === 'ours' || section === 'base') && /^={7}\s*$/.test(candidate)) {
        section = 'theirs'
        j += 1
        continue
      }
      const endMatch = section === 'theirs' ? candidate.match(/^>>>>>>>(?:\s+(.*))?$/) : null
      if (endMatch) {
        theirsLabel = (endMatch[1] ?? '').trim()
        endIdx = j
        break
      }

      if (section === 'ours') {
        oursLines.push(candidate)
      } else if (section === 'base' && baseLines) {
        baseLines.push(candidate)
      } else {
        theirsLines.push(candidate)
      }
      j += 1
    }

    if (endIdx === -1) {
      // Unclosed marker — keep remaining lines as plain context.
      if (contextLines.length === 0) contextStartLine = i + 1
      contextLines.push(line)
      i += 1
      continue
    }

    flushContext()
    segments.push({
      kind: 'conflict',
      index: conflictCount,
      oursLabel,
      theirsLabel,
      oursLines,
      baseLines,
      theirsLines,
      startLine: i + 1,
    })
    conflictCount += 1
    i = endIdx + 1
  }

  flushContext()
  return { segments, conflictCount, eol }
}

export function resolveHunkLines(
  hunk: ConflictHunk,
  choice: ConflictResolutionChoice,
): string[] {
  if (choice === 'ours') return hunk.oursLines
  if (choice === 'theirs') return hunk.theirsLines
  return [...hunk.oursLines, ...hunk.theirsLines]
}

export function serializeResolvedDocument(
  doc: ConflictDocument,
  resolutions: ReadonlyMap<number, ConflictResolutionChoice>,
): string {
  const outLines: string[] = []
  for (const seg of doc.segments) {
    if (seg.kind === 'context') {
      outLines.push(...seg.lines)
      continue
    }
    const choice = resolutions.get(seg.index)
    if (choice) {
      outLines.push(...resolveHunkLines(seg, choice))
    } else {
      outLines.push(seg.oursLabel ? `<<<<<<< ${seg.oursLabel}` : '<<<<<<<')
      outLines.push(...seg.oursLines)
      if (seg.baseLines) {
        outLines.push('|||||||')
        outLines.push(...seg.baseLines)
      }
      outLines.push('=======')
      outLines.push(...seg.theirsLines)
      outLines.push(seg.theirsLabel ? `>>>>>>> ${seg.theirsLabel}` : '>>>>>>>')
    }
  }
  return outLines.join(doc.eol)
}
