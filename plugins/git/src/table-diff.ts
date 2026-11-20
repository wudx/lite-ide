/**
 * Tabular (CSV/TSV) diff modeling for the Git diff preview's table view.
 *
 * The table view reuses the row pairing from `diff-parse.ts` and aligns every
 * record's cells into shared columns, so cell-level changes stand out where a
 * plain line diff only shows two red/green lines. Records are parsed per diff
 * line: CSV records with embedded newlines (quoted multi-line fields) never
 * survive git's line-based diff as whole records, so their fragments render
 * best-effort as ordinary fields instead of blowing up the grid.
 */

import { splitHunkRows, type DiffRow, type DiffRowKind, type ParsedDiff } from './diff-parse'

export function isTabularFile(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  return lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.tab')
}

/**
 * Parses one CSV record line into cells. Quotes are only special at field
 * start; an unterminated quote keeps the remainder as literal field text
 * (best-effort for the multi-line-record fragments described above).
 */
export function parseCsvRecord(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  while (i < line.length) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i += 2
        } else {
          quoted = false
          i += 1
        }
      } else {
        cell += char
        i += 1
      }
    } else if (char === '"' && cell === '') {
      quoted = true
      i += 1
    } else if (char === delimiter) {
      cells.push(cell)
      cell = ''
      i += 1
    } else {
      cell += char
      i += 1
    }
  }
  cells.push(cell)
  return cells
}

const DELIMITER_CANDIDATES = [',', '\t', ';']

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      quoted = !quoted
    } else if (char === delimiter && !quoted) {
      count += 1
    }
  }
  return count
}

/**
 * Picks the delimiter that splits the sampled records most: semicolon- and
 * tab-separated exports render correctly even under a `.csv` extension. Ties
 * keep the earlier candidate (comma first). Returns `fallback` when no
 * candidate appears at all.
 */
export function sniffTabularDelimiter(lines: readonly string[], fallback = ','): string {
  const samples = lines.filter((line) => line.trim() !== '').slice(0, 8)
  if (samples.length === 0) return fallback
  let best = fallback
  let bestCount = 0
  for (const candidate of DELIMITER_CANDIDATES) {
    const total = samples.reduce((sum, line) => sum + countOutsideQuotes(line, candidate), 0)
    if (total > bestCount) {
      best = candidate
      bestCount = total
    }
  }
  return bestCount > 0 ? best : fallback
}

/** One side of a table pair: a diff row parsed into cells. */
export interface TableRecord {
  kind: DiffRowKind
  /** 1-based line number on the old side; absent for additions. */
  oldNo?: number
  /** 1-based line number on the new side; absent for deletions. */
  newNo?: number
  cells: string[]
}

export type TablePairKind = 'header' | 'changed' | 'added' | 'deleted' | 'context'

export interface TablePair {
  /** Old record (deletion or context); null when the new side has more rows. */
  left: TableRecord | null
  /** New record (addition or context); null when the old side has more rows. */
  right: TableRecord | null
  /** True when this pair renders the file's first record (header row). */
  header: boolean
  /** Cell indexes where both sides exist and the values differ. */
  changedCells: number[]
}

export interface TableHunkGroup {
  header: string
  pairs: TablePair[]
}

export interface TableDiffModel {
  delimiter: string
  /** Shared grid width: the widest record across both sides (capped). */
  columnCount: number
  groups: TableHunkGroup[]
}

const MAX_TABLE_COLUMNS = 64

/**
 * `\ No newline at end of file` notice rows carry no record data. Line-number
 * presence is the precise tell (diff-parse assigns numbers to every real row),
 * so genuine records that happen to start with a backslash (`\N` SQL NULL
 * exports, UNC paths) survive.
 */
function isRecordRow(row: DiffRow): boolean {
  return row.oldNo !== undefined || row.newNo !== undefined
}

function toRecord(row: DiffRow | null, delimiter: string): TableRecord | null {
  if (!row) return null
  return { kind: row.kind, oldNo: row.oldNo, newNo: row.newNo, cells: parseCsvRecord(row.text, delimiter) }
}

/**
 * Builds the table-view model from a parsed unified diff: records keep their
 * side-by-side pairing, cells align into a shared grid, and pairs get their
 * kind plus per-cell change indexes for the renderer to highlight.
 * `forceDelimiter` skips sniffing for producers that own their serialization
 * (the spreadsheet path always emits comma-separated records).
 */
export function buildTableDiff(
  parsed: ParsedDiff,
  fallbackDelimiter = ',',
  forceDelimiter?: string,
): TableDiffModel {
  const rowTexts = parsed.hunks.flatMap((hunk) => hunk.rows.filter(isRecordRow).map((row) => row.text))
  const delimiter = forceDelimiter ?? sniffTabularDelimiter(rowTexts, fallbackDelimiter)

  const groups: TableHunkGroup[] = []
  let columnCount = 1

  for (const hunk of parsed.hunks) {
    const pairs: TablePair[] = []
    for (const splitRow of splitHunkRows(hunk.rows.filter(isRecordRow))) {
      const left = toRecord(splitRow.left, delimiter)
      const right = toRecord(splitRow.right, delimiter)
      for (const record of [left, right]) {
        if (record) {
          columnCount = Math.min(MAX_TABLE_COLUMNS, Math.max(columnCount, record.cells.length))
        }
      }
      const changedCells: number[] = []
      if (left && right) {
        const len = Math.min(MAX_TABLE_COLUMNS, Math.max(left.cells.length, right.cells.length))
        for (let i = 0; i < len; i += 1) {
          if ((left.cells[i] ?? '') !== (right.cells[i] ?? '')) {
            changedCells.push(i)
          }
        }
      }
      // Only an intact first record styles as the header row; a modified one
      // keeps its del/add row semantics for the red/green backgrounds.
      const header = changedCells.length === 0 && (left?.oldNo === 1 || right?.newNo === 1)
      pairs.push({ left, right, header, changedCells })
    }
    groups.push({ header: hunk.header, pairs })
  }

  return { delimiter, columnCount, groups }
}
