import type { ProjectScope } from '@lite-ide/kernel'
import { formatErrorMessage, type GitFileStatus, type GitStashEntry } from '@lite-ide/protocol'
import {
  AiModelKey,
  ConfirmDialogKey,
  FileIcon,
  getI18n,
  ProjectSelectionKey,
} from '@lite-ide/workbench'
import Archive from 'lucide-solid/icons/archive'
import Check from 'lucide-solid/icons/check'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import Download from 'lucide-solid/icons/download'
import GitBranch from 'lucide-solid/icons/git-branch'
import GitCommitHorizontal from 'lucide-solid/icons/git-commit-horizontal'
import Globe from 'lucide-solid/icons/globe'
import List from 'lucide-solid/icons/list'
import ListTree from 'lucide-solid/icons/list-tree'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Minus from 'lucide-solid/icons/minus'
import Plus from 'lucide-solid/icons/plus'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
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

/** Selection key for a change row: `<section>:<relPath>`. */
function rowKey(section: GitDiffSection, relPath: string): string {
  return `${section}:${relPath}`
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
  selected?: boolean
  onOpenDiff: (entry: GitFileStatus, section: GitDiffSection) => void
  onStage: (entry: GitFileStatus) => void
  onUnstage: (entry: GitFileStatus) => void
  onDiscard: (entry: GitFileStatus) => void
  onRowClick?: (entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) => void
  onRowContextMenu?: (entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) => void
}

