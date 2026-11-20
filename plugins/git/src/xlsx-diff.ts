/**
 * Spreadsheet (xlsx/xlsm/xls) diffing for the Git diff preview.
 *
 * git only reports "binary files differ" for workbooks, so the preview reads
 * both versions through `GitBackend.readBlob` (HEAD / index / worktree), parses
 * the first sheet with SheetJS, aligns rows, and synthesizes a plain unified
 * diff. Everything downstream — the unified/split/table renderers, the stats
 * pill, the CSV cell parsing in `table-diff.ts` — then works unchanged, which
 * is why rows are serialized as RFC 4180 CSV records.
 */

/** SheetJS has no ESM entry; the dynamic import keeps it in a lazy chunk. */
type XLSXModule = typeof import('xlsx')

/** Upper bound on parsed rows so giant sheets cannot stall the preview. */
const MAX_SHEET_ROWS = 5000

/** Alignment is quadratic in memory; row counts beyond this fall back to positional pairing. */
const MAX_ALIGN_ROWS = 2000

/** Context lines kept around each changed run, mirroring `git diff -U3`. */
const CONTEXT_LINES = 3

export function isSpreadsheetFile(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  return lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')
}

/**
 * Parses the first worksheet into rows of display-formatted values
 * (`raw: false` yields the rendered text — dates as "yyyy-mm-dd", numbers
 * without floating point noise). Trailing fully-empty rows are dropped, as
 * are rows beyond `MAX_SHEET_ROWS`.
 */
export async function decodeSheetRows(blobBase64: string): Promise<string[][]> {
  const XLSX: XLSXModule = await import('xlsx')
  const workbook = XLSX.read(blobBase64, { type: 'base64' })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
  })
  const trimmed = rows.slice(0, MAX_SHEET_ROWS).map((row) => row.map((cell) => String(cell ?? '')))
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].every((cell) => cell === '')) {
    trimmed.pop()
  }
  return trimmed
}

/** Serializes one cell into an RFC 4180 CSV field; embedded line breaks render as ⏎. */
function csvField(value: string): string {
  const flat = value.replace(/\r\n|\r|\n/g, '⏎')
  if (/[",]/.test(flat)) {
    return `"${flat.replace(/"/g, '""')}"`
  }
  return flat
}

function serializeRow(row: readonly string[]): string {
  return row.map(csvField).join(',')
}

type RowOp = { kind: 'equal' | 'delete' | 'insert'; oldIndex?: number; newIndex?: number }

/**
 * LCS row alignment. Common prefixes/suffixes are peeled off first, which
 * keeps the quadratic DP confined to the actually-changed middle of typical
 * sheets; huge untouched middles fall back to positional pairing instead of
 * blowing up memory.
 */
function alignRows(oldRows: readonly string[][], newRows: readonly string[][]): RowOp[] {
  const ops: RowOp[] = []
  const sameRow = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((cell, i) => cell === b[i])

  let prefix = 0
  while (
    prefix < oldRows.length &&
    prefix < newRows.length &&
    sameRow(oldRows[prefix], newRows[prefix])
  ) {
    ops.push({ kind: 'equal', oldIndex: prefix, newIndex: prefix })
    prefix += 1
  }
  let oldEnd = oldRows.length
  let newEnd = newRows.length
  while (
    oldEnd > prefix &&
    newEnd > prefix &&
    sameRow(oldRows[oldEnd - 1], newRows[newEnd - 1])
  ) {
    oldEnd -= 1
    newEnd -= 1
  }

  const oldMiddle = oldRows.slice(prefix, oldEnd)
  const newMiddle = newRows.slice(prefix, newEnd)
  const middleOps: RowOp[] = []
  if (
    oldMiddle.length > MAX_ALIGN_ROWS ||
    newMiddle.length > MAX_ALIGN_ROWS
  ) {
    // Positional fallback: zip by row index and compare — differences still
    // surface as delete/insert pairs, just without cross-row alignment.
    const span = Math.max(oldMiddle.length, newMiddle.length)
    for (let i = 0; i < span; i += 1) {
      const oldIndex = prefix + i
      if (i < oldMiddle.length && i < newMiddle.length) {
        if (sameRow(oldMiddle[i], newMiddle[i])) {
          middleOps.push({ kind: 'equal', oldIndex, newIndex: oldIndex })
        } else {
          middleOps.push({ kind: 'delete', oldIndex })
          middleOps.push({ kind: 'insert', newIndex: oldIndex })
        }
      } else if (i < oldMiddle.length) {
        middleOps.push({ kind: 'delete', oldIndex })
      } else {
        middleOps.push({ kind: 'insert', newIndex: oldIndex })
      }
    }
  } else {
    // Classic LCS DP over row identity.
    const m = oldMiddle.length
    const n = newMiddle.length
    const table = new Uint32Array((m + 1) * (n + 1))
    const at = (i: number, j: number) => i * (n + 1) + j
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        table[at(i, j)] = sameRow(oldMiddle[i], newMiddle[j])
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (sameRow(oldMiddle[i], newMiddle[j])) {
        middleOps.push({ kind: 'equal', oldIndex: prefix + i, newIndex: prefix + j })
        i += 1
        j += 1
      } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
        middleOps.push({ kind: 'delete', oldIndex: prefix + i })
        i += 1
      } else {
        middleOps.push({ kind: 'insert', newIndex: prefix + j })
        j += 1
      }
    }
    while (i < m) {
      middleOps.push({ kind: 'delete', oldIndex: prefix + i })
      i += 1
    }
    while (j < n) {
      middleOps.push({ kind: 'insert', newIndex: prefix + j })
      j += 1
    }
  }
  ops.push(...middleOps)

  let suffixOld = oldEnd
  let suffixNew = newEnd
  while (suffixOld < oldRows.length && suffixNew < newRows.length) {
    ops.push({ kind: 'equal', oldIndex: suffixOld, newIndex: suffixNew })
    suffixOld += 1
    suffixNew += 1
  }
  while (suffixOld < oldRows.length) {
    ops.push({ kind: 'delete', oldIndex: suffixOld })
    suffixOld += 1
  }
  while (suffixNew < newRows.length) {
    ops.push({ kind: 'insert', newIndex: suffixNew })
    suffixNew += 1
  }
  return ops
}

