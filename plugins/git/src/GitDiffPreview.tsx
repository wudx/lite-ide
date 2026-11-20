import type { PreviewProps } from '@lite-ide/kernel'
import { getI18n, WorkspaceBackendKey } from '@lite-ide/workbench'
import Loader2 from 'lucide-solid/icons/loader-circle'
import RotateCw from 'lucide-solid/icons/rotate-cw'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  type Component,
} from 'solid-js'
import {
  diffStats,
  parseUnifiedDiff,
  splitHunkRows,
  synthesizeAddedDiff,
  type DiffRow,
} from './diff-parse'
import {
  GitBackendKey,
  GitStoreKey,
  hasStagedChanges,
  hasUnstagedChanges,
  isUntrackedEntry,
  type GitDiffSection,
} from './git-store'

const ROW_MARKERS: Record<string, string> = { add: '+', del: '−', context: '' }

const ROW_BG: Record<string, string> = {
  add: 'bg-[var(--diff-add-bg)]',
  del: 'bg-[var(--diff-del-bg)]',
}

const MARKER_TONE: Record<string, string> = {
  add: 'text-[var(--diff-add-text)]',
  del: 'text-[var(--diff-del-text)]',
  context: 'text-transparent',
}

type DiffViewMode = 'unified' | 'split'

const DIFF_VIEW_MODE_STORAGE_KEY = 'lite-ide:git:diff-view-mode'

