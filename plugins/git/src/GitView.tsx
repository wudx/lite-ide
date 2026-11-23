import type { ProjectScope } from '@lite-ide/kernel'
import type { GitFileStatus, GitStashEntry } from '@lite-ide/protocol'
import {
  AiModelKey,
  ConfirmDialogKey,
  FileIcon,
  getI18n,
  ProjectSelectionKey,
} from '@lite-ide/workbench'
import Archive from 'lucide-solid/icons/archive'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Check from 'lucide-solid/icons/check'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import EllipsisVertical from 'lucide-solid/icons/ellipsis-vertical'
import GitBranch from 'lucide-solid/icons/git-branch'
import GitCommitHorizontal from 'lucide-solid/icons/git-commit-horizontal'
import Globe from 'lucide-solid/icons/globe'
import List from 'lucide-solid/icons/list'
import ListTree from 'lucide-solid/icons/list-tree'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Minus from 'lucide-solid/icons/minus'
import Plus from 'lucide-solid/icons/plus'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import Sparkles from 'lucide-solid/icons/sparkles'
import Trash from 'lucide-solid/icons/trash'
import Undo2 from 'lucide-solid/icons/undo-2'
import Upload from 'lucide-solid/icons/upload'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Component,
} from 'solid-js'
import type { GitBranchInfo } from '@lite-ide/protocol'
import { buildCommitMessagePrompt, stripCodeFence } from './commit-message'
import {
  hasStagedChanges,
  hasUnstagedChanges,
  isStageableEntry,
  isUnmergedEntry,
  isUntrackedEntry,
  statusLetter,
  unstagePathsForEntry,
  GitBackendKey,
  GIT_DIFF_PREVIEWER_ID,
  type GitDiffSection,
  GitStoreKey,
} from './git-store'
import { GitHistory } from './GitHistory'
import { buildGitTree, type GitTreeDirNode } from './git-tree'
import { statusTone } from './tone'

type GitViewMode = 'list' | 'tree'

type GitPanelMode = 'changes' | 'history'

const VIEW_MODE_STORAGE_KEY = 'lite-ide:git:view-mode'
const PANEL_MODE_STORAGE_KEY = 'lite-ide:git:panel-mode'

function readStoredViewMode(): GitViewMode {
  if (typeof localStorage === 'undefined') return 'list'
  try {
    return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'tree' ? 'tree' : 'list'
  } catch {
    return 'list'
  }
}

function writeStoredViewMode(mode: GitViewMode): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

function readStoredPanelMode(): GitPanelMode {
  if (typeof localStorage === 'undefined') return 'changes'
  try {
    return localStorage.getItem(PANEL_MODE_STORAGE_KEY) === 'history' ? 'history' : 'changes'
  } catch {
    return 'changes'
  }
}

function writeStoredPanelMode(mode: GitPanelMode): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PANEL_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

const STATUS_TITLE_KEYS: Record<string, string> = {
  M: 'git.status.modified',
  A: 'git.status.added',
  D: 'git.status.deleted',
  R: 'git.status.renamed',
  C: 'git.status.conflicted',
  U: 'git.status.untracked',
}

interface ChangeRowProps {
  scope: ProjectScope
  entry: GitFileStatus
  section: 'staged' | 'unstaged'
  disabled: boolean
  depth?: number
  showFolder?: boolean
  onOpenDiff: (entry: GitFileStatus, section: GitDiffSection) => void
  onStage: (entry: GitFileStatus) => void
  onUnstage: (entry: GitFileStatus) => void
  onDiscard: (entry: GitFileStatus) => void
  onStash?: (entry: GitFileStatus) => void
}

function ChangeRow(props: ChangeRowProps) {
  const i18n = getI18n(props.scope)
  const letter = () => statusLetter(props.entry, props.section)
  const unmerged = () => isUnmergedEntry(props.entry)
  const dir = () => {
    if (props.showFolder === false) {
      return props.entry.origPath ? `← ${props.entry.origPath}` : ''
    }
    const relPath = props.entry.relPath
    const idx = relPath.lastIndexOf('/')
    const folder = idx === -1 ? '' : relPath.slice(0, idx + 1)
    // Renamed entries surface the original path here (visible on hover).
    return props.entry.origPath
      ? `${folder ? `${folder} ` : ''}← ${props.entry.origPath}`
      : folder
  }
  const titleText = () =>
    props.entry.origPath
      ? `${props.entry.relPath} ← ${props.entry.origPath}`
      : props.entry.relPath
  const name = () => {
    const relPath = props.entry.relPath
    const idx = relPath.lastIndexOf('/')
    return idx === -1 ? relPath : relPath.slice(idx + 1)
  }

  return (
    <div
      data-git-path={props.entry.relPath}
      data-git-section={props.section}
      title={titleText()}
      class="group/row mx-1.5 rounded-lg flex items-center gap-1.5 pr-1.5 pl-2 h-[26px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-100 cursor-pointer"
      style={
        props.depth ? { 'padding-left': `${8 + props.depth * 14}px` } : undefined
      }
      onClick={() => props.onOpenDiff(props.entry, props.section)}
    >
      <FileIcon name={name()} isDir={false} />
      <span class="truncate flex-1 leading-normal min-w-0">{name()}</span>
      <Show when={dir()}>
        <span class="truncate text-[10px] text-[var(--text-muted)] shrink-0 max-w-[45%] hidden group-hover/row:inline leading-normal">
          {dir()}
        </span>
      </Show>
      <span
        class={`shrink-0 w-4 h-4 rounded-md flex items-center justify-center text-[10px] font-semibold font-mono ${statusTone(letter())}`}
        title={
          STATUS_TITLE_KEYS[letter()]
            ? i18n.t(STATUS_TITLE_KEYS[letter()])
            : props.entry.relPath
        }
      >
        {letter()}
      </span>
      <span class="shrink-0 hidden group-hover/row:flex group-focus-within/row:flex items-center gap-0.5">
        {/* Unmerged entries need conflict resolution, not row actions. */}
        <Show when={!unmerged() && props.section === 'unstaged'}>
          <button
            type="button"
            aria-label={i18n.t('git.action.stagePath', { path: props.entry.relPath })}
            title={i18n.t('git.action.stage')}
            disabled={props.disabled}
            class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              props.onStage(props.entry)
            }}
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        </Show>
        <Show when={!unmerged() && props.section === 'staged'}>
          <button
            type="button"
            aria-label={i18n.t('git.action.unstagePath', { path: props.entry.relPath })}
            title={i18n.t('git.action.unstage')}
            disabled={props.disabled}
            class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              props.onUnstage(props.entry)
            }}
          >
            <Minus class="w-3.5 h-3.5" />
          </button>
        </Show>
        <Show when={!unmerged() && props.section === 'unstaged' && props.onStash}>
          <button
            type="button"
            aria-label={i18n.t('git.action.stashPath', { path: props.entry.relPath })}
            title={i18n.t('git.action.stash')}
            disabled={props.disabled}
            class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              props.onStash?.(props.entry)
            }}
          >
            <Archive class="w-3.5 h-3.5" />
          </button>
        </Show>
        <Show when={!unmerged() && props.section === 'unstaged'}>
          <button
            type="button"
            aria-label={i18n.t('git.action.discardPath', { path: props.entry.relPath })}
            title={i18n.t('git.action.discard')}
            disabled={props.disabled}
            class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--danger-text)] hover:bg-[var(--danger-bg)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              props.onDiscard(props.entry)
            }}
          >
            <Undo2 class="w-3.5 h-3.5" />
          </button>
        </Show>
      </span>
    </div>
  )
}

