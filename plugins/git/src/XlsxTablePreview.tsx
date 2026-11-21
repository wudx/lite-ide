import type { PreviewProps } from '@lite-ide/kernel'
import { getI18n, ProjectSelectionKey } from '@lite-ide/workbench'
import RotateCw from 'lucide-solid/icons/rotate-cw'
import Loader2 from 'lucide-solid/icons/loader-circle'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type Component,
} from 'solid-js'
import {
  GitBackendKey,
  GitStoreKey,
  GIT_DIFF_PREVIEWER_ID,
  hasStagedChanges,
  hasUnstagedChanges,
} from './git-store'
import { decodeSheetRows } from './xlsx-diff'

/** Hard cap on rendered columns; wider sheets are truncated with a notice. */
const MAX_PREVIEW_COLUMNS = 256

/**
 * Read-only sheet preview behind the `git-xlsx-table` previewer provider:
 * clicking a workbook in the explorer renders its first sheet as a table
 * (values as Excel displays them, via the same SheetJS pipeline as the diff).
 * When the file carries uncommitted changes, the toolbar offers a jump into
 * the Git diff previewer's table comparison.
 */
export const XlsxTablePreview: Component<PreviewProps> = (props) => {
  const i18n = getI18n(props.scope)
  const backend = props.scope.tryGet(GitBackendKey)
  const store = props.scope.tryGet(GitStoreKey)
  const selection = props.scope.get(ProjectSelectionKey)

  const [rows, setRows] = createSignal<string[][] | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [refreshTick, setRefreshTick] = createSignal(0)
  let fetchSeq = 0
  let trackedPath: string | null = null

  createEffect(() => {
    const backendRef = backend
    if (!backendRef) return
    // PreviewHost reuses this component across tabs; a different file must
    // not inherit the previous sheet or flash stale rows while loading.
    if (trackedPath !== props.file.relPath) {
      trackedPath = props.file.relPath
      setRows(null)
      setError(null)
    }
    props.file.relPath
    refreshTick()
    // Status refreshes after git actions and debounced fs events; retouching
    // it keeps the sheet in sync when the workbook changes on disk.
    store?.status()

    const seq = ++fetchSeq
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        // The worktree snapshot keeps this a plain file preview; the diff
        // previewer compares snapshots itself.
        const blob = await backendRef.readBlob(props.file.projectId, 'worktree', props.file.relPath)
        if (seq !== fetchSeq) return
        const parsed = blob ? await decodeSheetRows(blob) : []
        if (seq !== fetchSeq) return
        setRows(parsed)
      } catch (err) {
        if (seq !== fetchSeq) return
        setRows(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === fetchSeq) {
          setLoading(false)
        }
      }
    }
    void run()
  })

  const entry = createMemo(() =>
    store?.status()?.entries.find((e) => e.relPath === props.file.relPath),
  )
  const hasChanges = createMemo(() => {
    const current = entry()
    if (!current) return false
    return hasStagedChanges(current) || hasUnstagedChanges(current)
  })

  const deleted = createMemo(() => entry()?.y === 'D')
  const emptyReason = createMemo(() => (deleted() ? 'deleted' : 'empty'))
  const rowCount = createMemo(() => rows()?.length ?? 0)
  const colCount = createMemo(
    () => rows()?.reduce((max, row) => Math.max(max, row.length), 0) ?? 0,
  )
  // Wide sheets would explode the fixed-layout table; cap the rendered grid.
  const displayCols = createMemo(() => Math.min(colCount(), MAX_PREVIEW_COLUMNS))
  const colsTruncated = createMemo(() => colCount() > MAX_PREVIEW_COLUMNS)

  function openComparison() {
    const current = entry()
    // Mirror GitDiffPreview's initial-section heuristic: prefer the
    // comparison that actually carries changes.
    const section =
      current && hasStagedChanges(current) && !hasUnstagedChanges(current) ? 'staged' : 'unstaged'
    store?.setDiffFocus({ relPath: props.file.relPath, section })
    void selection.selectFile(props.file.relPath, {
      preferredPreviewerId: GIT_DIFF_PREVIEWER_ID,
      allowMissing: true,
    })
  }

  return (
    <div data-testid="xlsx-table-preview" class="flex-1 min-h-0 flex flex-col">
      {/* Toolbar: sheet stats, comparison shortcut, refresh */}
      <div class="shrink-0 px-3 py-1.5 border-b border-[var(--border-subtle)] flex items-center gap-2">
        <span class="text-[11px] text-[var(--text-muted)] leading-normal">
          {i18n.t('git.preview.sheetInfo', {
            rows: String(rowCount()),
            cols: String(displayCols()),
          })}
        </span>
        <div class="ml-auto flex items-center gap-2">
          <Show when={hasChanges()}>
            <button
              type="button"
              data-testid="xlsx-open-comparison"
              class="px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-[var(--bg-inset)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95"
              onClick={openComparison}
            >
              {i18n.t('git.preview.openComparison')}
            </button>
          </Show>
          <button
            type="button"
            aria-label={i18n.t('git.preview.refresh')}
            title={i18n.t('git.preview.refresh')}
            class="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95"
            onClick={() => setRefreshTick((n) => n + 1)}
          >
            <RotateCw class={`w-3.5 h-3.5 ${loading() ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <Show
        when={!error()}
        fallback={
          <div class="flex-1 m-3 p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs break-words overflow-y-auto">
            {i18n.t('git.preview.loadError', { message: error() ?? '' })}
          </div>
        }
      >
        <Show
          when={!loading() || rows() !== null}
          fallback={
            <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
              <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
              <span>{i18n.t('git.preview.loading')}</span>
            </div>
          }
        >
          <Show
            when={rowCount() > 0}
            fallback={
              <div class="flex-1 flex items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]">
                {i18n.t(emptyReason() === 'deleted' ? 'git.preview.deleted' : 'git.preview.empty')}
              </div>
            }
          >
            <div class="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-[18px] select-none">
              {/* border-separate (not collapse) keeps the sticky header row
                  working in Chromium-based webviews. */}
              <table
                data-testid="xlsx-sheet-table"
                class="w-full table-fixed border-separate border-spacing-0"
              >
                <Show when={colsTruncated()}>
                  <div class="shrink-0 px-3 py-1 border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] leading-normal">
                    {i18n.t('git.preview.truncatedCols', { cols: String(MAX_PREVIEW_COLUMNS) })}
                  </div>
                </Show>
                <colgroup>
                  <col class="w-9" />
                  <For each={Array.from({ length: displayCols() })}>{() => <col />}</For>
                </colgroup>
                <thead>
                  <tr>
                    <td class="sticky top-0 z-10 w-9 bg-[var(--bg-inset)] border-b border-[var(--border-subtle)]" />
                    <For each={rows()![0].slice(0, MAX_PREVIEW_COLUMNS)}>
                      {(cell) => (
                        <td class="sticky top-0 z-10 min-w-0 px-1.5 py-0.5 bg-[var(--bg-inset)] font-medium text-[var(--text-muted)] border-b border-[var(--border-subtle)] truncate">
                          {cell}
                        </td>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()!.slice(1)}>
                    {(row, index) => (
                      <tr>
                        <td class="px-1 pr-1.5 text-right tabular-nums text-[var(--text-muted)]/60 select-none align-top">
                          {index() + 2}
                        </td>
                        <For each={Array.from({ length: displayCols() })}>
                          {(_, column) => (
                            <td class="min-w-0 px-1.5 align-top whitespace-pre-wrap break-all text-[var(--text-primary)]">
                              {row[column()] ?? ''}
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export default XlsxTablePreview
