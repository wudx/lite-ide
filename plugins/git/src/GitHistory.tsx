import type { ProjectScope } from '@lite-ide/kernel'
import type { GitCommitInfo, GitDiffFile } from '@lite-ide/protocol'
import { FileIcon, getI18n, ProjectSelectionKey, type TranslateFn } from '@lite-ide/workbench'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import GitCommitHorizontal from 'lucide-solid/icons/git-commit-horizontal'
import Loader2 from 'lucide-solid/icons/loader-circle'
import RotateCw from 'lucide-solid/icons/rotate-cw'
import {
  createSignal,
  For,
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
  const i18n = getI18n(props.scope)

  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [filesBySha, setFilesBySha] = createSignal<Record<string, CommitFilesState>>({})

  onMount(() => {
    void store.ensureCommitsLoaded()
  })

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
    <div
      data-testid="git-history-list"
      class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
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
  )
}
