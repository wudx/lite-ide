/**
 * Unified diff parsing for the Git diff preview.
 *
 * Parses `git diff --no-color -U3` output (plus the synthesized added-file
 * payloads used for untracked paths) into renderable rows with old/new line
 * numbers. Combined merge diffs (`diff --cc`) are detected but not rendered.
 */

export type DiffRowKind = 'add' | 'del' | 'context'

export interface DiffRow {
  kind: DiffRowKind
  /** 1-based line number on the old side; absent for additions. */
  oldNo?: number
  /** 1-based line number on the new side; absent for deletions. */
  newNo?: number
  text: string
}

export interface DiffHunk {
  header: string
  rows: DiffRow[]
}

export interface ParsedDiff {
  /** Old path from the `--- a/...` header (null for added files). */
  oldPath: string | null
  /** New path from the `+++ b/...` header (null for deleted files). */
  newPath: string | null
  /** True when the diff header announces a binary file difference. */
  isBinary: boolean
  /** True when this is a combined merge diff (`diff --cc`), which we do not render. */
  isCombined: boolean
  hunks: DiffHunk[]
}

export interface DiffStats {
  additions: number
  deletions: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses unified diff text. Lenient about blank context lines: git always
 * prefixes them with a space, but hand-built payloads may drop it. Parsing
 * stops at a second `diff --git` section — requests always target one path.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  const result: ParsedDiff = {
    oldPath: null,
    newPath: null,
    isBinary: false,
    isCombined: false,
    hunks: [],
  }

  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  // Diff payloads end with a newline; the split's dangling empty element is a
  // sentinel, not a blank context row. CRLF repos (Windows, core.autocrlf)
  // carry a `\r` before every `\n`; `whitespace-pre` would render it as a
  // line break of its own, so normalize first (lone trailing `\r` included).
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r$/, '').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) break
      continue
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      result.isCombined = true
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      result.isBinary = true
      continue
    }
    if (line.startsWith('--- ')) {
      result.oldPath = parseDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith('+++ ')) {
      result.newPath = parseDiffPath(line.slice(4))
      continue
    }

    const hunkMatch = HUNK_HEADER.exec(line)
    if (hunkMatch) {
      current = { header: line, rows: [] }
      result.hunks.push(current)
      oldNo = Number(hunkMatch[1])
      newNo = Number(hunkMatch[3])
      continue
    }

    if (!current) continue

    const marker = line.charAt(0)
    if (marker === '+') {
      current.rows.push({ kind: 'add', newNo, text: line.slice(1) })
      newNo += 1
    } else if (marker === '-') {
      current.rows.push({ kind: 'del', oldNo, text: line.slice(1) })
      oldNo += 1
    } else if (marker === '\\') {
      // "\ No newline at end of file" renders as a muted notice row.
      current.rows.push({ kind: 'context', text: line })
    } else {
      // Context line (' ' prefix); blank lines inside a hunk are blank
      // context rows whose payloads may omit the space prefix.
      current.rows.push({ kind: 'context', oldNo, newNo, text: line.slice(1) })
      oldNo += 1
      newNo += 1
    }
  }

  return result
}

function parseDiffPath(raw: string): string | null {
  const path = raw.trim()
  if (!path || path === '/dev/null') return null
  return path.replace(/^(a|b)\//, '')
}

/** Added/deleted line counts across all hunks; drives the stats pill. */
export function diffStats(parsed: ParsedDiff): DiffStats {
  let additions = 0
  let deletions = 0
  for (const hunk of parsed.hunks) {
    for (const row of hunk.rows) {
      if (row.kind === 'add') additions += 1
      else if (row.kind === 'del') deletions += 1
    }
  }
  return { additions, deletions }
}

/**
 * Builds the added-file unified diff shown for untracked paths, which plain
 * `git diff` never reports. The payload goes through the same parser as real
 * diffs so the renderer stays single-pathed.
 */
export function synthesizeAddedDiff(relPath: string, content: string): string {
  const lines = content.split('\n')
  // A trailing newline yields a dangling empty last element; drop it so the
  // line count matches the file's real lines.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  const body = lines.map((line) => `+${line}`).join('\n')
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ].join('\n')
  if (!body) return `${header}\n`
  return `${header}\n${body}\n`
}
