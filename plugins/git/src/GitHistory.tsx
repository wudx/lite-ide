import type { ProjectScope } from '@lite-ide/kernel'
import type { GitCommitInfo, GitDiffFile } from '@lite-ide/protocol'
import {
  ConfirmDialogKey,
  FileIcon,
  getI18n,
  ProjectSelectionKey,
  type TranslateFn,
} from '@lite-ide/workbench'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import GitBranch from 'lucide-solid/icons/git-branch'
import GitCommitHorizontal from 'lucide-solid/icons/git-commit-horizontal'
import GitMerge from 'lucide-solid/icons/git-merge'
import Loader2 from 'lucide-solid/icons/loader-circle'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import RotateCw from 'lucide-solid/icons/rotate-cw'
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from 'solid-js'
import {
  commitFileLetter,
  GIT_DIFF_PREVIEWER_ID,
  GitBackendKey,
  GitStoreKey,
} from './git-store'
import { statusTone } from './tone'

/** Formats an author time as a short relative label; older than a week falls back to the date. */
function formatCommitDate(ms: number, t: TranslateFn): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000)
  if (minutes < 1) return t('git.history.time.justNow', undefined, '刚刚')
  if (minutes < 60) return t('git.history.time.minutesAgo', { n: minutes }, '{n} 分钟前')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('git.history.time.hoursAgo', { n: hours }, '{n} 小时前')
  const days = Math.floor(hours / 24)
  if (days < 7) return t('git.history.time.daysAgo', { n: days }, '{n} 天前')
  const date = new Date(ms)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function fileNameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? relPath : relPath.slice(idx + 1)
}

interface CommitFilesState {
  loading: boolean
  files: GitDiffFile[] | null
  error: string | null
}

interface CommitRowProps {
  scope: ProjectScope
  commit: GitCommitInfo
  expanded: boolean
  files: CommitFilesState | undefined
  onToggle: (commit: GitCommitInfo) => void
  onOpenFile: (commit: GitCommitInfo, relPath: string) => void
  onContextMenu: (commit: GitCommitInfo, e: MouseEvent) => void
}