interface TreeDirBranchProps {
  scope: ProjectScope
  node: GitTreeDirNode
  section: 'staged' | 'unstaged'
  depth: number
  collapsedDirs: Readonly<Record<string, boolean>>
  disabled: boolean
  onToggleDir: (key: string) => void
  onOpenDiff: (entry: GitFileStatus, section: GitDiffSection) => void
  onStageEntries: (entries: GitFileStatus[]) => void
  onUnstageEntries: (entries: GitFileStatus[]) => void
  onDiscardEntry: (entry: GitFileStatus) => void
  onStashEntry?: (entry: GitFileStatus) => void
}

function TreeDirBranch(props: TreeDirBranchProps) {
  const i18n = getI18n(props.scope)
  const dirKey = () => `${props.section}:${props.node.relPath}`
  const collapsed = () => Boolean(props.collapsedDirs[dirKey()])
  const stageable = createMemo(() => props.node.allEntries.filter(isStageableEntry))

  return (
    <>
      <div
        data-git-dir={props.node.relPath}
        data-git-section={props.section}
        title={props.node.relPath}
        class="group/row mx-1.5 rounded-lg flex items-center gap-1 pr-1.5 h-[26px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-100"
        style={{ 'padding-left': `${8 + props.depth * 14}px` }}
      >
        <button
          type="button"
          aria-expanded={!collapsed()}
          class="flex-1 min-w-0 h-full flex items-center gap-1.5 text-left cursor-pointer outline-none focus-visible:text-[var(--text-primary)]"
          onClick={() => props.onToggleDir(dirKey())}
        >
          <ChevronRight
            class={`w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${collapsed() ? '' : 'rotate-90'}`}
          />
          <FileIcon name={props.node.label} isDir={true} expanded={!collapsed()} />
          <span class="truncate flex-1 leading-normal min-w-0">{props.node.label}</span>
        </button>
        <span class="shrink-0 hidden group-hover/row:flex group-focus-within/row:flex items-center gap-0.5">
          <Show when={props.section === 'unstaged' && stageable().length > 0}>
            <button
              type="button"
              aria-label={i18n.t('git.action.stagePath', { path: props.node.relPath })}
              title={i18n.t('git.action.stageFolder')}
              disabled={props.disabled}
              class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={() => props.onStageEntries(stageable())}
            >
              <Plus class="w-3.5 h-3.5" />
            </button>
          </Show>
          <Show when={props.section === 'staged'}>
            <button
              type="button"
              aria-label={i18n.t('git.action.unstagePath', { path: props.node.relPath })}
              title={i18n.t('git.action.unstageFolder')}
              disabled={props.disabled}
              class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={() => props.onUnstageEntries(props.node.allEntries)}
            >
              <Minus class="w-3.5 h-3.5" />
            </button>
          </Show>
        </span>
      </div>
      <Show when={!collapsed()}>
        <For each={props.node.dirs}>
          {(childDir) => (
            <TreeDirBranch
              scope={props.scope}
              node={childDir}
              section={props.section}
              depth={props.depth + 1}
              collapsedDirs={props.collapsedDirs}
              disabled={props.disabled}
              onToggleDir={props.onToggleDir}
              onOpenDiff={props.onOpenDiff}
              onStageEntries={props.onStageEntries}
              onUnstageEntries={props.onUnstageEntries}
              onDiscardEntry={props.onDiscardEntry}
              onStashEntry={props.onStashEntry}
            />
          )}
        </For>
        <For each={props.node.files}>
          {(entry) => (
            <ChangeRow
              scope={props.scope}
              entry={entry}
              section={props.section}
              disabled={props.disabled}
              depth={props.depth + 1}
              showFolder={false}
              onOpenDiff={props.onOpenDiff}
              onStage={(item) => props.onStageEntries([item])}
              onUnstage={(item) => props.onUnstageEntries([item])}
              onDiscard={props.onDiscardEntry}
              onStash={props.onStashEntry}
            />
          )}
        </For>
      </Show>
    </>
  )
}

