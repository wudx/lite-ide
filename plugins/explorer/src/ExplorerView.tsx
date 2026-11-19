import type { ProjectScope } from '@lite-ide/kernel'
import { ProjectSelectionKey } from '@lite-ide/workbench'
import { createVirtualizer } from '@tanstack/solid-virtual'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-solid'
import { For, onMount, Show } from 'solid-js'
import { FileIcon } from './file-icons'
import { FileTreeStoreKey, type FlatTreeNode } from './tree-store'

export interface ExplorerViewProps {
  scope: ProjectScope
}

export function ExplorerView(props: ExplorerViewProps) {
  const store = props.scope.get(FileTreeStoreKey)
  const selection = props.scope.get(ProjectSelectionKey)

  let scrollEl: HTMLDivElement | undefined

  const virtualizer = createVirtualizer({
    get count() {
      return store.visibleNodes().length
    },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => 26,
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

  async function activateNode(node: FlatTreeNode) {
    store.setFocusedPath(node.entry.relPath)
    if (node.entry.isDir) {
      await store.toggleDir(node.entry.relPath)
    } else {
      await selection.selectFile(node.entry.relPath)
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const nodes = store.visibleNodes()
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
    <div class="flex-1 min-h-0 flex flex-col select-none">
      {/* Filter & toolbar */}
      <div class="px-2 py-1.5 border-b border-[var(--border-subtle)] flex items-center gap-1">
        <div class="relative flex-1 min-w-0">
          <Search class="w-3 h-3 text-[var(--text-muted)] absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={store.filterQuery()}
            onInput={(e) => store.setFilterQuery(e.currentTarget.value)}
            placeholder="Filter files..."
            class="w-full h-6 pl-6 pr-5 rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] focus:border-[var(--accent)] outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <Show when={store.filterQuery().length > 0}>
            <button
              type="button"
              title="Clear Filter"
              class="absolute right-1 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => store.setFilterQuery('')}
            >
              <X class="w-3 h-3" />
            </button>
          </Show>
        </div>

        <button
          type="button"
          title="Refresh Tree"
          class="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => void store.refreshAllExpanded()}
        >
          <RefreshCw class={`w-3.5 h-3.5 ${store.rootLoading() ? 'animate-spin' : ''}`} />
        </button>

        <button
          type="button"
          title="Collapse All Folders"
          class="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => store.collapseAll()}
        >
          <ChevronsDownUp class="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          title={store.showIgnored() ? 'Hide Ignored Files' : 'Show Ignored Files'}
          class={`p-1 rounded hover:bg-[var(--bg-hover)] ${
            store.showIgnored() ? 'text-[var(--text-secondary)]' : 'text-[var(--accent)]'
          }`}
          onClick={() => store.toggleShowIgnored()}
        >
          <Show when={store.showIgnored()} fallback={<EyeOff class="w-3.5 h-3.5" />}>
            <Eye class="w-3.5 h-3.5" />
          </Show>
        </button>
      </div>

      {/* Error banner */}
      <Show when={store.error()}>
        {(msg) => (
          <div class="px-2.5 py-1.5 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/20">
            {msg()}
          </div>
        )}
      </Show>

      {/* Virtualized Tree */}
      <div
        ref={scrollEl}
        tabIndex={0}
        role="tree"
        class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden outline-none py-1"
        onScroll={(e) => store.setScrollOffset(e.currentTarget.scrollTop)}
        onKeyDown={handleKeyDown}
      >
        <Show
          when={!store.rootLoading() || store.visibleNodes().length > 0}
          fallback={
            <div class="flex items-center justify-center gap-2 py-8 text-xs text-[var(--text-muted)]">
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              <span>Loading project files...</span>
            </div>
          }
        >
          <Show
            when={store.visibleNodes().length > 0}
            fallback={
              <div class="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                No matching files
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
                        const isSelected = () =>
                          selection.selectedPath() === item().entry.relPath
                        const isFocused = () =>
                          store.focusedPath() === item().entry.relPath
                        return (
                          <div
                            role="treeitem"
                            aria-expanded={item().entry.isDir ? item().expanded : undefined}
                            aria-selected={isSelected()}
                            title={item().entry.relPath}
                            class={`absolute top-0 left-0 right-0 flex items-center gap-1 pr-2 cursor-pointer text-xs transition-colors ${
                              isSelected()
                                ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                                : isFocused()
                                  ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                            } ${item().entry.ignored ? 'opacity-50' : ''}`}
                            style={{
                              height: `${virtualItem.size}px`,
                              transform: `translateY(${virtualItem.start}px)`,
                              'padding-left': `${8 + item().depth * 14}px`,
                            }}
                            onClick={() => void activateNode(item())}
                          >
                            <span class="w-4 h-4 flex items-center justify-center shrink-0 text-[var(--text-muted)]">
                              <Show when={item().entry.isDir}>
                                <Show
                                  when={!item().loading}
                                  fallback={<Loader2 class="w-3 h-3 animate-spin" />}
                                >
                                  <Show
                                    when={item().expanded}
                                    fallback={<ChevronRight class="w-3.5 h-3.5" />}
                                  >
                                    <ChevronDown class="w-3.5 h-3.5" />
                                  </Show>
                                </Show>
                              </Show>
                            </span>

                            <FileIcon
                              name={item().entry.name}
                              isDir={item().entry.isDir}
                              expanded={item().expanded}
                              ignored={item().entry.ignored}
                            />

                            <span class="truncate flex-1 leading-none">
                              {item().entry.name}
                            </span>
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
    </div>
  )
}