interface DiffHunkSpec {
  /** Hunk header followed by the body lines (`ctx`/`-old`/`+new`). */
  lines: string[]
}

/**
 * Groups the aligned ops into `-U3`-style hunks: runs of unchanged rows more
 * than `2 * CONTEXT_LINES` apart split into separate hunks, and every hunk
 * keeps its true 1-based line numbers so the existing parser numbers rows
 * exactly like a real git diff.
 */
function buildHunks(oldRows: readonly string[][], newRows: readonly string[][]): DiffHunkSpec[] {
  const oldText = oldRows.map(serializeRow)
  const newText = newRows.map(serializeRow)
  const ops = alignRows(oldRows, newRows)
  const changed = ops.map((op) => op.kind !== 'equal')

  const hunks: DiffHunkSpec[] = []
  let i = 0
  while (i < ops.length) {
    if (!changed[i]) {
      i += 1
      continue
    }
    // Expand the change run: unchanged gaps of at most 2×context lines merge
    // (splitting them would drop context below the -U3 budget).
    let end = i
    while (end + 1 < ops.length) {
      if (changed[end + 1]) {
        end += 1
        continue
      }
      let run = 0
      let cursor = end + 1
      while (cursor < ops.length && !changed[cursor]) {
        run += 1
        cursor += 1
      }
      if (run <= CONTEXT_LINES * 2 && cursor < ops.length) {
        end = cursor
      } else {
        break
      }
    }
    let from = Math.max(0, i - CONTEXT_LINES)
    let to = Math.min(ops.length - 1, end + CONTEXT_LINES)

    const lines: string[] = []
    // Start numbers follow git semantics: the first op that consumes a row of
    // that side anchors the number (a hunk starting with an insertion still
    // numbers from the old row it precedes). Zero only for a side that has no
    // rows at all in this hunk (pure addition/deletion files).
    let oldNo = 0
    let newNo = 0
    let oldCount = 0
    let newCount = 0
    for (let k = from; k <= to; k += 1) {
      const op = ops[k]
      if (op.kind === 'equal') {
        if (oldCount === 0) oldNo = (op.oldIndex ?? 0) + 1
        if (newCount === 0) newNo = (op.newIndex ?? 0) + 1
        lines.push(' ' + oldText[op.oldIndex!])
        oldCount += 1
        newCount += 1
      } else if (op.kind === 'delete') {
        if (oldCount === 0) oldNo = (op.oldIndex ?? 0) + 1
        lines.push('-' + oldText[op.oldIndex!])
        oldCount += 1
      } else {
        if (newCount === 0) newNo = (op.newIndex ?? 0) + 1
        lines.push('+' + newText[op.newIndex!])
        newCount += 1
      }
    }
    lines.unshift(`@@ -${oldNo},${oldCount} +${newNo},${newCount} @@`)
    hunks.push({ lines })
    i = to + 1
  }
  return hunks
}

/**
 * Builds the whole-file body for untracked (all additions) or deleted (all
 * deletions) workbooks, matching git's `@@ -0,0 +1,N @@` shape.
 */
function singleSidedDiff(rows: readonly string[][], marker: '+' | '-'): string[] {
  const count = rows.length
  if (count === 0) return []
  const header =
    marker === '+' ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`
  return [header, ...rows.map(serializeRow).map((line) => marker + line)]
}

/**
 * Synthesizes a unified diff for one spreadsheet comparison. Null sides mean
 * "file absent there": a null old side renders everything as additions
 * (untracked file), a null new side as deletions (deleted file). Returns ''
 * when both sides hold identical content.
 */
export function synthesizeTableDiff(
  oldRows: readonly string[][] | null,
  newRows: readonly string[][] | null,
  relPath: string,
): string {
  if (oldRows === null || newRows === null) {
    const rows = oldRows === null ? newRows : oldRows
    if (!rows || rows.length === 0) return ''
    const marker = oldRows === null ? '+' : '-'
    const header = [
      `diff --git a/${relPath} b/${relPath}`,
      'index 0000000..ffffffff 100644',
      `--- ${oldRows === null ? '/dev/null' : `a/${relPath}`}`,
      `+++ ${newRows === null ? '/dev/null' : `b/${relPath}`}`,
    ]
    return [...header, ...singleSidedDiff(rows, marker)].join('\n') + '\n'
  }
  if (oldRows.length === 0 && newRows.length === 0) return ''

  const hunks = buildHunks(oldRows, newRows)
  if (hunks.length === 0) return ''
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    'index 0000000..ffffffff 100644',
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
  ]
  return [...header, ...hunks.flatMap((hunk) => hunk.lines)].join('\n') + '\n'
}