interface ChangeSectionContentProps {
  scope: ProjectScope
  section: 'staged' | 'unstaged'
  entries: GitFileStatus[]
  viewMode: GitViewMode
  collapsedDirs: Readonly<Record<string, boolean>>
  disabled: boolean
  onToggleDir: (key: string) => void
  onOpenDiff: (entry: GitFileStatus, section: GitDiffSection) => void
  onStageEntries: (entries: GitFileStatus[]) => void
  onUnstageEntries: (entries: GitFileStatus[]) => void
  onDiscardEntry: (entry: GitFileStatus) => void
  onStashEntry?: (entry: GitFileStatus) => void
}

function ChangeSectionContent(props: ChangeSectionContentProps) {
  const treeRoot = createMemo(() =>
    props.viewMode === 'tree' ? buildGitTree(props.entries) : null,
  )

  return (
    <Show
      when={treeRoot()}
      fallback={
        <For each={props.entries}>
          {(entry) => (
            <ChangeRow
              scope={props.scope}
              entry={entry}
              section={props.section}
              disabled={props.disabled}
              onOpenDiff={props.onOpenDiff}
              onStage={(item) => props.onStageEntries([item])}
              onUnstage={(item) => props.onUnstageEntries([item])}
              onDiscard={props.onDiscardEntry}
              onStash={props.onStashEntry}
            />
          )}
        </For>
      }
    >
      {(root) => (
        <>
          <For each={root().dirs}>
            {(dirNode) => (
              <TreeDirBranch
                scope={props.scope}
                node={dirNode}
                section={props.section}
                depth={0}
                collapsedDirs={props.collapsedDirs}
                disabled={props.disabled}
                onToggleDir={props.onToggleDir}
                onOpenDiff={props.onOpenDiff}
                onStageEntries={props.onStageEntries}
                onUnstageEntries={props.onUnstageEntries}
                onDiscardEntry={props.onDiscardEntry}
                onStashEntry={props.onStashEntry}
              />
            )}
          </For>
          <For each={root().files}>
            {(entry) => (
              <ChangeRow
                scope={props.scope}
                entry={entry}
                section={props.section}
                disabled={props.disabled}
                depth={0}
                showFolder={false}
                onOpenDiff={props.onOpenDiff}
                onStage={(item) => props.onStageEntries([item])}
                onUnstage={(item) => props.onUnstageEntries([item])}
                onDiscard={props.onDiscardEntry}
                onStash={props.onStashEntry}
              />
            )}
          </For>
        </>
      )}
    </Show>
  )
}

interface SectionHeaderProps {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  actionKind?: 'stage' | 'unstage'
  actionLabel?: string
  actionDisabled?: boolean
  onAction?: () => void
  /** Optional secondary icon button rendered to the left of the primary action. */
  secondaryActionLabel?: string
  secondaryActionDisabled?: boolean
  onSecondaryAction?: () => void
  secondaryActionTestId?: string
  class?: string
}

function SectionHeader(props: SectionHeaderProps) {
  return (
    <div class={`px-2.5 pb-0.5 flex items-center justify-between gap-1 ${props.class ?? 'pt-1'}`}>
      <button
        type="button"
        aria-expanded={!props.collapsed}
        class="flex-1 min-w-0 flex items-center gap-1 text-left text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors leading-normal"
        onClick={() => props.onToggle()}
      >
        <ChevronRight
          class={`w-3 h-3 shrink-0 transition-transform duration-150 ${props.collapsed ? '' : 'rotate-90'}`}
        />
        <span class="truncate leading-normal">
          {props.title} ({props.count})
        </span>
      </button>
      <Show when={props.secondaryActionLabel && props.onSecondaryAction}>
        <button
          type="button"
          data-testid={props.secondaryActionTestId}
          aria-label={props.secondaryActionLabel}
          title={props.secondaryActionLabel}
          disabled={props.secondaryActionDisabled}
          class="shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all"
          onClick={() => props.onSecondaryAction?.()}
        >
          <Undo2 class="w-3.5 h-3.5" />
        </button>
      </Show>
      <Show when={props.actionKind && props.actionLabel && props.onAction}>
        <button
          type="button"
          aria-label={props.actionLabel}
          title={props.actionLabel}
          disabled={props.actionDisabled}
          class="shrink-0 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40 disabled:pointer-events-none transition-all"
          onClick={() => props.onAction?.()}
        >
          <Show
            when={props.actionKind === 'stage'}
            fallback={<Minus class="w-3.5 h-3.5" />}
          >
            <Plus class="w-3.5 h-3.5" />
          </Show>
        </button>
      </Show>
    </div>
  )
}

interface StashSectionProps {
  scope: ProjectScope
  stashes: GitStashEntry[]
  disabled: boolean
  onRestore: (entry: GitStashEntry) => void
  onDrop: (entry: GitStashEntry) => void
}

