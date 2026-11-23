import type { ProjectScope } from '@lite-ide/kernel'
import type { DirEntry } from '@lite-ide/protocol'
import {
  ConfirmDialogKey,
  copyTextToClipboard,
  EditorBufferKey,
  FileIcon,
  getI18n,
  joinNativePath,
  ProjectSelectionKey,
  WorkspaceBackendKey,
  WorkspaceSearchLauncherKey,
} from '@lite-ide/workbench'
import { createVirtualizer } from '@tanstack/solid-virtual'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import ChevronsDownUp from 'lucide-solid/icons/chevrons-down-up'
import Copy from 'lucide-solid/icons/copy'
import Eye from 'lucide-solid/icons/eye'
import EyeOff from 'lucide-solid/icons/eye-off'
import FilePlus from 'lucide-solid/icons/file-plus'
import FileStack from 'lucide-solid/icons/file-stack'
import FolderOpen from 'lucide-solid/icons/folder-open'
import FolderPlus from 'lucide-solid/icons/folder-plus'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Pencil from 'lucide-solid/icons/pencil'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import Search from 'lucide-solid/icons/search'
import Trash from 'lucide-solid/icons/trash'
import X from 'lucide-solid/icons/x'
import { batch, createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  FileTreeStoreKey,
  parentDirOf,
  type FlatTreeNode,
} from './tree-store'

export interface ExplorerViewProps {
  scope: ProjectScope
}

interface InlineNameInputProps {
  initialValue: string
  placeholder: string
  selectBaseName: boolean
  error: string | null
  onSubmit: (value: string) => Promise<boolean>
  onCancel: () => void
}

function InlineNameInput(props: InlineNameInputProps) {
  const [value, setValue] = createSignal(props.initialValue)
  let inputEl: HTMLInputElement | undefined
  let settled = false
  let submitting = false

  onMount(() => {
    requestAnimationFrame(() => {
      if (!inputEl) return
      inputEl.focus()
      if (props.selectBaseName) {
        const dotIdx = props.initialValue.lastIndexOf('.')
        if (dotIdx > 0) {
          inputEl.setSelectionRange(0, dotIdx)
        } else {
          inputEl.select()
        }
      } else {
        inputEl.select()
      }
    })
  })

  async function trySubmit(fromBlur: boolean) {
    if (settled || submitting) return
    const trimmed = value().trim()
    if (!trimmed) {
      settled = true
      props.onCancel()
      return
    }
    if (fromBlur && props.initialValue && trimmed === props.initialValue) {
      settled = true
      props.onCancel()
      return
    }
    submitting = true
    const ok = await props.onSubmit(trimmed)
    submitting = false
    if (ok) {
      settled = true
    } else if (!fromBlur) {
      requestAnimationFrame(() => inputEl?.focus())
    } else {
      settled = true
      props.onCancel()
    }
  }

  return (
    <div
      class="relative flex-1 min-w-0"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputEl}
        type="text"
        value={value()}
        placeholder={props.placeholder}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void trySubmit(false)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            settled = true
            props.onCancel()
          }
        }}
        onBlur={() => void trySubmit(true)}
        class={`w-full h-[22px] px-2 rounded-md bg-[var(--bg-inset-focus)] border outline-none text-xs text-[var(--text-primary)] leading-normal transition-all ${
          props.error
            ? 'border-[var(--danger-border)] shadow-[0_0_0_2px_var(--danger-bg)]'
            : 'border-[var(--accent-border)] shadow-[0_0_0_2px_var(--accent-soft)]'
        }`}
      />
      <Show when={props.error}>
        {(errMsg) => (
          <div class="absolute left-0 top-[25px] z-30 max-w-[260px] px-2.5 py-1.5 rounded-lg glass-surface border-[var(--danger-border)] bg-[var(--danger-bg)] text-[10.5px] text-[var(--danger-text)] whitespace-normal break-words animate-popover-in">
            {errMsg()}
          </div>
        )}
      </Show>
    </div>
  )
}