function readStoredDiffViewMode(): DiffViewMode {
  if (typeof localStorage === 'undefined') return 'unified'
  try {
    return localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

function writeStoredDiffViewMode(mode: DiffViewMode): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

/** One column of a side-by-side row (old line left, new line right). */
function SplitCell(props: { row: DiffRow | null; side: 'left' | 'right'; bordered: boolean }) {
  return (
    <div
      data-git-diff-side={props.side}
      class={`w-1/2 min-w-0 flex items-stretch ${props.bordered ? 'border-r border-[var(--border-subtle)]' : ''} ${
        props.row ? (ROW_BG[props.row.kind] ?? '') : 'bg-[var(--bg-subtle)]'
      }`}
    >
      <Show when={props.row} fallback={<span class="flex-1" />}>
        {(row) => (
          <>
            <span class="w-9 shrink-0 pr-1.5 text-right text-[var(--text-muted)]/60 tabular-nums select-none">
              {props.side === 'left' ? (row().oldNo ?? '') : (row().newNo ?? '')}
            </span>
            <span
              class={`w-3.5 shrink-0 text-center select-none ${MARKER_TONE[row().kind] ?? ''}`}
            >
              {ROW_MARKERS[row().kind] ?? ''}
            </span>
            {/* Side-by-side halves wrap long lines: synchronized horizontal
                scrolling between independent halves is not worth the wiring. */}
            <span class="flex-1 whitespace-pre-wrap break-all pr-2 text-[var(--text-primary)]">
              {row().text}
            </span>
          </>
        )}
      </Show>
    </div>
  )
}

/**
 * Diff preview behind the `git-diff` previewer provider. Shows the unified
 * diff of one file for the staged (HEAD↔index) or unstaged (index↔worktree)
 * comparison; Git-panel rows select the section matching the clicked row.
 */
export const GitDiffPreview: Component<PreviewProps> = (props) => {
  const i18n = getI18n(props.scope)
  const store = props.scope.tryGet(GitStoreKey)
  const backend = props.scope.tryGet(GitBackendKey)
  // Untracked files are read through the workspace FS, not the git backend.
  const fsBackend = props.scope.tryGet(WorkspaceBackendKey)

  const entry = createMemo(() =>
    store?.status()?.entries.find((e) => e.relPath === props.file.relPath),
  )

  const initialSection = (): GitDiffSection => {
    const focus = store?.diffFocus()
    if (focus && focus.relPath === props.file.relPath) return focus.section
    const current = entry()
    // Opened without a Git-panel click (e.g. the previewer pill): prefer the
    // comparison that actually carries changes.
    if (current && hasStagedChanges(current) && !hasUnstagedChanges(current)) {
      return 'staged'
    }
    return 'unstaged'
  }

  /** Commit SHA when the preview compares a file inside one commit (history view). */
  const initialRev = (): string | null => {
    const focus = store?.diffFocus()
    if (focus && focus.relPath === props.file.relPath && focus.sha) return focus.sha
    return null
  }

  const [section, setSection] = createSignal<GitDiffSection>(initialSection())
  const [rev, setRev] = createSignal<string | null>(initialRev())
  const [viewMode, setViewMode] = createSignal<DiffViewMode>(readStoredDiffViewMode())
  const [rawDiff, setRawDiff] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [refreshTick, setRefreshTick] = createSignal(0)
  let fetchSeq = 0
  let trackedKey: string | null = null

  function toggleViewMode(mode: DiffViewMode) {
    setViewMode(mode)
    writeStoredDiffViewMode(mode)
  }

  // Follow later Git-panel clicks on the same file so re-opening a row swaps
  // the comparison (section or commit) without remounting the tab.
  createEffect(() => {
    const focus = store?.diffFocus()
    if (focus && focus.relPath === props.file.relPath) {
      setSection(focus.section)
      setRev(focus.sha ?? null)
    }
  })

  createEffect(() => {
    const storeRef = store
    const backendRef = backend
    if (!storeRef || !backendRef) return
    // PreviewHost reuses this component instance across tabs with the same
    // previewer; a different file (or commit) must not inherit the previous
    // comparison or flash the previous diff while loading.
    const key = `${rev() ?? ''}\u0000${props.file.relPath}`
    if (trackedKey !== key) {
      trackedKey = key
      setSection(initialSection())
      setRev(initialRev())
      setRawDiff(null)
      setError(null)
    }
    // Status refreshes after every git action and debounced fs event, so the
    // diff tracks stage/unstage/discard without extra wiring. Commit diffs
    // are immutable; only focus/relPath/refresh changes retrigger them.
    storeRef.status()
    props.file.relPath
    section()
    rev()
    refreshTick()

    const seq = ++fetchSeq
    const staged = section() === 'staged'
    const commitSha = rev()
    const current = entry()
    const fsRef = fsBackend

    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        let text: string
        if (commitSha) {
          const files = await backendRef.show(props.file.projectId, commitSha, [
            props.file.relPath,
          ])
          text = files.find((f) => f.relPath === props.file.relPath)?.patch ?? ''
        } else if (fsRef && current && !staged && isUntrackedEntry(current)) {
          // Untracked paths never appear in `git diff`; render the whole file
          // as additions instead.
          const payload = await fsRef.readText(props.file.projectId, props.file.relPath)
          text = synthesizeAddedDiff(props.file.relPath, payload.content)
        } else {
          const files = await backendRef.diff(props.file.projectId, {
            staged,
            relPaths: [props.file.relPath],
          })
          text = files.find((f) => f.relPath === props.file.relPath)?.patch ?? ''
        }
        if (seq !== fetchSeq) return
        setRawDiff(text)
      } catch (err) {
        if (seq !== fetchSeq) return
        setRawDiff(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === fetchSeq) {
          setLoading(false)
        }
      }
    }

    void run()
  })

  const parsed = createMemo(() => {
    const raw = rawDiff()
    return raw === null ? null : parseUnifiedDiff(raw)
  })

  const stats = createMemo(() => {
    const current = parsed()
    return current ? diffStats(current) : { additions: 0, deletions: 0 }
  })

  type DiffBodyState = 'empty' | 'binary' | 'combined' | 'rows'

  const bodyState = createMemo<DiffBodyState>(() => {
    const current = parsed()
    if (!current) return 'empty'
    if (current.isCombined) return 'combined'
    if (current.isBinary) return 'binary'
    return current.hunks.length > 0 ? 'rows' : 'empty'
  })

  const showSectionToggle = createMemo(() => {
    // Commit diffs have a single immutable comparison; no section switcher.
    if (rev()) return false
    const current = entry()
    // Status not loaded yet: hide the switcher until we know the file's state
    // (the body's loading spinner covers this window).
    if (!current) return false
    return hasStagedChanges(current) || hasUnstagedChanges(current)
  })

  return (
    <div
      data-testid="git-diff-view"
      data-git-diff-section={section()}
      data-git-diff-view-mode={viewMode()}
      class="flex-1 min-h-0 flex flex-col"
    >
      {/* Toolbar: comparison switcher, +/− stats, refresh */}
      <div class="shrink-0 px-3 py-1.5 border-b border-[var(--border-subtle)] flex items-center gap-2">
        <Show
          when={rev()}
          fallback={
            <Show
              when={showSectionToggle()}
              fallback={
                <span class="text-[11px] text-[var(--text-muted)] leading-normal">
                  {i18n.t('git.diff.fileUnchanged')}
                </span>
              }
            >
              <div
                role="tablist"
                aria-label={i18n.t('git.diff.switchComparison')}
                class="flex items-center gap-0.5 bg-[var(--bg-inset)] p-0.5 rounded-lg border border-[var(--border-subtle)]"
              >
                <For each={['staged', 'unstaged'] as const}>
                  {(candidate) => (
                    <button
                      type="button"
                      role="tab"
                      data-testid="git-diff-section"
                      data-section={candidate}
                      aria-selected={section() === candidate}
                      class={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all duration-150 ${
                        section() === candidate
                          ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-panel)] shadow-sm'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
                      }`}
                      onClick={() => setSection(candidate)}
                    >
                      {i18n.t(
                        candidate === 'staged' ? 'git.diff.section.staged' : 'git.diff.section.unstaged',
                      )}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          }
        >
          <span
            data-testid="git-diff-commit-sha"
            class="shrink-0 px-2.5 py-0.5 rounded-md text-[11px] font-medium font-mono tabular-nums leading-normal bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--accent)]"
          >
            {i18n.t('git.diff.range.commit', { sha: rev()!.slice(0, 7) })}
          </span>
        </Show>

        <span
          data-testid="git-diff-stats"
          class="shrink-0 text-[11px] font-mono tabular-nums leading-normal flex items-center gap-1.5"
        >
          <span class="text-[var(--diff-add-text)]">+{stats().additions}</span>
          <span class="text-[var(--diff-del-text)]">−{stats().deletions}</span>
        </span>

        <div class="ml-auto min-w-0 truncate text-[10.5px] text-[var(--text-muted)] leading-normal hidden md:block">
          <Show
            when={parsed()?.oldPath && parsed()?.newPath && parsed()!.oldPath !== parsed()!.newPath}
            fallback={
              rev()
                ? i18n.t('git.diff.range.commit', { sha: rev()!.slice(0, 7) })
                : i18n.t(
                    section() === 'staged' ? 'git.diff.range.staged' : 'git.diff.range.unstaged',
                  )
            }
          >
            {`${parsed()!.oldPath} → ${parsed()!.newPath}`}
          </Show>
        </div>

        <div
          role="tablist"
          aria-label={i18n.t('git.diff.switchView')}
          class="shrink-0 flex items-center gap-0.5 bg-[var(--bg-inset)] p-0.5 rounded-lg border border-[var(--border-subtle)]"
        >
          <For each={['unified', 'split'] as const}>
            {(mode) => (
              <button
                type="button"
                role="tab"
                data-testid="git-diff-view-toggle"
                data-view={mode}
                aria-selected={viewMode() === mode}
                title={i18n.t(mode === 'unified' ? 'git.diff.view.unified' : 'git.diff.view.split')}
                class={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all duration-150 ${
                  viewMode() === mode
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-panel)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
                }`}
                onClick={() => toggleViewMode(mode)}
              >
                {i18n.t(mode === 'unified' ? 'git.diff.view.unified' : 'git.diff.view.split')}
              </button>
            )}
          </For>
        </div>

        <button
          type="button"
          aria-label={i18n.t('git.diff.refresh')}
          title={i18n.t('git.diff.refresh')}
          class="shrink-0 p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95"
          onClick={() => setRefreshTick((n) => n + 1)}
        >
          <RotateCw class={`w-3.5 h-3.5 ${loading() ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Body */}
      <Show
        when={!error()}
        fallback={
          <div class="flex-1 m-3 p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs break-words overflow-y-auto">
            {i18n.t('git.diff.loadError', { message: error() ?? '' })}
          </div>
        }
      >
        <Show
          when={!loading() || rawDiff() !== null}
          fallback={
            <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
              <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
              <span>{i18n.t('git.diff.loading')}</span>
            </div>
          }
        >
          <Show
            when={store && backend}
            fallback={
              <div class="flex-1 flex items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]">
                {i18n.t('git.diff.unavailable')}
              </div>
            }
          >
            <Switch>
              <Match when={bodyState() === 'combined'}>
                <div class="flex-1 flex items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]">
                  {i18n.t('git.diff.conflictUnsupported')}
                </div>
              </Match>
              <Match when={bodyState() === 'binary'}>
                <div class="flex-1 flex items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]">
                  {i18n.t('git.diff.binary')}
                </div>
              </Match>
              <Match when={bodyState() === 'empty'}>
                <div
                  class="flex-1 flex items-center justify-center px-6 text-center text-xs text-[var(--text-muted)]"
                  data-testid="git-diff-empty"
                >
                  {i18n.t('git.diff.empty')}
                </div>
              </Match>
              <Match when={parsed()}>
                {(diff) => (
                  <Switch>
                    <Match when={viewMode() === 'split'}>
                      <div
                        data-testid="git-diff-rows"
                        class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden font-mono text-[11px] leading-[18px] select-none"
                      >
                        <For each={diff().hunks}>
                          {(hunk) => (
                            <>
                              <div class="sticky top-0 z-10 px-2 py-0.5 bg-[var(--bg-inset)] text-[var(--accent)] whitespace-pre border-y border-[var(--border-subtle)]">
                                {hunk.header}
                              </div>
                              <For each={splitHunkRows(hunk.rows)}>
                                {(pair) => (
                                  <div class="flex items-stretch" data-git-diff-split-row="">
                                    <SplitCell row={pair.left} side="left" bordered={true} />
                                    <SplitCell row={pair.right} side="right" bordered={false} />
                                  </div>
                                )}
                              </For>
                            </>
                          )}
                        </For>
                      </div>
                    </Match>
                    <Match when={true}>
                      <div
                        data-testid="git-diff-rows"
                        class="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-[18px] select-none"
                      >
                        <For each={diff().hunks}>
                          {(hunk) => (
                            <>
                              <div class="sticky top-0 z-10 px-2 py-0.5 bg-[var(--bg-inset)] text-[var(--accent)] whitespace-pre border-y border-[var(--border-subtle)]">
                                {hunk.header}
                              </div>
                              <For each={hunk.rows}>
                                {(row) => (
                                  <div
                                    data-git-diff-kind={row.kind}
                                    class={`flex items-stretch ${ROW_BG[row.kind] ?? ''}`}
                                  >
                                    <span class="w-10 shrink-0 pr-1.5 text-right text-[var(--text-muted)]/60 tabular-nums select-none">
                                      {row.oldNo ?? ''}
                                    </span>
                                    <span class="w-10 shrink-0 pr-1.5 text-right text-[var(--text-muted)]/60 tabular-nums select-none border-r border-[var(--border-subtle)] mr-1.5">
                                      {row.newNo ?? ''}
                                    </span>
                                    <span
                                      class={`w-3.5 shrink-0 text-center select-none ${MARKER_TONE[row.kind] ?? ''}`}
                                    >
                                      {ROW_MARKERS[row.kind] ?? ''}
                                    </span>
                                    <span class="flex-1 whitespace-pre pr-4 text-[var(--text-primary)]">
                                      {row.text}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </>
                          )}
                        </For>
                      </div>
                    </Match>
                  </Switch>
                )}
              </Match>
            </Switch>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export default GitDiffPreview