/** The project's stash stack with per-entry restore (pop) and drop actions. */
function StashSection(props: StashSectionProps) {
  const i18n = getI18n(props.scope)
  const [collapsed, setCollapsed] = createSignal(false)

  return (
    <div class="mt-2">
      <SectionHeader
        title={i18n.t('git.stash.section')}
        count={props.stashes.length}
        collapsed={collapsed()}
        onToggle={() => setCollapsed((prev) => !prev)}
        class="pt-1"
      />
      <Show when={!collapsed()}>
        <Show
          when={props.stashes.length > 0}
          fallback={
            <div class="mx-1.5 px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">
              {i18n.t('git.stash.empty')}
            </div>
          }
        >
          <For each={props.stashes}>
            {(stash) => (
              <div
                data-git-stash={stash.refName}
                title={stash.message}
                class="group/row mx-1.5 rounded-lg flex items-center gap-1.5 pr-1.5 pl-2 h-[26px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-100"
              >
                <Archive class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span class="truncate flex-1 leading-normal min-w-0">{stash.message}</span>
                <span class="shrink-0 text-[10px] text-[var(--text-muted)] leading-normal">
                  {stash.date}
                </span>
                <span class="shrink-0 hidden group-hover/row:flex group-focus-within/row:flex items-center gap-0.5">
                  <button
                    type="button"
                    data-testid={`git-stash-restore-${stash.index}`}
                    aria-label={i18n.t('git.stash.restorePath', { ref: stash.refName })}
                    title={i18n.t('git.stash.restore')}
                    disabled={props.disabled}
                    class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    onClick={() => props.onRestore(stash)}
                  >
                    <RotateCcw class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    data-testid={`git-stash-drop-${stash.index}`}
                    aria-label={i18n.t('git.stash.dropPath', { ref: stash.refName })}
                    title={i18n.t('git.stash.drop')}
                    disabled={props.disabled}
                    class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--danger-text)] hover:bg-[var(--danger-bg)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    onClick={() => props.onDrop(stash)}
                  >
                    <Trash class="w-3.5 h-3.5" />
                  </button>
                </span>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

export const GitView: Component<{ scope: ProjectScope }> = (props) => {
  const store = props.scope.get(GitStoreKey)
  const dialogs = props.scope.tryGet(ConfirmDialogKey)
  const selection = props.scope.get(ProjectSelectionKey)
  const i18n = getI18n(props.scope)

  const [sectionCollapsed, setSectionCollapsed] = createSignal<Record<string, boolean>>({})
  const [dirCollapsed, setDirCollapsed] = createSignal<Record<string, boolean>>({})
  const [viewMode, setViewMode] = createSignal<GitViewMode>(readStoredViewMode())
  const [panelMode, setPanelMode] = createSignal<GitPanelMode>(readStoredPanelMode())
  const [manualSpinning, setManualSpinning] = createSignal(false)
  const [branchMenuOpen, setBranchMenuOpen] = createSignal(false)
  const [branchQuery, setBranchQuery] = createSignal('')
  const [branchActiveIdx, setBranchActiveIdx] = createSignal(0)
  const [moreMenuOpen, setMoreMenuOpen] = createSignal(false)
  let spinTimer: ReturnType<typeof setTimeout> | null = null
  let branchBtnRef: HTMLButtonElement | undefined
  let branchPopoverRef: HTMLDivElement | undefined
  let branchListRef: HTMLDivElement | undefined
  let branchInputRef: HTMLInputElement | undefined
  let moreMenuBtnRef: HTMLButtonElement | undefined
  let moreMenuPopoverRef: HTMLDivElement | undefined

  const BRANCH_LISTBOX_ID = 'git-branch-listbox'
  const branchOptionId = (index: number) => `git-branch-option-${index}`

  // Kick off the initial status load if the plugin lifecycle has not started it yet.
  onMount(() => {
    void store.ensureLoaded()
  })

  onCleanup(() => {
    if (spinTimer) {
      clearTimeout(spinTimer)
      spinTimer = null
    }
  })

  createEffect(() => {
    if (!branchMenuOpen()) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (
        target &&
        (branchPopoverRef?.contains(target) || branchBtnRef?.contains(target))
      ) {
        return
      }
      setBranchMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    onCleanup(() => document.removeEventListener('pointerdown', onPointerDown))
  })

  createEffect(() => {
    if (!moreMenuOpen()) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (
        target &&
        (moreMenuPopoverRef?.contains(target) || moreMenuBtnRef?.contains(target))
      ) {
        return
      }
      setMoreMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    onCleanup(() => document.removeEventListener('pointerdown', onPointerDown))
  })

  type BranchPickerItem =
    | { kind: 'branch'; branch: GitBranchInfo }
    | { kind: 'create'; name: string }

  const branchPickerItems = createMemo<BranchPickerItem[]>(() => {
    const raw = branchQuery().trim()
    const q = raw.toLowerCase()
    const all = store.branches()
    const filtered = q
      ? all.filter((b) => b.name.toLowerCase().includes(q))
      : all
    const items: BranchPickerItem[] = filtered.map((branch) => ({
      kind: 'branch',
      branch,
    }))
    if (
      raw.length > 0 &&
      !raw.startsWith('-') &&
      !/\s/.test(raw) &&
      !all.some((b) => b.name === raw)
    ) {
      items.push({ kind: 'create', name: raw })
    }
    return items
  })

  createEffect(() => {
    branchPickerItems()
    setBranchActiveIdx(0)
  })

  // Fetch the stash stack when the repository becomes available (panel opened
  // or project switched); stash writes refresh it themselves afterwards. Guard
  // with a flag so status-only refreshes don't re-run `git stash list`.
  let stashesLoadedForRepo = false
  createEffect(() => {
    if (!repo()) {
      if (branchMenuOpen()) {
        setBranchMenuOpen(false)
      }
      if (moreMenuOpen()) {
        setMoreMenuOpen(false)
      }
      stashesLoadedForRepo = false
      return
    }
    if (!stashesLoadedForRepo) {
      stashesLoadedForRepo = true
      void store.loadStashes()
    }
  })

  createEffect(() => {
    const idx = branchActiveIdx()
    if (!branchMenuOpen() || !branchListRef) return
    branchListRef.querySelectorAll('[role="option"]')[idx]?.scrollIntoView({ block: 'nearest' })
  })

  function openBranchMenu() {
    setBranchQuery('')
    setBranchActiveIdx(0)
    setBranchMenuOpen(true)
    void store.loadBranches()
    requestAnimationFrame(() => branchInputRef?.focus())
  }

  function toggleBranchMenu() {
    if (branchMenuOpen()) {
      setBranchMenuOpen(false)
    } else {
      openBranchMenu()
    }
  }

  async function selectBranchItem(item: BranchPickerItem) {
    setBranchMenuOpen(false)
    if (item.kind === 'create') {
      await store.checkoutBranch(item.name, true)
    } else if (!item.branch.current) {
      await store.checkoutBranch(item.branch.name, false)
    }
  }

  function onBranchPickerKeyDown(e: KeyboardEvent) {
    const items = branchPickerItems()
    if (e.key === 'Escape') {
      e.preventDefault()
      setBranchMenuOpen(false)
      branchBtnRef?.focus()
      return
    }
    if (items.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setBranchActiveIdx((idx) => (idx + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setBranchActiveIdx((idx) => (idx - 1 + items.length) % items.length)
    } else if (e.key === 'Enter') {
      if (e.isComposing) return
      e.preventDefault()
      const target = items[branchActiveIdx()]
      if (target) {
        void selectBranchItem(target)
      }
    }
  }

  function handleManualRefresh() {
    // Keep the icon spinning briefly so fast local/mock refreshes still show feedback.
    setManualSpinning(true)
    if (spinTimer) clearTimeout(spinTimer)
    spinTimer = setTimeout(() => {
      spinTimer = null
      setManualSpinning(false)
    }, 500)
    void store.refresh()
  }

  const repo = () => store.status()?.repo ?? false
  const branchLabel = () => {
    const branch = store.status()?.branch
    return branch ? branch : i18n.t('git.detachedHead')
  }

  const stagedEntries = createMemo(() =>
    (store.status()?.entries ?? []).filter(hasStagedChanges),
  )
  const unstagedEntries = createMemo(() =>
    (store.status()?.entries ?? []).filter(hasUnstagedChanges),
  )
  const stageableEntries = createMemo(() =>
    unstagedEntries().filter(isStageableEntry),
  )
  /** Paths discard-all reverts: every unstaged entry except merge conflicts. */
  const discardablePaths = createMemo(() => ({
    untracked: unstagedEntries().filter(isUntrackedEntry).map((e) => e.relPath),
    tracked: unstagedEntries()
      .filter((e) => !isUntrackedEntry(e) && !isUnmergedEntry(e))
      .map((e) => e.relPath),
  }))
  const discardableCount = createMemo(() => {
    const { untracked, tracked } = discardablePaths()
    return untracked.length + tracked.length
  })
  /** Entries stash-all can sweep; unmerged conflicts block a real `git stash`. */
  const stashableCount = createMemo(
    () =>
      (store.status()?.entries ?? []).filter(
        (e) => hasStagedChanges(e) || (hasUnstagedChanges(e) && !isUnmergedEntry(e)),
      ).length,
  )

  function toggleSection(id: string) {
    setSectionCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function toggleDir(key: string) {
    setDirCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function toggleViewMode() {
    const next: GitViewMode = viewMode() === 'list' ? 'tree' : 'list'
    setViewMode(next)
    writeStoredViewMode(next)
  }

  function togglePanelMode() {
    const next: GitPanelMode = panelMode() === 'changes' ? 'history' : 'changes'
    setPanelMode(next)
    writeStoredPanelMode(next)
  }

  /**
   * Opens the diff preview for a change row: the focused section tells the
   * `git-diff` previewer which comparison to render (staged rows compare
   * HEAD↔index, unstaged rows index↔worktree). `allowMissing` lets
   * worktree-deleted rows (D) through stat: their diff comes from git, not
   * the file on disk.
   */
  function openDiff(entry: GitFileStatus, section: GitDiffSection) {
    store.setDiffFocus({ relPath: entry.relPath, section })
    void selection.selectFile(entry.relPath, {
      preferredPreviewerId: GIT_DIFF_PREVIEWER_ID,
      allowMissing: true,
    })
  }

  function stageEntries(entries: GitFileStatus[]) {
    void store.stage(entries.map((entry) => entry.relPath))
  }

  function unstageEntries(entries: GitFileStatus[]) {
    const paths = [...new Set(entries.flatMap(unstagePathsForEntry))]
    void store.unstage(paths)
  }

  async function discardEntry(entry: GitFileStatus) {
    // Fail closed: without the dialog service there is no way to confirm a
    // destructive action, so do nothing rather than discarding silently.
    if (!dialogs) return
    const untracked = isUntrackedEntry(entry)
    const choice = await dialogs.confirm({
      title: i18n.t('git.discard.title'),
      message: untracked
        ? i18n.t('git.discard.untrackedMessage', { path: entry.relPath })
        : i18n.t('git.discard.trackedMessage', { path: entry.relPath }),
      details: [entry.relPath],
      actions: [
        { id: 'discard', label: i18n.t('git.discard.confirm'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('git.discard.cancel'), variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (choice !== 'discard') return
    void store.discard(untracked ? [entry.relPath] : [], untracked ? [] : [entry.relPath])
  }

  /**
   * Discards every unstaged change at once (worktree back to the index):
   * tracked entries are restored, untracked entries are deleted. Unmerged
   * conflicts are skipped — per-row discard excludes them for the same
   * reason (`checkout -- <unmerged>` fails).
   */
  async function discardAllChanges() {
    if (!dialogs) return
    setMoreMenuOpen(false)
    const { untracked, tracked } = discardablePaths()
    if (untracked.length === 0 && tracked.length === 0) return
    const total = untracked.length + tracked.length
    const choice = await dialogs.confirm({
      title: i18n.t('git.discardAll.title'),
      message: i18n.t('git.discardAll.message', { count: total }),
      details: [...untracked, ...tracked].slice(0, 8),
      actions: [
        { id: 'discard', label: i18n.t('git.discardAll.confirm'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('git.discard.cancel'), variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (choice !== 'discard') return
    void store.discard(untracked, tracked)
  }

  /** Stashes a single entry's changes (rename source included). */
  function stashEntry(entry: GitFileStatus) {
    const paths = entry.origPath ? [entry.relPath, entry.origPath] : [entry.relPath]
    void store.stashPaths(paths)
  }

  async function restoreStash(entry: GitStashEntry) {
    await store.stashRestore(entry.index)
  }

  async function dropStash(entry: GitStashEntry) {
    // Fail closed: dropping a stash entry is irreversible.
    if (!dialogs) return
    const choice = await dialogs.confirm({
      title: i18n.t('git.stash.dropTitle'),
      message: i18n.t('git.stash.dropMessage', { ref: entry.refName }),
      details: [entry.message],
      actions: [
        { id: 'drop', label: i18n.t('git.stash.dropConfirm'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('git.discard.cancel'), variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (choice !== 'drop') return
    void store.stashDrop(entry.index)
  }

  async function commitFromBox() {
    await store.commit()
  }

  function onCommitBoxKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void commitFromBox()
    }
  }

  const ai = props.scope.tryGet(AiModelKey)
  const gitBackend = props.scope.get(GitBackendKey)
  const [aiGenerating, setAiGenerating] = createSignal(false)

  /**
   * Generates a commit message from the staged changes (unstaged as
   * fallback). Key code files carry their full diff into the prompt; the
   * rest are listed by path only. Failures surface in the store error banner.
   */
  async function generateCommitMessage() {
    if (!ai || aiGenerating()) return
    if (!ai.isConfigured()) {
      store.setError(i18n.t('git.ai.notConfigured'))
      return
    }
    const staged = stagedEntries()
    const useStaged = staged.length > 0
    const entries = useStaged ? staged : stageableEntries()
    if (entries.length === 0) {
      store.setError(i18n.t('git.ai.noChanges'))
      return
    }
    store.setError(null)
    setAiGenerating(true)
    try {
      const diffs = await gitBackend.diff(props.scope.id, {
        staged: useStaged,
        relPaths: entries.map((entry) => entry.relPath),
      })
      const prompt = buildCommitMessagePrompt(
        { entries, diffs },
        { customPrompt: ai.commitPrompt() },
      )
      const content = await ai.chat(prompt)
      const message = stripCodeFence(content)
      if (!message.trim()) {
        store.setError(i18n.t('git.ai.emptyResponse'))
        return
      }
      store.setCommitMessage(message)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      store.setError(`${i18n.t('git.ai.failed')}${detail}`)
    } finally {
      setAiGenerating(false)
    }
  }

  return (
    <div class="flex-1 min-h-0 flex flex-col select-none">
      {/* Branch header */}
      <div class="shrink-0 border-b border-[var(--border-subtle)] relative">
        <div class="px-2.5 pt-2.5 pb-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <Show
              when={repo()}
              fallback={
                <>
                  <GitBranch class="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
                  <span class="text-[11.5px] text-[var(--text-muted)] truncate leading-normal">
                    {i18n.t('git.sourceControl')}
                  </span>
                </>
              }
            >
              <button
                ref={branchBtnRef}
                type="button"
                data-testid="git-branch-switcher"
                aria-haspopup="listbox"
                aria-expanded={branchMenuOpen()}
                title={i18n.t('git.switchBranch')}
                disabled={store.committing() || store.mutating()}
                class="flex items-center gap-1.5 min-w-0 px-1.5 py-1 -ml-1.5 rounded-lg hover:bg-[var(--bg-hover)] disabled:opacity-60 disabled:pointer-events-none transition-colors cursor-pointer"
                onClick={toggleBranchMenu}
              >
                <GitBranch class="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
                <span
                  class="text-[11.5px] font-medium text-[var(--text-primary)] truncate leading-normal"
                  data-testid="git-branch-name"
                >
                  {branchLabel()}
                </span>
                <Show when={(store.status()?.ahead ?? 0) > 0 || (store.status()?.behind ?? 0) > 0}>
                  <span class="shrink-0 text-[10px] text-[var(--text-muted)] tabular-nums leading-normal">
                    <Show when={(store.status()?.ahead ?? 0) > 0}>
                      ↑{store.status()!.ahead}
                    </Show>
                    <Show when={(store.status()?.behind ?? 0) > 0}>
                      {' '}↓{store.status()!.behind}
                    </Show>
                  </span>
                </Show>
                <ChevronDown
                  class={`w-3 h-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${branchMenuOpen() ? 'rotate-180' : ''}`}
                />
              </button>
            </Show>
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              data-testid="git-view-mode-toggle"
              aria-label={viewMode() === 'list' ? i18n.t('git.viewAsTree') : i18n.t('git.viewAsList')}
              title={viewMode() === 'list' ? i18n.t('git.viewAsTree') : i18n.t('git.viewAsList')}
              aria-pressed={viewMode() === 'tree'}
              disabled={panelMode() === 'history'}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150 active:scale-95"
              onClick={toggleViewMode}
            >
              <Show when={viewMode() === 'list'} fallback={<List class="w-3.5 h-3.5" />}>
                <ListTree class="w-3.5 h-3.5" />
              </Show>
            </button>
            <button
              type="button"
              data-testid="git-history-toggle"
              aria-label={i18n.t('git.history.toggle')}
              title={i18n.t('git.history.toggle')}
              aria-pressed={panelMode() === 'history'}
              disabled={!repo()}
              class={`p-1.5 rounded-lg transition-all duration-150 active:scale-95 disabled:opacity-40 disabled:pointer-events-none ${
                panelMode() === 'history'
                  ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
              onClick={togglePanelMode}
            >
              <GitCommitHorizontal class="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              aria-label={i18n.t('git.refreshStatus')}
              title={i18n.t('git.refreshStatus')}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 active:scale-95"
              onClick={handleManualRefresh}
            >
              <RefreshCw
                class={`w-3.5 h-3.5 ${store.refreshing() || manualSpinning() ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              data-testid="git-push-button"
              aria-label={i18n.t('git.push')}
              title={i18n.t('git.push')}
              disabled={
                !repo() ||
                !store.status()?.branch ||
                store.pushing() ||
                store.committing() ||
                store.mutating()
              }
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150 active:scale-95"
              onClick={() => void store.push()}
            >
              <Show
                when={!store.pushing()}
                fallback={<Loader2 class="w-3.5 h-3.5 animate-spin" />}
              >
                <Upload class="w-3.5 h-3.5" />
              </Show>
            </button>
            <button
              type="button"
              data-testid="git-more-button"
              aria-label={i18n.t('git.menu.more')}
              title={i18n.t('git.menu.more')}
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen()}
              disabled={!repo()}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150 active:scale-95"
              onClick={() => setMoreMenuOpen((open) => !open)}
            >
              <EllipsisVertical class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* More-actions popover: bulk stash / discard */}
        <Show when={repo() && moreMenuOpen()}>
          <div
            ref={moreMenuPopoverRef}
            data-testid="git-more-popover"
            role="menu"
            aria-label={i18n.t('git.menu.more')}
            class="absolute right-2 top-[calc(100%-2px)] z-30 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-[var(--shadow-popover)] p-1 flex flex-col min-w-[180px]"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setMoreMenuOpen(false)
                moreMenuBtnRef?.focus()
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              data-testid="git-stash-all"
              title={i18n.t('git.stash.allTitle')}
              disabled={
                stashableCount() === 0 || store.committing() || store.mutating()
              }
              class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={() => {
                setMoreMenuOpen(false)
                void store.stashAll()
              }}
            >
              <Archive class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <span class="truncate leading-normal min-w-0">
                {i18n.t('git.stash.all')}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="git-discard-all"
              disabled={discardableCount() === 0 || store.committing() || store.mutating()}
              class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={() => void discardAllChanges()}
            >
              <Undo2 class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <span class="truncate leading-normal min-w-0">
                {i18n.t('git.discardAll.title')}
              </span>
            </button>
          </div>
        </Show>

        {/* Branch switcher popover */}
        <Show when={repo() && branchMenuOpen()}>
          <div
            ref={branchPopoverRef}
            data-testid="git-branch-popover"
            class="absolute left-2 right-2 top-[calc(100%-2px)] z-30 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-[var(--shadow-popover)] p-1.5 flex flex-col gap-1"
            onKeyDown={onBranchPickerKeyDown}
          >
            <input
              ref={branchInputRef}
              type="text"
              role="combobox"
              aria-label={i18n.t('git.branchPicker.filterAriaLabel')}
              aria-expanded={branchMenuOpen()}
              aria-controls={BRANCH_LISTBOX_ID}
              aria-activedescendant={
                branchPickerItems().length > 0 ? branchOptionId(branchActiveIdx()) : undefined
              }
              placeholder={i18n.t('git.branchPicker.placeholder')}
              value={branchQuery()}
              onInput={(e) => setBranchQuery(e.currentTarget.value)}
              class="w-full h-[28px] px-2.5 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] outline-none text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] leading-normal"
            />
            <div
              ref={branchListRef}
              id={BRANCH_LISTBOX_ID}
              role="listbox"
              aria-label={i18n.t('git.branchPicker.listAriaLabel')}
              class="max-h-[220px] overflow-y-auto overflow-x-hidden flex flex-col gap-0.5"
            >
              <Show
                when={!store.branchesLoading() || store.branches().length > 0}
                fallback={
                  <div class="flex items-center justify-center gap-1.5 py-3 text-[11px] text-[var(--text-muted)]">
                    <Loader2 class="w-3 h-3 animate-spin text-[var(--accent)]" />
                    <span>{i18n.t('git.branchPicker.loading')}</span>
                  </div>
                }
              >
                <Show
                  when={branchPickerItems().length > 0}
                  fallback={
                    <div class="px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">
                      {i18n.t('git.branchPicker.empty')}
                    </div>
                  }
                >
                  <For each={branchPickerItems()}>
                    {(item, index) => {
                      const isActive = () => index() === branchActiveIdx()
                      return item.kind === 'create' ? (
                        <button
                          id={branchOptionId(index())}
                          type="button"
                          role="option"
                          aria-selected={isActive()}
                          data-git-create-branch={item.name}
                          class={`w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] transition-colors ${
                            isActive()
                              ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                          }`}
                          onFocus={() => setBranchActiveIdx(index())}
                          onMouseEnter={() => setBranchActiveIdx(index())}
                          onClick={() => void selectBranchItem(item)}
                        >
                          <Plus class="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
                          <span class="truncate flex-1 leading-normal min-w-0">
                            {i18n.t('git.branchPicker.create', { name: item.name })}
                          </span>
                        </button>
                      ) : (
                        <button
                          id={branchOptionId(index())}
                          type="button"
                          role="option"
                          aria-selected={isActive()}
                          data-git-branch={item.branch.name}
                          class={`w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] transition-colors ${
                            isActive()
                              ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                              : item.branch.current
                                ? 'text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                          } ${item.branch.current ? 'font-medium' : ''}`}
                          onFocus={() => setBranchActiveIdx(index())}
                          onMouseEnter={() => setBranchActiveIdx(index())}
                          onClick={() => void selectBranchItem(item)}
                        >
                          <Show
                            when={item.branch.remote}
                            fallback={
                              <GitBranch class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                            }
                          >
                            <Globe class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                          </Show>
                          <span class="truncate flex-1 leading-normal min-w-0">
                            {item.branch.name}
                          </span>
                          <Show when={item.branch.remote}>
                            <span class="shrink-0 text-[9.5px] uppercase tracking-wider text-[var(--text-muted)]">
                              {i18n.t('git.branchPicker.remote')}
                            </span>
                          </Show>
                          <Show when={item.branch.current}>
                            <Check class="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      {/* Error banner */}
      <Show when={store.error()}>
        {(msg) => (
          <div class="mx-2 mt-2 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--danger-text)] bg-[var(--danger-bg)] border border-[var(--danger-border)] break-words">
            {msg()}
          </div>
        )}
      </Show>

      <Show
        when={repo()}
        fallback={
          <Show
            when={store.loading()}
            fallback={
              <Show
                when={store.status()}
                fallback={
                  // Status never arrived (e.g. git missing from PATH); the
                  // error banner above already explains why.
                  <div class="flex-1 px-3 py-8 text-center text-xs text-[var(--text-muted)]">
                    {i18n.t('git.state.unavailable')}
                  </div>
                }
              >
                <div class="flex-1 px-3 py-8 text-center text-xs text-[var(--text-muted)]">
                  {i18n.t('git.state.notRepo')}
                </div>
              </Show>
            }
          >
            <div class="flex items-center justify-center gap-2 py-8 text-xs text-[var(--text-muted)]">
              <Loader2 class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
              <span>{i18n.t('git.state.loading')}</span>
            </div>
          </Show>
        }
      >
        <Show
          when={panelMode() === 'changes'}
          fallback={<GitHistory scope={props.scope} />}
        >
          {/* Commit box */}
          <div class="shrink-0 px-2.5 pt-2.5 pb-2 border-b border-[var(--border-subtle)]">
            <textarea
              aria-label={i18n.t('git.commit.ariaLabel')}
              value={store.commitMessage()}
              onInput={(e) => store.setCommitMessage(e.currentTarget.value)}
              onKeyDown={onCommitBoxKeyDown}
              placeholder={i18n.t('git.commit.placeholder')}
              rows={2}
              class="w-full resize-none rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] focus:shadow-[0_0_0_2px_var(--accent-soft)] outline-none px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] leading-normal transition-all"
            />
            <div class="mt-1.5 flex items-center gap-1.5">
              <Show when={ai}>
                <button
                  type="button"
                  data-testid="git-ai-generate"
                  aria-label={i18n.t('git.ai.generateTitle')}
                  title={i18n.t('git.ai.generateTitle')}
                  disabled={aiGenerating() || store.committing() || store.mutating()}
                  class="shrink-0 h-[28px] px-2.5 rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] flex items-center justify-center gap-1.5 text-[11.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                  onClick={() => void generateCommitMessage()}
                >
                  <Show
                    when={!aiGenerating()}
                    fallback={<Loader2 class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />}
                  >
                    <Sparkles class="w-3.5 h-3.5 text-[var(--accent)]" />
                  </Show>
                  <span>{i18n.t('git.ai.generate')}</span>
                </button>
              </Show>
              <button
                type="button"
                data-testid="git-commit-button"
                class="flex-1 h-[28px] rounded-lg flex items-center justify-center gap-1.5 text-[11.5px] font-medium transition-all duration-150 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] disabled:hover:bg-[var(--accent)]"
                disabled={
                  stagedEntries().length === 0 ||
                  store.commitMessage().trim().length === 0 ||
                  store.committing() ||
                  store.mutating()
                }
                onClick={() => void commitFromBox()}
              >
                <Show
                  when={!store.committing()}
                  fallback={<Loader2 class="w-3.5 h-3.5 animate-spin" />}
                >
                  <Check class="w-3.5 h-3.5" />
                </Show>
                <span>{i18n.t('git.commit.button', { count: stagedEntries().length })}</span>
              </button>
            </div>
          </div>

          {/* Change sections */}
          <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-1.5">
            <Show
              when={stagedEntries().length > 0 || unstagedEntries().length > 0}
              fallback={
                <div class="px-3 py-8 text-center text-xs text-[var(--text-muted)]">
                  {i18n.t('git.state.clean')}
                </div>
              }
            >
              <Show when={stagedEntries().length > 0}>
                <SectionHeader
                  title={i18n.t('git.section.staged')}
                  count={stagedEntries().length}
                  collapsed={Boolean(sectionCollapsed().staged)}
                  onToggle={() => toggleSection('staged')}
                  actionKind="unstage"
                  actionLabel={i18n.t('git.section.unstageAll')}
                  actionDisabled={store.committing() || store.mutating()}
                  onAction={() => void store.unstageAll()}
                />
                <Show when={!sectionCollapsed().staged}>
                  <ChangeSectionContent
                    scope={props.scope}
                    section="staged"
                    entries={stagedEntries()}
                    viewMode={viewMode()}
                    collapsedDirs={dirCollapsed()}
                    disabled={store.committing() || store.mutating()}
                    onToggleDir={toggleDir}
                    onOpenDiff={openDiff}
                    onStageEntries={stageEntries}
                    onUnstageEntries={unstageEntries}
                    onDiscardEntry={discardEntry}
                  />
                </Show>
              </Show>

              <Show when={unstagedEntries().length > 0}>
                <SectionHeader
                  title={i18n.t('git.section.unstaged')}
                  count={unstagedEntries().length}
                  collapsed={Boolean(sectionCollapsed().unstaged)}
                  onToggle={() => toggleSection('unstaged')}
                  actionKind={stageableEntries().length > 0 ? 'stage' : undefined}
                  actionLabel={i18n.t('git.section.stageAll')}
                  actionDisabled={store.committing() || store.mutating()}
                  onAction={() => void store.stageAll()}
                  secondaryActionLabel={
                    discardableCount() > 0 ? i18n.t('git.discardAll.title') : undefined
                  }
                  secondaryActionDisabled={store.committing() || store.mutating()}
                  onSecondaryAction={() => void discardAllChanges()}
                  secondaryActionTestId="git-discard-all-header"
                  class={stagedEntries().length > 0 ? 'pt-2' : 'pt-1'}
                />
                <Show when={!sectionCollapsed().unstaged}>
                  <ChangeSectionContent
                    scope={props.scope}
                    section="unstaged"
                    entries={unstagedEntries()}
                    viewMode={viewMode()}
                    collapsedDirs={dirCollapsed()}
                    disabled={store.committing() || store.mutating()}
                    onToggleDir={toggleDir}
                    onOpenDiff={openDiff}
                    onStageEntries={stageEntries}
                    onUnstageEntries={unstageEntries}
                    onDiscardEntry={discardEntry}
                    onStashEntry={stashEntry}
                  />
                </Show>
              </Show>
            </Show>

            {/* Stash stack stays visible even when the working tree is clean. */}
            <StashSection
              scope={props.scope}
              stashes={store.stashes()}
              disabled={store.committing() || store.mutating()}
              onRestore={(entry) => void restoreStash(entry)}
              onDrop={(entry) => void dropStash(entry)}
            />
          </div>
        </Show>
      </Show>
    </div>
  )
}
