import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import Search from 'lucide-solid/icons/search'
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js'
import { getI18n } from '../i18n'
import {
  buildFileIndex,
  QuickOpenKey,
  searchQuickOpen,
  type QuickOpenFileEntry,
} from '../quick-open'
import {
  ProjectFsEventsKey,
  ProjectSelectionKey,
  WorkspaceBackendKey,
} from '../services'
import { FileIcon } from './FileIcon'

export interface QuickOpenDialogProps {
  kernel: AppKernel
}

const HIGHLIGHT_CLASS = 'text-[var(--accent)] font-semibold'

export function QuickOpenDialog(props: QuickOpenDialogProps) {
  const service = props.kernel.tryGet(QuickOpenKey)
  const i18n = getI18n(props.kernel)
  const [query, setQuery] = createSignal('')
  const [files, setFiles] = createSignal<QuickOpenFileEntry[] | null>(null)
  const [indexError, setIndexError] = createSignal<string | null>(null)
  const [noProject, setNoProject] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined
  let walkSeq = 0
  // Per-project index cache; the fs watcher below drops entries on changes.
  const indexCache = new Map<string, QuickOpenFileEntry[]>()

  const results = createMemo(() => {
    const index = files()
    if (!index) return []
    return searchQuickOpen(index, query())
  })

  createEffect(() => {
    // Reset the highlight whenever the candidate list changes identity.
    results()
    setSelectedIndex(0)
  })

  createEffect(() => {
    const idx = selectedIndex()
    if (!listRef) return
    listRef.querySelectorAll('[data-quick-open-row]')[idx]?.scrollIntoView({ block: 'nearest' })
  })

  // Component-lifetime fs watcher: keep tracking the active project even while
  // the palette is closed, so edits made in between invalidate the cache and
  // the next open always sees a fresh tree. onCleanup disposes the previous
  // subscription when the active project switches or the component unmounts.
  createEffect(() => {
    const scope = props.kernel.activeProject()
    const fsEvents = scope?.tryGet(ProjectFsEventsKey)
    if (scope && fsEvents) {
      const scopeId = scope.id
      const unsub = fsEvents.on('delta', () => {
        indexCache.delete(scopeId)
      })
      onCleanup(() => unsub.dispose())
    }
  })

  async function ensureIndex(scope: ProjectScope | undefined): Promise<void> {
    if (!service) return
    const backend = props.kernel.tryGet(WorkspaceBackendKey)
    if (!scope || !backend) {
      setNoProject(!scope)
      setFiles([])
      setIndexError(null)
      return
    }

    const projectId = scope.id
    const cached = indexCache.get(projectId)
    if (cached) {
      // Cancel any in-flight walk for another project before publishing.
      walkSeq += 1
      setNoProject(false)
      setIndexError(null)
      setFiles(cached)
      return
    }

    const seq = ++walkSeq
    setFiles(null)
    setIndexError(null)
    setNoProject(false)
    try {
      const { files: built, failedDirCount } = await buildFileIndex(backend, projectId)
      if (seq !== walkSeq) return
      // Partial indexes (some directory failed to list) stay uncached so the
      // next open retries the full walk.
      if (failedDirCount === 0) {
        indexCache.set(projectId, built)
      }
      // The active project may have switched while walking; only publish
      // results that still match what the user is looking at.
      if (!service.isOpen() || props.kernel.activeProject()?.id !== projectId) return
      setFiles(built)
    } catch (err) {
      if (seq !== walkSeq) return
      if (!service.isOpen() || props.kernel.activeProject()?.id !== projectId) return
      setFiles([])
      setIndexError(err instanceof Error ? err.message : String(err))
    }
  }

  // While the palette is open, reset state and (re)index the active project.
  // Tracks activeProject so switching project tabs refreshes the results.
  createEffect(() => {
    if (!service?.isOpen()) return
    const scope = props.kernel.activeProject()
    setQuery('')
    setSelectedIndex(0)
    void ensureIndex(scope)
    // The input mounts with the <Show> above; focus it once it exists.
    queueMicrotask(() => inputRef?.focus())
  })

  onCleanup(() => {
    walkSeq += 1
  })

  function close(): void {
    service?.close()
  }

  function openEntry(relPath: string): void {
    const selection = props.kernel.activeProject()?.tryGet(ProjectSelectionKey)
    if (!selection) return
    void selection.selectFile(relPath)
    close()
  }

  function onInputKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const count = results().length
      if (count > 0) setSelectedIndex((prev) => (prev + 1) % count)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const count = results().length
      if (count > 0) setSelectedIndex((prev) => (prev - 1 + count) % count)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = results()[selectedIndex()]
      if (target) openEntry(target.entry.relPath)
    }
  }

  // Render one row's label: dimmed directory prefix + highlighted basename.
  function RowLabel(entry: QuickOpenFileEntry, indices: readonly number[]): JSX.Element {
    const nameStart = entry.relPath.length - entry.name.length
    const matchedInName = new Set(
      indices.filter((i) => i >= nameStart).map((i) => i - nameStart),
    )
    const dir = nameStart > 0 ? entry.relPath.slice(0, nameStart) : ''
    const nameSpans: JSX.Element[] = []
    let buffer = ''
    for (let i = 0; i < entry.name.length; i += 1) {
      if (matchedInName.has(i)) {
        if (buffer) {
          nameSpans.push(<span>{buffer}</span>)
          buffer = ''
        }
        nameSpans.push(<span class={HIGHLIGHT_CLASS}>{entry.name[i]}</span>)
      } else {
        buffer += entry.name[i]
      }
    }
    if (buffer) nameSpans.push(<span>{buffer}</span>)

    return (
      <span class="min-w-0 flex-1 flex items-baseline gap-2">
        <span class="truncate leading-normal">{nameSpans}</span>
        <Show when={dir}>
          <span class="shrink-0 max-w-[45%] truncate text-[11px] text-[var(--text-muted)] leading-normal">
            {dir}
          </span>
        </Show>
      </span>
    )
  }

  const listContent = createMemo<JSX.Element>(() => {
    if (noProject()) {
      return (
        <div class="px-4 py-6 text-xs text-[var(--text-muted)] leading-normal">
          {i18n.t('quickOpen.noProject')}
        </div>
      )
    }
    if (indexError()) {
      return (
        <div class="px-4 py-6 text-xs text-[var(--text-muted)] leading-normal">
          {i18n.t('quickOpen.indexError', { message: indexError()! })}
        </div>
      )
    }
    if (!files()) {
      return (
        <div class="px-4 py-6 text-xs text-[var(--text-muted)] leading-normal">
          {i18n.t('quickOpen.indexing')}
        </div>
      )
    }
    const current = results()
    if (current.length === 0) {
      return (
        <div class="px-4 py-6 text-xs text-[var(--text-muted)] leading-normal">
          {i18n.t('quickOpen.noMatches')}
        </div>
      )
    }
    return (
      <For each={current}>
        {(result, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index() === selectedIndex()}
            data-quick-open-row
            data-rel-path={result.entry.relPath}
            class={`w-full text-left px-3 py-1.5 rounded-lg flex items-center gap-2.5 text-[13px] transition-colors leading-normal ${
              index() === selectedIndex()
                ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setSelectedIndex(index())}
            onClick={() => openEntry(result.entry.relPath)}
          >
            <FileIcon name={result.entry.name} isDir={false} />
            {RowLabel(result.entry, result.indices)}
          </button>
        )}
      </For>
    )
  })

  return (
    <Show when={service?.isOpen()}>
      <div
        class="fixed inset-0 z-50 animate-backdrop-in"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close()
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={i18n.t('quickOpen.dialogAria')}
          class="absolute left-1/2 top-10 -translate-x-1/2 w-[min(620px,92vw)] rounded-2xl glass-surface shadow-2xl overflow-hidden animate-popover-in"
        >
          <div class="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-[var(--border-subtle)]">
            <Search class="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
            <input
              ref={inputRef}
              type="text"
              class="flex-1 bg-transparent outline-none text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] leading-normal"
              placeholder={i18n.t('quickOpen.placeholder')}
              spellcheck={false}
              autocomplete="off"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onInputKeyDown}
            />
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label={i18n.t('quickOpen.resultsAria')}
            class="max-h-[46vh] min-h-[44px] overflow-y-auto p-1.5"
          >
            {listContent()}
          </div>
          <div class="flex items-center gap-3 px-3.5 py-1.5 border-t border-[var(--border-subtle)] text-[10.5px] text-[var(--text-muted)] leading-normal">
            <span>{i18n.t('quickOpen.hintNavigate')}</span>
            <span>{i18n.t('quickOpen.hintOpen')}</span>
            <span>{i18n.t('quickOpen.hintClose')}</span>
          </div>
        </div>
      </div>
    </Show>
  )
}