export function ExplorerView(props: ExplorerViewProps) {
  const store = props.scope.get(FileTreeStoreKey)
  const selection = props.scope.get(ProjectSelectionKey)
  const buffers = props.scope.tryGet(EditorBufferKey)
  const dialogs = props.scope.tryGet(ConfirmDialogKey)
  const backend = props.scope.get(WorkspaceBackendKey)
  const i18n = getI18n(props.scope)

  const [contextMenu, setContextMenu] = createSignal<{
    x: number
    y: number
    entry: DirEntry | null
  } | null>(null)

  let scrollEl: HTMLDivElement | undefined

  const virtualizer = createVirtualizer({
    get count() {
      return store.visibleNodes().length
    },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => 28,
    overscan: 15,
  })

  onMount(() => {
    void store.ensureRootLoaded()
    const savedScroll = store.scrollOffset()
    if (scrollEl && savedScroll > 0) {
      requestAnimationFrame(() => {
        if (scrollEl) scrollEl.scrollTop = savedScroll
      })
    }
  })

  createEffect(() => {
    const menu = contextMenu()
    if (!menu) return

    const close = () => setContextMenu(null)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKeyDown)
    })
  })

  function resolveTargetParentDir(): string {
    const candidate = store.focusedPath() ?? selection.selectedPath()
    if (!candidate) return ''
    const node = store.visibleNodes().find((n) => n.entry.relPath === candidate)
    if (node) {
      return node.entry.isDir ? node.entry.relPath : parentDirOf(node.entry.relPath)
    }
    return parentDirOf(candidate)
  }

  async function activateNode(node: FlatTreeNode) {
    if (node.creatingKind) return
    store.setFocusedPath(node.entry.relPath)
    if (node.entry.isDir) {
      await store.toggleDir(node.entry.relPath)
    } else {
      await selection.selectFile(node.entry.relPath)
    }
  }

  async function handleCommitCreate(rawName: string): Promise<boolean> {
    const created = await store.commitCreate(rawName)
    if (!created) return false
    if (!created.isDir) {
      await selection.selectFile(created.relPath)
    }
    return true
  }

  async function handleCommitRename(rawName: string): Promise<boolean> {
    const pending = store.pendingAction()
    if (pending?.kind === 'rename' && rawName.trim() === pending.originalName) {
      store.cancelAction()
      return true
    }
    const release =
      pending?.kind === 'rename'
        ? buffers?.suppressPath(pending.relPath, pending.isDir)
        : undefined
    try {
      const renamed = await store.commitRename(rawName)
      if (!renamed) return false
      let renamePromise: Promise<void> | undefined
      batch(() => {
        buffers?.renamePaths(renamed.oldRelPath, renamed.newRelPath, renamed.isDir)
        renamePromise = selection.renamePaths(
          renamed.oldRelPath,
          renamed.newRelPath,
          renamed.isDir,
        )
      })
      await renamePromise
      return true
    } finally {
      release?.()
    }
  }

  async function confirmAndDelete(entry: DirEntry) {
    const affectedDirty = buffers
      ? [...buffers.dirtyPaths()].filter(
          (p) => p === entry.relPath || (entry.isDir && p.startsWith(`${entry.relPath}/`)),
        )
      : []

    if (dialogs) {
      const dirtyNote =
        affectedDirty.length === 0
          ? ''
          : affectedDirty.length === 1
            ? i18n.t('explorer.delete.dirtyNoteOne')
            : i18n.t('explorer.delete.dirtyNoteMany', { count: affectedDirty.length })
      const choice = await dialogs.confirm({
        title: entry.isDir
          ? i18n.t('explorer.delete.folderTitle')
          : i18n.t('explorer.delete.fileTitle'),
        message: entry.isDir
          ? i18n.t('explorer.delete.folderMessage', { name: entry.name, dirtyNote })
          : i18n.t('explorer.delete.fileMessage', { name: entry.name, dirtyNote }),
        details: [entry.relPath],
        actions: [
          { id: 'delete', label: i18n.t('explorer.menu.delete'), variant: 'danger' },
          { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
        ],
        cancelId: 'cancel',
      })
      if (choice !== 'delete') return
    }

    const release = buffers?.suppressPath(entry.relPath, entry.isDir)
    try {
      const ok = await store.deleteEntry(entry.relPath, entry.isDir)
      if (!ok) return

      await selection.removePaths(entry.relPath, entry.isDir)
      buffers?.removePaths(entry.relPath, entry.isDir)
    } finally {
      release?.()
    }
  }

  async function copyEntryPath(entry: DirEntry, relative: boolean) {
    const text = relative ? entry.relPath : joinNativePath(props.scope.rootPath, entry.relPath)
    await copyTextToClipboard(text)
  }

  // 在系统文件管理器中显示条目。
  async function revealEntry(entry: DirEntry) {
    try {
      await backend.revealInFileManager?.(props.scope.id, entry.relPath)
    } catch (err) {
      console.error('[explorer] reveal in file manager failed', err)
    }
  }

  function openMenuAt(x: number, y: number, entry: DirEntry | null) {
    const maxX = typeof window !== 'undefined' ? window.innerWidth - 180 : x
    const maxY = typeof window !== 'undefined' ? window.innerHeight - 240 : y
    setContextMenu({
      x: Math.max(8, Math.min(x, maxX)),
      y: Math.max(8, Math.min(y, maxY)),
      entry,
    })
  }

  function handleKeyDown(e: KeyboardEvent) {
    const targetTag = (e.target as HTMLElement | null)?.tagName
    if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') return

    const nodes = store.visibleNodes().filter((n) => !n.creatingKind)
    if (nodes.length === 0) return

    const currentPath = store.focusedPath() ?? selection.selectedPath()
    const currentIdx = nodes.findIndex((n) => n.entry.relPath === currentPath)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIdx = Math.min(nodes.length - 1, currentIdx + 1)
      const target = nodes[nextIdx]
      if (target) {
        store.setFocusedPath(target.entry.relPath)
        virtualizer.scrollToIndex(nextIdx, { align: 'auto' })
      }
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIdx = currentIdx <= 0 ? 0 : currentIdx - 1
      const target = nodes[prevIdx]
      if (target) {
        store.setFocusedPath(target.entry.relPath)
        virtualizer.scrollToIndex(prevIdx, { align: 'auto' })
      }
      return
    }

    const currentNode = currentIdx >= 0 ? nodes[currentIdx] : undefined
    if (!currentNode) return

    if (e.key === 'F2') {
      e.preventDefault()
      store.startRename(
        currentNode.entry.relPath,
        currentNode.entry.isDir,
        currentNode.entry.name,
      )
      return
    }

    if (e.key === 'Delete') {
      e.preventDefault()
      void confirmAndDelete(currentNode.entry)
      return
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (currentNode.entry.isDir && !currentNode.expanded) {
        void store.expandDir(currentNode.entry.relPath)
      }
      return
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (currentNode.entry.isDir && currentNode.expanded) {
        store.collapseDir(currentNode.entry.relPath)
      } else if (currentNode.parentPath) {
        store.setFocusedPath(currentNode.parentPath)
        const parentIdx = nodes.findIndex((n) => n.entry.relPath === currentNode.parentPath)
        if (parentIdx >= 0) virtualizer.scrollToIndex(parentIdx, { align: 'auto' })
      }
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      void activateNode(currentNode)
    }
  }

  return (
    <div class="flex-1 min-h-0 flex flex-col select-none relative">
      {/* Two-row filter & action toolbar */}
      <div class="shrink-0 border-b border-[var(--border-subtle)]">
        <div class="px-2.5 pt-2.5 pb-1.5">
          <div class="relative flex items-center h-[30px] rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus-within:border-[var(--accent-border)] focus-within:bg-[var(--bg-inset-focus)] focus-within:shadow-[0_0_0_2px_var(--accent-soft)] transition-all">
            <Search class="w-3.5 h-3.5 text-[var(--text-muted)] ml-2.5 shrink-0 pointer-events-none" />
            <input
              type="text"
              value={store.filterQuery()}
              onInput={(e) => store.setFilterQuery(e.currentTarget.value)}
              placeholder={i18n.t('explorer.filterPlaceholder')}
              class="w-full h-full px-2 bg-transparent outline-none text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
            <Show when={store.filterQuery().length > 0}>
              <button
                type="button"
                title={i18n.t('explorer.clearFilter')}
                class="mr-1.5 p-0.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                onClick={() => store.setFilterQuery('')}
              >
                <X class="w-3 h-3" />
              </button>
            </Show>
          </div>
        </div>

        <div class="px-2.5 pb-1.5 flex items-center justify-between gap-2">
          <span class="text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-muted)] pl-1 tabular-nums">
            <Show
              when={store.filterQuery().trim().length > 0}
              fallback={i18n.t('explorer.filesHeading')}
            >
              {store.visibleNodes().length === 1
                ? i18n.t('explorer.matchesOne')
                : i18n.t('explorer.matchesMany', { count: store.visibleNodes().length })}
            </Show>
          </span>

          <div class="flex items-center gap-0.5">
            <button
              type="button"
              title={i18n.t('explorer.newFile')}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 active:scale-95"
              onClick={() => void store.startCreate('file', resolveTargetParentDir())}
            >
              <FilePlus class="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              title={i18n.t('explorer.newFolder')}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 active:scale-95"
              onClick={() => void store.startCreate('dir', resolveTargetParentDir())}
            >
              <FolderPlus class="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              title={i18n.t('explorer.refreshTree')}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 active:scale-95"
              onClick={() => void store.refreshAllExpanded()}
            >
              <RefreshCw class={`w-3.5 h-3.5 ${store.rootLoading() ? 'animate-spin' : ''}`} />
            </button>

            <button
              type="button"
              title={i18n.t('explorer.collapseAll')}
              class="p-1.5 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 active:scale-95"
              onClick={() => store.collapseAll()}
            >
              <ChevronsDownUp class="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              title={
                store.showIgnored()
                  ? i18n.t('explorer.hideIgnored')
                  : i18n.t('explorer.showIgnored')
              }
              class={`p-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95 ${
                store.showIgnored()
                  ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  : 'text-[var(--accent)] bg-[var(--accent-soft)]'
              }`}
              onClick={() => store.toggleShowIgnored()}
            >
              <Show when={store.showIgnored()} fallback={<EyeOff class="w-3.5 h-3.5" />}>
                <Eye class="w-3.5 h-3.5" />
              </Show>
            </button>
          </div>
        </div>
      </div>

      {/* Error banner */}
      <Show when={store.error()}>
        {(msg) => (
          <div class="mx-2 mt-2 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--danger-text)] bg-[var(--danger-bg)] border border-[var(--danger-border)]">
            {msg()}
          </div>
        )}
      </Show>

      {/* Virtualized Tree */}
      <div
        ref={scrollEl}
        tabIndex={0}
        role="tree"
        class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden outline-none py-1.5"
        onScroll={(e) => {
          store.setScrollOffset(e.currentTarget.scrollTop)
          if (contextMenu()) setContextMenu(null)
        }}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenuAt(e.clientX, e.clientY, null)
        }}
      >
        <Show
          when={!store.rootLoading() || store.visibleNodes().length > 0}
          fallback={
            <div class="flex items-center justify-center gap-2 py-8 text-xs text-[var(--text-muted)]">
              <Loader2 class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
              <span>{i18n.t('explorer.loading')}</span>
            </div>
          }
        >
          <Show
            when={store.visibleNodes().length > 0}
            fallback={
              <div class="px-3 py-8 text-center text-xs text-[var(--text-muted)]">
                {i18n.t('explorer.noMatches')}
              </div>
            }
          >
            <div
              class="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              <For each={virtualizer.getVirtualItems()}>
                {(virtualItem) => {
                  const node = () => store.visibleNodes()[virtualItem.index]
                  return (
                    <Show when={node()}>
                      {(item) => {
                        const isCreating = () => Boolean(item().creatingKind)
                        const isRenaming = () => {
                          const pending = store.pendingAction()
                          return (
                            pending?.kind === 'rename' &&
                            pending.relPath === item().entry.relPath
                          )
                        }
                        const isSelected = () =>
                          !isCreating() &&
                          selection.selectedPath() === item().entry.relPath
                        const isFocused = () =>
                          !isCreating() &&
                          store.focusedPath() === item().entry.relPath
                        const isDirty = () =>
                          !isCreating() &&
                          !item().entry.isDir &&
                          (buffers?.isDirty(item().entry.relPath) ?? false)
                        const indentLevels = () =>
                          Array.from({ length: item().depth }, (_, idx) => idx)

                        return (
                          <div
                            role="treeitem"
                            aria-expanded={item().entry.isDir ? item().expanded : undefined}
                            aria-selected={isSelected()}
                            title={
                              isCreating()
                                ? i18n.t('explorer.enterName')
                                : item().entry.relPath
                            }
                            class={`group/row absolute top-0 left-1.5 right-1.5 rounded-lg flex items-center gap-1.5 pr-2 text-xs transition-colors duration-100 ${
                              isSelected()
                                ? 'bg-[var(--bg-active)] text-[var(--text-primary)] font-medium ring-1 ring-inset ring-[var(--accent-border)]'
                                : isFocused()
                                  ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                            } ${item().entry.ignored ? 'opacity-50' : ''} ${
                              isCreating() || isRenaming() ? 'z-20' : ''
                            }`}
                            style={{
                              height: `${virtualItem.size}px`,
                              transform: `translateY(${virtualItem.start}px)`,
                              'padding-left': `${8 + item().depth * 14}px`,
                            }}
                            onClick={() => void activateNode(item())}
                            onContextMenu={(e) => {
                              if (isCreating()) return
                              e.preventDefault()
                              e.stopPropagation()
                              store.setFocusedPath(item().entry.relPath)
                              openMenuAt(e.clientX, e.clientY, item().entry)
                            }}
                          >
                            {/* Selected row accent indicator */}
                            <Show when={isSelected()}>
                              <span class="absolute left-0.5 top-1/2 -translate-y-1/2 w-[2.5px] h-3.5 rounded-full bg-[var(--accent)]" />
                            </Show>

                            {/* Indent guide lines */}
                            <For each={indentLevels()}>
                              {(level) => (
                                <span
                                  aria-hidden="true"
                                  class="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--guide-line)]"
                                  style={{ left: `${14 + level * 14}px` }}
                                />
                              )}
                            </For>

                            <span class="w-4 h-4 flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                              <Show when={item().entry.isDir && !isCreating()}>
                                <Show
                                  when={!item().loading}
                                  fallback={<Loader2 class="w-3 h-3 animate-spin text-[var(--accent)]" />}
                                >
                                  <ChevronRight
                                    class={`w-3.5 h-3.5 transition-transform duration-150 ${
                                      item().expanded
                                        ? 'rotate-90 text-[var(--text-secondary)]'
                                        : 'group-hover/row:text-[var(--text-secondary)]'
                                    }`}
                                  />
                                </Show>
                              </Show>
                            </span>

                            <FileIcon
                              name={item().entry.name || (item().creatingKind === 'dir' ? 'folder' : 'file.txt')}
                              isDir={item().entry.isDir}
                              expanded={item().expanded}
                              ignored={item().entry.ignored}
                            />

                            <Show
                              when={isCreating() || isRenaming()}
                              fallback={
                                <>
                                  <span
                                    class={`truncate flex-1 leading-normal ${
                                      isDirty() ? 'text-[var(--text-primary)] font-medium' : ''
                                    }`}
                                  >
                                    {item().entry.name}
                                  </span>
                                  <Show when={isDirty()}>
                                    <span
                                      title={i18n.t('explorer.unsavedChanges')}
                                      class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)] shrink-0"
                                    />
                                  </Show>
                                </>
                              }
                            >
                              <InlineNameInput
                                initialValue={isRenaming() ? item().entry.name : ''}
                                placeholder={
                                  item().creatingKind === 'dir'
                                    ? i18n.t('explorer.newFolderPlaceholder')
                                    : i18n.t('explorer.newFilePlaceholder')
                                }
                                selectBaseName={isRenaming() && !item().entry.isDir}
                                error={store.actionError()}
                                onSubmit={(val) =>
                                  isCreating()
                                    ? handleCommitCreate(val)
                                    : handleCommitRename(val)
                                }
                                onCancel={() => store.cancelAction()}
                              />
                            </Show>
                          </div>
                        )
                      }}
                    </Show>
                  )
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      {/* Explorer Context Menu */}
      <Show when={contextMenu()}>
        {(menu) => {
          const entry = () => menu().entry
          const targetParent = () => {
            const target = entry()
            if (!target) return ''
            return target.isDir ? target.relPath : parentDirOf(target.relPath)
          }
          return (
            <div
              role="menu"
              class="fixed z-40 min-w-[176px] p-1.5 rounded-xl glass-surface animate-popover-in text-xs text-[var(--text-primary)]"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Show when={entry() && !entry()!.isDir}>
                <button
                  type="button"
                  class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  onClick={() => {
                    const target = entry()!
                    setContextMenu(null)
                    void selection.selectFile(target.relPath)
                  }}
                >
                  <span>{i18n.t('explorer.menu.open')}</span>
                </button>
              </Show>

              <Show when={entry()}>
                <button
                  type="button"
                  class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  onClick={() => {
                    const target = entry()!
                    setContextMenu(null)
                    void revealEntry(target)
                  }}
                >
                  <FolderOpen class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{i18n.t('explorer.menu.revealInFileManager')}</span>
                </button>
              </Show>

              <Show when={entry()?.isDir && props.scope.tryGet(WorkspaceSearchLauncherKey)}>
                <button
                  type="button"
                  class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  onClick={() => {
                    const target = entry()!
                    const launcher = props.scope.tryGet(WorkspaceSearchLauncherKey)
                    setContextMenu(null)
                    launcher?.findInFiles({ include: `${target.relPath}/` })
                  }}
                >
                  <Search class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{i18n.t('explorer.menu.findInFolder')}</span>
                </button>
              </Show>

              <Show when={!entry() || entry()!.isDir}>
                <button
                  type="button"
                  class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  onClick={() => {
                    const parent = targetParent()
                    setContextMenu(null)
                    void store.startCreate('file', parent)
                  }}
                >
                  <FilePlus class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{i18n.t('explorer.newFile')}</span>
                </button>
                <button
                  type="button"
                  class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  onClick={() => {
                    const parent = targetParent()
                    setContextMenu(null)
                    void store.startCreate('dir', parent)
                  }}
                >
                  <FolderPlus class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{i18n.t('explorer.newFolder')}</span>
                </button>
              </Show>

              <Show when={!entry()}>
                <div class="my-1 border-t border-[var(--border-subtle)]" />
                <button
                  type="button"
                  class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  onClick={() => {
                    setContextMenu(null)
                    void store.refreshAllExpanded()
                  }}
                >
                  <RefreshCw class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                  <span>{i18n.t('explorer.menu.refresh')}</span>
                </button>
              </Show>

              <Show when={entry()}>
                {(target) => (
                  <>
                    <div class="my-1 border-t border-[var(--border-subtle)]" />
                    <button
                      type="button"
                      class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between gap-2"
                      onClick={() => {
                        const item = target()
                        setContextMenu(null)
                        store.startRename(item.relPath, item.isDir, item.name)
                      }}
                    >
                      <span class="flex items-center gap-2">
                        <Pencil class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                        <span>{i18n.t('explorer.menu.rename')}</span>
                      </span>
                      <span class="text-[10px] font-mono text-[var(--text-muted)]">F2</span>
                    </button>
                    <button
                      type="button"
                      class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                      onClick={() => {
                        const item = target()
                        setContextMenu(null)
                        void copyEntryPath(item, false)
                      }}
                    >
                      <Copy class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                      <span>{i18n.t('common.copyPath')}</span>
                    </button>
                    <button
                      type="button"
                      class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                      onClick={() => {
                        const item = target()
                        setContextMenu(null)
                        void copyEntryPath(item, true)
                      }}
                    >
                      <FileStack class="w-3.5 h-3.5 text-[var(--text-secondary)]" />
                      <span>{i18n.t('common.copyRelativePath')}</span>
                    </button>
                    <button
                      type="button"
                      class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--danger-bg)] text-[var(--danger-text)] transition-colors flex items-center justify-between gap-2"
                      onClick={() => {
                        const item = target()
                        setContextMenu(null)
                        void confirmAndDelete(item)
                      }}
                    >
                      <span class="flex items-center gap-2">
                        <Trash class="w-3.5 h-3.5" />
                        <span>{i18n.t('explorer.menu.delete')}</span>
                      </span>
                      <span class="text-[10px] font-mono opacity-65">Del</span>
                    </button>
                  </>
                )}
              </Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}