function ChangeRow(props: ChangeRowProps) {
  const i18n = getI18n(props.scope)
  const letter = () => statusLetter(props.entry, props.section)
  const unmerged = () => isUnmergedEntry(props.entry)
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
      data-git-selected={props.selected ? 'true' : undefined}
      title={titleText()}
      class={`group/row mx-1.5 rounded-lg flex items-center gap-1.5 pr-1.5 pl-2 h-[26px] text-xs transition-colors duration-100 cursor-pointer ${
        props.selected
          ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
      style={
        props.depth ? { 'padding-left': `${8 + props.depth * 14}px` } : undefined
      }
      onClick={(e) => {
        if (props.onRowClick) props.onRowClick(props.entry, props.section, e)
        else props.onOpenDiff(props.entry, props.section)
      }}
      onContextMenu={(e) => props.onRowContextMenu?.(props.entry, props.section, e)}
    >
      <FileIcon name={name()} isDir={false} />
      <span class="truncate flex-1 leading-normal min-w-0">{name()}</span>
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
  /** Unstaged only: discards every discardable change inside the folder. */
  onDiscardEntries?: (dirPath: string, entries: GitFileStatus[]) => void
  selectedKeys: ReadonlySet<string>
  onRowClick: (entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) => void
  onRowContextMenu: (entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) => void
}

function TreeDirBranch(props: TreeDirBranchProps) {
  const i18n = getI18n(props.scope)
  const dirKey = () => `${props.section}:${props.node.relPath}`
  const collapsed = () => Boolean(props.collapsedDirs[dirKey()])
  const stageable = createMemo(() => props.node.allEntries.filter(isStageableEntry))
  /** Folder discard sweeps everything except unmerged conflicts. */
  const discardable = createMemo(() =>
    props.node.allEntries.filter((entry) => !isUnmergedEntry(entry)),
  )

  return (
    <>
      <div
        data-git-dir={props.node.relPath}
        data-git-section={props.section}
        title={props.node.relPath}
        class="group/row mx-1.5 rounded-lg flex items-center gap-1 pr-1.5 h-[26px] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-100"
        style={{ 'padding-left': `${8 + props.depth * 14}px` }}
        onContextMenu={(e) => e.preventDefault()}
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
          <Show
            when={
              props.section === 'unstaged' &&
              props.onDiscardEntries &&
              discardable().length > 0
            }
          >
            <button
              type="button"
              aria-label={i18n.t('git.action.discardFolderPath', { path: props.node.relPath })}
              title={i18n.t('git.action.discardFolder')}
              disabled={props.disabled}
              class="p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-active)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={() => props.onDiscardEntries?.(props.node.relPath, discardable())}
            >
              <Undo2 class="w-3.5 h-3.5" />
            </button>
          </Show>
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
              onDiscardEntries={props.onDiscardEntries}
              selectedKeys={props.selectedKeys}
              onRowClick={props.onRowClick}
              onRowContextMenu={props.onRowContextMenu}
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
              selected={props.selectedKeys.has(rowKey(props.section, entry.relPath))}
              onOpenDiff={props.onOpenDiff}
              onStage={(item) => props.onStageEntries([item])}
              onUnstage={(item) => props.onUnstageEntries([item])}
              onDiscard={props.onDiscardEntry}
              onRowClick={props.onRowClick}
              onRowContextMenu={props.onRowContextMenu}
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
  /** Unstaged only: discards every discardable change inside a tree folder. */
  onDiscardEntries?: (dirPath: string, entries: GitFileStatus[]) => void
  selectedKeys: ReadonlySet<string>
  onRowClick: (entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) => void
  onRowContextMenu: (entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) => void
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
              selected={props.selectedKeys.has(rowKey(props.section, entry.relPath))}
              onOpenDiff={props.onOpenDiff}
              onStage={(item) => props.onStageEntries([item])}
              onUnstage={(item) => props.onUnstageEntries([item])}
              onDiscard={props.onDiscardEntry}
              onRowClick={props.onRowClick}
              onRowContextMenu={props.onRowContextMenu}
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
                onDiscardEntries={props.onDiscardEntries}
                selectedKeys={props.selectedKeys}
                onRowClick={props.onRowClick}
                onRowContextMenu={props.onRowContextMenu}
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
                selected={props.selectedKeys.has(rowKey(props.section, entry.relPath))}
                onOpenDiff={props.onOpenDiff}
                onStage={(item) => props.onStageEntries([item])}
                onUnstage={(item) => props.onUnstageEntries([item])}
                onDiscard={props.onDiscardEntry}
                onRowClick={props.onRowClick}
                onRowContextMenu={props.onRowContextMenu}
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

/** The project's stash stack with per-entry restore (apply) and drop actions. */
function StashSection(props: StashSectionProps) {
  const i18n = getI18n(props.scope)
  const [collapsed, setCollapsed] = createSignal(false)

  return (
    <div class="mt-2" data-testid="git-stash-section">
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
  const [branchMenuOpen, setBranchMenuOpen] = createSignal(false)
  const [branchQuery, setBranchQuery] = createSignal('')
  const [branchActiveIdx, setBranchActiveIdx] = createSignal(0)
  // Multi-selection over change rows (Ctrl/Shift click); keys are `rowKey(section, relPath)`.
  const [selectedKeys, setSelectedKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [selectionAnchor, setSelectionAnchor] = createSignal<string | null>(null)
  // Right-click context menu position (viewport coordinates); null = closed.
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number } | null>(null)
  let branchBtnRef: HTMLButtonElement | undefined
  let branchPopoverRef: HTMLDivElement | undefined
  let branchListRef: HTMLDivElement | undefined
  let branchInputRef: HTMLInputElement | undefined
  let ctxMenuRef: HTMLDivElement | undefined

  const BRANCH_LISTBOX_ID = 'git-branch-listbox'
  const branchOptionId = (index: number) => `git-branch-option-${index}`

  // Kick off the initial status load if the plugin lifecycle has not started it yet.
  onMount(() => {
    void store.ensureLoaded()
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
  // Leave popover menus behind when the repository disappears (project switch).
  createEffect(() => {
    if (!repo()) {
      if (branchMenuOpen()) {
        setBranchMenuOpen(false)
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
   * Discards every unstaged change inside a tree-view folder (hover folder
   * action): tracked entries are restored, untracked entries are deleted.
   * Unmerged conflicts are skipped — per-row and discard-all exclude them
   * for the same reason (`checkout -- <unmerged>` fails).
   */
  async function discardDirEntries(dirPath: string, entries: GitFileStatus[]) {
    if (!dialogs) return
    const discardable = entries.filter((entry) => !isUnmergedEntry(entry))
    if (discardable.length === 0) return
    const untracked = discardable.filter(isUntrackedEntry).map((entry) => entry.relPath)
    const tracked = discardable
      .filter((entry) => !isUntrackedEntry(entry))
      .map((entry) => entry.relPath)
    const choice = await dialogs.confirm({
      title: i18n.t('git.discardFolder.title'),
      message: i18n.t('git.discardFolder.message', {
        path: dirPath,
        count: discardable.length,
      }),
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

  /**
   * Discards every unstaged change at once (worktree back to the index):
   * tracked entries are restored, untracked entries are deleted. Unmerged
   * conflicts are skipped — per-row discard excludes them for the same
   * reason (`checkout -- <unmerged>` fails).
   */
  async function discardAllChanges() {
    if (!dialogs) return
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

  // --- Multi-selection (Ctrl/Shift click) and the row context menu ---

  /** Prune selection keys whose entries disappeared after a status refresh. */
  createEffect(() => {
    const valid = new Set<string>()
    for (const entry of stagedEntries()) valid.add(rowKey('staged', entry.relPath))
    for (const entry of unstagedEntries()) valid.add(rowKey('unstaged', entry.relPath))
    setSelectedKeys((prev) => {
      let changed = false
      for (const key of prev) {
        if (!valid.has(key)) {
          changed = true
          break
        }
      }
      if (!changed) return prev
      const next = new Set<string>()
      for (const key of prev) if (valid.has(key)) next.add(key)
      return next
    })
  })

  const selectedStaged = createMemo(() =>
    stagedEntries().filter((entry) => selectedKeys().has(rowKey('staged', entry.relPath))),
  )
  const selectedUnstaged = createMemo(() =>
    unstagedEntries().filter((entry) => selectedKeys().has(rowKey('unstaged', entry.relPath))),
  )
  const selectedStageable = createMemo(() => selectedUnstaged().filter(isStageableEntry))
  /** Unmerged conflicts block `git stash push -- <path>` the same as stash-all. */
  const selectedStashable = createMemo(() =>
    selectedUnstaged().filter((entry) => !isUnmergedEntry(entry)),
  )

  function clearSelection() {
    setSelectedKeys(new Set<string>())
    setSelectionAnchor(null)
  }

  function handleRowClick(entry: GitFileStatus, section: GitDiffSection, e: MouseEvent) {
    const key = rowKey(section, entry.relPath)
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const list = section === 'staged' ? stagedEntries() : unstagedEntries()
      if (e.shiftKey) {
        // Range select within the same section, anchored at the last non-shift click.
        const keys = list.map((item) => rowKey(section, item.relPath))
        const endIdx = Math.max(0, keys.indexOf(key))
        const anchor = selectionAnchor()
        const startIdx =
          anchor && anchor.startsWith(`${section}:`) ? keys.indexOf(anchor) : endIdx
        const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedKeys((prev) => new Set([...prev, ...keys.slice(from, to + 1)]))
      } else {
        setSelectedKeys((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        setSelectionAnchor(key)
      }
      return
    }
    // Plain click behaves as before: reset selection, open the diff.
    if (selectedKeys().size > 0) clearSelection()
    setSelectionAnchor(null)
    openDiff(entry, section)
  }

  function handleRowContextMenu(
    entry: GitFileStatus,
    section: GitDiffSection,
    e: MouseEvent,
  ) {
    e.preventDefault()
    const key = rowKey(section, entry.relPath)
    if (!selectedKeys().has(key)) {
      setSelectedKeys(new Set([key]))
      setSelectionAnchor(key)
    }
    // Keep the menu inside the viewport.
    const MENU_WIDTH = 210
    const MENU_HEIGHT = 110
    setCtxMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 4)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 4)),
    })
  }

  function closeCtxMenu() {
    setCtxMenu(null)
  }

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

  function stageSelectedFiles() {
    const entries = selectedStageable()
    if (entries.length > 0) void store.stage(entries.map((entry) => entry.relPath))
    closeCtxMenu()
    clearSelection()
  }

  function unstageSelectedFiles() {
    if (selectedStaged().length > 0) unstageEntries(selectedStaged())
    closeCtxMenu()
    clearSelection()
  }

  /** Stashes the selected unstaged entries (rename source paths included). */
  function stashSelectedFiles() {
    const paths = [
      ...new Set(
        selectedStashable().flatMap((entry) =>
          entry.origPath ? [entry.relPath, entry.origPath] : [entry.relPath],
        ),
      ),
    ]
    if (paths.length > 0) void store.stashPaths(paths)
    closeCtxMenu()
    clearSelection()
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
      store.setError(`${i18n.t('git.ai.failed')}${formatErrorMessage(err)}`)
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
              data-testid="git-pull-button"
              aria-label={i18n.t('git.pull')}
              title={i18n.t('git.pull')}
              disabled={
                !repo() ||
                !store.status()?.branch ||
                store.pulling() ||
                store.pushing() ||
                store.committing() ||
                store.mutating()
              }
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150 active:scale-95"
              onClick={() => void store.pull()}
            >
              <Show
                when={!store.pulling()}
                fallback={<Loader2 class="w-3.5 h-3.5 animate-spin" />}
              >
                <Download class="w-3.5 h-3.5" />
              </Show>
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
                store.pulling() ||
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
          </div>
        </div>

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
          <div
            class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-1.5"
            onClick={(e) => {
              // Clicking empty list space clears the multi-selection.
              if (!(e.target as HTMLElement).closest('[data-git-path]')) clearSelection()
            }}
          >
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
                    selectedKeys={selectedKeys()}
                    onRowClick={handleRowClick}
                    onRowContextMenu={handleRowContextMenu}
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
                    onDiscardEntries={discardDirEntries}
                    selectedKeys={selectedKeys()}
                    onRowClick={handleRowClick}
                    onRowContextMenu={handleRowContextMenu}
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

      {/* Row context menu: act on the current multi-selection. */}
      <Show when={ctxMenu()}>
        {(pos) => (
          <div
            ref={ctxMenuRef}
            role="menu"
            aria-label={i18n.t('git.selection.menu')}
            data-testid="git-context-menu"
            class="fixed z-50 min-w-[190px] rounded-xl bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-[var(--shadow-popover)] p-1 flex flex-col"
            style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Show when={selectedStageable().length > 0}>
              <button
                type="button"
                role="menuitem"
                data-testid="git-context-stage-selected"
                disabled={store.committing() || store.mutating()}
                class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                onClick={stageSelectedFiles}
              >
                <Plus class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span class="truncate leading-normal min-w-0">
                  {i18n.t('git.selection.stage', { count: selectedStageable().length })}
                </span>
              </button>
            </Show>
            <Show when={selectedStaged().length > 0}>
              <button
                type="button"
                role="menuitem"
                data-testid="git-context-unstage-selected"
                disabled={store.committing() || store.mutating()}
                class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                onClick={unstageSelectedFiles}
              >
                <Minus class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span class="truncate leading-normal min-w-0">
                  {i18n.t('git.selection.unstage', { count: selectedStaged().length })}
                </span>
              </button>
            </Show>
            <Show when={selectedStashable().length > 0}>
              <button
                type="button"
                role="menuitem"
                data-testid="git-context-stash-selected"
                disabled={store.committing() || store.mutating()}
                class="w-full px-2 h-[26px] rounded-lg flex items-center gap-1.5 text-left text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
                onClick={stashSelectedFiles}
              >
                <Archive class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span class="truncate leading-normal min-w-0">
                  {i18n.t('git.selection.stash', { count: selectedStashable().length })}
                </span>
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
