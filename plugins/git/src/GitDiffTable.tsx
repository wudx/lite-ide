import { For, createMemo, type Component } from 'solid-js'
import type { TableDiffModel, TablePair, TablePairKind } from './table-diff'

/**
 * Cell backgrounds per pair kind and side. Changed pairs keep the split
 * view's red-left/green-right convention; the empty side of an added/deleted
 * pair gets the neutral inset so the gap reads as "no counterpart".
 */
const CELL_BG: Record<TablePairKind, { left: string; right: string }> = {
  header: { left: 'bg-[var(--bg-inset)]', right: 'bg-[var(--bg-inset)]' },
  changed: { left: 'bg-[var(--diff-del-bg)]', right: 'bg-[var(--diff-add-bg)]' },
  added: { left: 'bg-[var(--bg-subtle)]', right: 'bg-[var(--diff-add-bg)]' },
  deleted: { left: 'bg-[var(--diff-del-bg)]', right: 'bg-[var(--bg-subtle)]' },
  context: { left: '', right: '' },
}

/** Row-number tone per pair kind and side; mirrors the +/- marker colors. */
const NUMBER_TONE: Record<TablePairKind, { left: string; right: string }> = {
  header: { left: 'text-[var(--text-muted)]/60', right: 'text-[var(--text-muted)]/60' },
  changed: { left: 'text-[var(--diff-del-text)]/70', right: 'text-[var(--diff-add-text)]/70' },
  added: { left: 'text-[var(--text-muted)]/60', right: 'text-[var(--diff-add-text)]/70' },
  deleted: { left: 'text-[var(--diff-del-text)]/70', right: 'text-[var(--text-muted)]/60' },
  context: { left: 'text-[var(--text-muted)]/60', right: 'text-[var(--text-muted)]/60' },
}

function pairKind(pair: TablePair): TablePairKind {
  if (pair.header) return 'header'
  if (pair.left && pair.right) return pair.changedCells.length > 0 ? 'changed' : 'context'
  if (pair.left) return 'deleted'
  return 'added'
}

const PairRow: Component<{ pair: TablePair; columns: number }> = (props) => {
  const kind = () => pairKind(props.pair)
  // Changed cells get a stronger wash of the row's marker color so the edited
  // field stands out inside an otherwise red/green record pair. color-mix
  // derives from the theme's diff text vars, so all three themes adapt.
  const cellStyle = (side: 'left' | 'right', index: number): string | undefined => {
    if (!props.pair.changedCells.includes(index)) return undefined
    const tone = side === 'left' ? 'var(--diff-del-text)' : 'var(--diff-add-text)'
    return `background: color-mix(in srgb, ${tone} 26%, transparent)`
  }

  const cells = (side: 'left' | 'right') =>
    Array.from({ length: props.columns }, (_, i) => {
      const record = side === 'left' ? props.pair.left : props.pair.right
      const value = record?.cells[i] ?? ''
      return (
        <td
          data-git-diff-cell={side}
          data-cell-index={i}
          data-git-diff-cell-changed={props.pair.changedCells.includes(i) ? 'true' : undefined}
          style={cellStyle(side, i)}
          class={`min-w-0 px-1.5 align-top whitespace-pre-wrap break-all text-[var(--text-primary)] ${CELL_BG[kind()][side]}`}
        >
          {value}
        </td>
      )
    })

  return (
    <tr data-git-diff-table-pair={kind()}>
      <td
        class={`w-9 px-1 pr-1.5 text-right tabular-nums select-none align-top ${NUMBER_TONE[kind()].left}`}
      >
        {props.pair.left?.oldNo ?? ''}
      </td>
      {cells('left')}
      <td
        class={`w-9 border-l border-[var(--border-subtle)] px-1 pr-1.5 text-right tabular-nums select-none align-top ${NUMBER_TONE[kind()].right}`}
      >
        {props.pair.right?.newNo ?? ''}
      </td>
      {cells('right')}
    </tr>
  )
}

/**
 * Table view for tabular (CSV/TSV) diffs behind the "table" diff view mode:
 * old records on the left, new records on the right, cells aligned into a
 * shared fixed-width grid so per-field changes line up vertically.
 */
export const GitDiffTable: Component<{ model: TableDiffModel }> = (props) => {
  // Memoized once: `props.model` is a getter whose expression rebuilds the
  // whole table model, so reading it per row would re-run that work O(rows).
  const model = createMemo(() => props.model)
  // Grid width: two row-number gutters + two record halves of N columns.
  const totalColumns = () => 2 + 2 * model().columnCount

  return (
    <div
      data-testid="git-diff-table-scroll"
      class="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-[18px] select-none"
    >
      {/* border-separate (not collapse) keeps the sticky hunk header working
          in Chromium-based webviews; colgroup stays the table's first child. */}
      <table data-testid="git-diff-table" class="w-full table-fixed border-separate border-spacing-0">
        <colgroup>
          <col class="w-9" />
          <For each={Array.from({ length: model().columnCount })}>
            {() => <col />}
          </For>
          <col class="w-9" />
          <For each={Array.from({ length: model().columnCount })}>
            {() => <col />}
          </For>
        </colgroup>
        <For each={model().groups}>
          {(group) => (
            <tbody>
              <tr>
                <td
                  data-git-diff-table-hunk=""
                  colSpan={totalColumns()}
                  class="sticky top-0 z-10 truncate px-2 py-0.5 bg-[var(--bg-inset)] text-[var(--accent)] border-y border-[var(--border-subtle)]"
                >
                  {group.header}
                </td>
              </tr>
              <For each={group.pairs}>{(pair) => <PairRow pair={pair} columns={model().columnCount} />}</For>
            </tbody>
          )}
        </For>
      </table>
    </div>
  )
}

export default GitDiffTable