function CommitRow(props: CommitRowProps) {
  const i18n = getI18n(props.scope)
  const titleText = () =>
    props.commit.body
      ? `${props.commit.subject}\n\n${props.commit.body}`
      : props.commit.subject

  return (
    <>
      <button
        type="button"
        data-git-commit={props.commit.sha}
        aria-expanded={props.expanded}
        title={titleText()}
        class="group/commit w-full mx-0 px-1.5 py-1.5 rounded-lg flex flex-col items-stretch gap-0.5 text-left hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer"
        onClick={() => props.onToggle(props.commit)}
        onContextMenu={(e) => props.onContextMenu(props.commit, e)}
      >
        <span class="w-full flex items-center gap-1.5 min-w-0">
          <ChevronRight
            class={`w-3 h-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${props.expanded ? 'rotate-90' : ''}`}
          />
          <span class="truncate flex-1 text-[11.5px] text-[var(--text-primary)] leading-normal min-w-0">
            {props.commit.subject}
          </span>
          <span class="shrink-0 font-mono text-[10px] text-[var(--text-muted)] tabular-nums leading-normal">
            {props.commit.shortSha}
          </span>
        </span>
        <span class="w-full flex items-center gap-1.5 pl-[18px] min-w-0 text-[10px] text-[var(--text-muted)] leading-normal">
          <GitCommitHorizontal class="w-3 h-3 shrink-0 text-[var(--accent)]" />
          <span class="truncate min-w-0">{props.commit.author}</span>
          <span class="shrink-0">·</span>
          <span class="shrink-0 tabular-nums">
            {formatCommitDate(props.commit.dateMs, i18n.t)}
          </span>
        </span>
      </button>
      <Show when={props.expanded}>
        <div
          data-git-commit-files={props.commit.sha}
          class="ml-[26px] mr-1.5 mb-1 border-l border-[var(--border-subtle)] pl-1 flex flex-col gap-0.5"
        >
          <Show
            when={props.files && !props.files.loading}
            fallback={
              <div class="px-1.5 py-1 flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
                <Loader2 class="w-3 h-3 animate-spin text-[var(--accent)]" />
                <span>{i18n.t('git.history.filesLoading')}</span>
              </div>
            }
          >
            <Show
              when={props.files && !props.files.error}
              fallback={
                <div class="px-1.5 py-1 text-[10.5px] text-[var(--danger-text)] break-words">
                  {i18n.t('git.history.filesError', {
                    message: props.files?.error ?? '',
                  })}
                </div>
              }
            >
              <Show
                when={(props.files?.files?.length ?? 0) > 0}
                fallback={
                  <div class="px-1.5 py-1 text-[10.5px] text-[var(--text-muted)] leading-normal">
                    {i18n.t('git.history.noFiles')}
                  </div>
                }
              >
                <For each={props.files?.files ?? []}>
                  {(file) => {
                    const letter = () => commitFileLetter(file.patch)
                    return (
                      <button
                        type="button"
                        data-git-commit-path={file.relPath}
                        title={i18n.t('git.history.openDiff', {
                          path: file.relPath,
                          sha: props.commit.shortSha,
                        })}
                        class="w-full px-1.5 h-[24px] rounded-md flex items-center gap-1.5 text-left text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-100 cursor-pointer"
                        onClick={() => props.onOpenFile(props.commit, file.relPath)}
                      >
                        <FileIcon name={fileNameOf(file.relPath)} isDir={false} />
                        <span class="truncate flex-1 leading-normal min-w-0">
                          {fileNameOf(file.relPath)}
                        </span>
                        <span
                          class={`shrink-0 w-4 h-4 rounded-md flex items-center justify-center text-[10px] font-semibold font-mono ${statusTone(letter())}`}
                        >
                          {letter()}
                        </span>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </>
  )
}

/**
 * Commit history list behind the Git panel's history mode: recent commits on
 * the current branch, each expandable into its changed files. Clicking a file
 * opens the `git-diff` previewer scoped to that commit via `diffFocus.sha`.
 */
export const GitHistory: Component<{ scope: ProjectScope }> = (props) => {
  const store = props.scope.get(GitStoreKey)
  const backend = props.scope.get(GitBackendKey)
  const selection = props.scope.get(ProjectSelectionKey)
  const dialogs = props.scope.tryGet(ConfirmDialogKey)
  const i18n = getI18n(props.scope)

  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [filesBySha, setFilesBySha] = createSignal<Record<string, CommitFilesState>>({})
  const [ctxMenu, setCtxMenu] = createSignal<{
    sha: string
    shortSha: string
    subject: string
    x: number
    y: number
  } | null>(null)
  const [branchDialog, setBranchDialog] = createSignal<{
    sha: string
    shortSha: string
    subject: string
  } | null>(null)
  const [branchName, setBranchName] = createSignal('')
  let ctxMenuRef: HTMLDivElement | undefined
  let branchInputRef: HTMLInputElement | undefined

  onMount(() => {
    void store.ensureCommitsLoaded()
  })

  createEffect(() => {
    if (!ctxMenu()) return
    const onPointerDown = (e: PointerEvent) => {
      if (ctxMenuRef?.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    const onScroll = () => setCtxMenu(null)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    })
  })

  createEffect(() => {
    if (!branchDialog()) return
    branchInputRef?.focus()
  })

  function handleCommitContextMenu(commit: GitCommitInfo, e: MouseEvent) {
    e.preventDefault()
    if (store.committing() || store.mutating()) return
    // Keep the menu inside the viewport.
    const MENU_WIDTH = 200
    const MENU_HEIGHT = 100
    setCtxMenu({
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 4)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 4)),
    })
  }

  async function resetToCommitFromMenu() {
    const menu = ctxMenu()
    if (!menu) return
    setCtxMenu(null)
    // Fail closed: without the dialog service there is no way to confirm a
    // destructive action, so do nothing rather than resetting silently.
    if (!dialogs) return
    const choice = await dialogs.confirm({
      title: i18n.t('git.history.reset.title'),
      message: i18n.t('git.history.reset.message', {
        sha: menu.shortSha,
        subject: menu.subject,
      }),
      actions: [
        { id: 'reset', label: i18n.t('git.history.reset.confirm'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('git.discard.cancel'), variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (choice !== 'reset') return
    await store.resetToCommit(menu.sha)
  }

  function createBranchFromMenu() {
    const menu = ctxMenu()
    if (!menu) return
    setCtxMenu(null)
    setBranchName('')
    setBranchDialog({ sha: menu.sha, shortSha: menu.shortSha, subject: menu.subject })
  }

  function cherryPickFromMenu() {
    const menu = ctxMenu()
    if (!menu) return
    setCtxMenu(null)
    void store.cherryPick(menu.sha)
  }

  async function confirmCreateBranch() {
    const dialog = branchDialog()
    if (!dialog) return
    const ok = await store.createBranchAt(branchName(), dialog.sha)
    if (ok) setBranchDialog(null)
  }

  async function toggleCommit(commit: GitCommitInfo) {
    const wasOpen = Boolean(expanded()[commit.sha])
    setExpanded((prev) => ({ ...prev, [commit.sha]: !wasOpen }))
    if (wasOpen || filesBySha()[commit.sha]) return
    setFilesBySha((prev) => ({
      ...prev,
      [commit.sha]: { loading: true, files: null, error: null },
    }))
    try {
      const files = await backend.show(props.scope.id, commit.sha)
      setFilesBySha((prev) => ({
        ...prev,
        [commit.sha]: { loading: false, files, error: null },
      }))
    } catch (err) {
      setFilesBySha((prev) => ({
        ...prev,
        [commit.sha]: {
          loading: false,
          files: null,
          error: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  function openCommitFile(commit: GitCommitInfo, relPath: string) {
    store.setDiffFocus({ relPath, section: 'staged', sha: commit.sha })
    void selection.selectFile(relPath, {
      preferredPreviewerId: GIT_DIFF_PREVIEWER_ID,
      allowMissing: true,
    })
  }

  return (
    <>
      <div
        data-testid="git-history-list"
        class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        onContextMenu={(e) => e.preventDefault()}
      >
      <Show
        when={!store.commitsLoading()}
        fallback={
          <div class="flex items-center justify-center gap-2 py-8 text-xs text-[var(--text-muted)]">
            <Loader2 class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
            <span>{i18n.t('git.history.loading')}</span>
          </div>
        }
      >
        <Show
          when={!store.commitsError() || store.commits().length > 0}
          fallback={
            <div class="px-3 py-6 flex flex-col items-center gap-2 text-center">
              <div class="text-[11px] text-[var(--danger-text)] break-words">
                {i18n.t('git.history.loadError', { message: store.commitsError() ?? '' })}
              </div>
              <button
                type="button"
                data-testid="git-history-retry"
                class="px-2.5 h-[26px] rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                onClick={() => void store.reloadCommits()}
              >
                {i18n.t('git.history.retry')}
              </button>
            </div>
          }
        >
          <Show
            when={store.commits().length > 0}
            fallback={
              <div class="px-3 py-8 text-center text-xs text-[var(--text-muted)]">
                {i18n.t('git.history.empty')}
              </div>
            }
          >
            <Show when={store.commitsError()}>
              <div class="mx-1.5 mt-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--danger-text)] bg-[var(--danger-bg)] border border-[var(--danger-border)] break-words flex items-start gap-2">
                <span class="flex-1 min-w-0">
                  {i18n.t('git.history.loadError', { message: store.commitsError() ?? '' })}
                </span>
                <button
                  type="button"
                  data-testid="git-history-retry"
                  class="shrink-0 px-2 h-[22px] rounded-md border border-[var(--border-panel)] bg-[var(--bg-surface)] text-[10.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  onClick={() => void store.reloadCommits()}
                >
                  {i18n.t('git.history.retry')}
                </button>
              </div>
            </Show>
            <div class="py-1.5 flex flex-col gap-0.5 px-1">
              <For each={store.commits()}>
                {(commit) => (
                  <CommitRow
                    scope={props.scope}
                    commit={commit}
                    expanded={Boolean(expanded()[commit.sha])}
                    files={filesBySha()[commit.sha]}
                    onToggle={(c) => void toggleCommit(c)}
                    onOpenFile={openCommitFile}
                    onContextMenu={handleCommitContextMenu}
                  />
                )}
              </For>
            </div>
            <Show when={store.hasMoreCommits()}>
              <div class="px-3 pb-3 pt-1 flex justify-center">
                <button
                  type="button"
                  data-testid="git-history-load-more"
                  disabled={store.commitsLoadingMore()}
                  class="px-3 h-[26px] rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] flex items-center justify-center gap-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  onClick={() => void store.loadMoreCommits()}
                >
                  <Show
                    when={!store.commitsLoadingMore()}
                    fallback={<Loader2 class="w-3 h-3 animate-spin text-[var(--accent)]" />}
                  >
                    <RotateCw class="w-3 h-3" />
                  </Show>
                  <span>{i18n.t('git.history.loadMore')}</span>
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
      </div>

      {/* Commit context menu: reset / branch / cherry-pick shortcuts. */}
      <Show when={ctxMenu()}>
        {(menu) => (
          <div
            ref={ctxMenuRef}
            role="menu"
            aria-label={i18n.t('git.history.menu.label')}
            data-testid="git-history-context-menu"
            class="fixed z-50 min-w-[190px] rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-[var(--shadow-popover)] p-1 flex flex-col"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              data-testid="git-history-reset"
              disabled={store.committing() || store.mutating()}
              class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={resetToCommitFromMenu}
            >
              <RotateCcw class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <span class="truncate leading-normal min-w-0">
                {i18n.t('git.history.menu.reset')}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="git-history-create-branch"
              disabled={store.committing() || store.mutating()}
              class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={createBranchFromMenu}
            >
              <GitBranch class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <span class="truncate leading-normal min-w-0">
                {i18n.t('git.history.menu.createBranch')}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="git-history-cherry-pick"
              disabled={store.committing() || store.mutating()}
              class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={cherryPickFromMenu}
            >
              <GitMerge class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <span class="truncate leading-normal min-w-0">
                {i18n.t('git.history.menu.cherryPick')}
              </span>
            </button>
          </div>
        )}
      </Show>

      {/* Create-branch-at-commit dialog: the shared confirm dialog service has
          no text input, so this keeps a small solid dialog inside the plugin. */}
      <Show when={branchDialog()}>
        {(dialog) => (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
            onContextMenu={(e) => e.preventDefault()}
          >
            <div
              role="dialog"
              aria-label={i18n.t('git.history.branch.title')}
              data-testid="git-branch-dialog"
              class="w-[320px] rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-[var(--shadow-popover)] p-4 flex flex-col gap-3"
            >
              <div class="text-xs font-medium text-[var(--text-primary)] leading-normal">
                {i18n.t('git.history.branch.title')}
              </div>
              <div class="text-[11px] text-[var(--text-secondary)] leading-normal break-words">
                {i18n.t('git.history.branch.message', {
                  sha: dialog().shortSha,
                  subject: dialog().subject,
                })}
              </div>
              <input
                ref={branchInputRef}
                data-testid="git-branch-dialog-input"
                type="text"
                value={branchName()}
                placeholder={i18n.t('git.history.branch.placeholder')}
                class="h-[28px] px-2 rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                onInput={(e) => setBranchName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void confirmCreateBranch()
                  if (e.key === 'Escape') setBranchDialog(null)
                }}
              />
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="git-branch-dialog-cancel"
                  class="px-2.5 h-[26px] rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  onClick={() => setBranchDialog(null)}
                >
                  {i18n.t('git.discard.cancel')}
                </button>
                <button
                  type="button"
                  data-testid="git-branch-dialog-confirm"
                  disabled={!branchName().trim() || store.mutating()}
                  class="px-2.5 h-[26px] rounded-lg bg-[var(--accent)] text-[11px] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer"
                  onClick={() => void confirmCreateBranch()}
                >
                  {i18n.t('git.history.branch.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </>
  )
}
