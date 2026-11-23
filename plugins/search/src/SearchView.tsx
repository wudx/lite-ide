import type { ProjectScope } from '@lite-ide/kernel'
import { FileIcon, getI18n } from '@lite-ide/workbench'
import { createVirtualizer } from '@tanstack/solid-virtual'
import CaseSensitive from 'lucide-solid/icons/case-sensitive'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import ChevronsDownUp from 'lucide-solid/icons/chevrons-down-up'
import ChevronsUpDown from 'lucide-solid/icons/chevrons-up-down'
import Eraser from 'lucide-solid/icons/eraser'
import Loader2 from 'lucide-solid/icons/loader-circle'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import RegexIcon from 'lucide-solid/icons/regex'
import Replace from 'lucide-solid/icons/replace'
import ReplaceAll from 'lucide-solid/icons/replace-all'
import SlidersHorizontal from 'lucide-solid/icons/sliders-horizontal'
import AlertTriangle from 'lucide-solid/icons/triangle-exclamation-point'
import WholeWord from 'lucide-solid/icons/whole-word'
import {
  createEffect,
  createMemo,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from 'solid-js'
import {
  computeReplacementPreview,
  SEARCH_MAX_MATCHES,
  type FileSearchResult,
  type SearchMatch,
} from './search-engine'
import { SearchStoreKey } from './search-store'

export interface SearchViewProps {
  scope: ProjectScope
}

type FlatSearchRow =
  | { kind: 'file'; file: FileSearchResult; collapsed: boolean }
  | { kind: 'match'; match: SearchMatch }

interface LineSnippet {
  before: string
  matched: string
  after: string
}

function buildLineSnippet(match: SearchMatch, replacementLength: number | null): LineSnippet {
  const raw = match.lineText
  let leadingWs = 0
  while (leadingWs < match.lineOffset && (raw[leadingWs] === ' ' || raw[leadingWs] === '\t')) {
    leadingWs += 1
  }
  const trimmedOffset = match.lineOffset - leadingWs
  const trimmedLine = raw.slice(leadingWs)

  const maxBefore =
    replacementLength !== null
      ? Math.min(14, Math.max(0, 22 - match.length - replacementLength))
      : 16
  let before = trimmedLine.slice(0, trimmedOffset)
  if (maxBefore === 0 && before.length > 0) {
    before = '…'
  } else if (before.length > maxBefore) {
    before = `…${before.slice(before.length - maxBefore)}`
  }

  const matched = trimmedLine.slice(trimmedOffset, trimmedOffset + match.length)
  const afterRaw = trimmedLine.slice(trimmedOffset + match.length)
  const MAX_AFTER = 80
  const after = afterRaw.length > MAX_AFTER ? `${afterRaw.slice(0, MAX_AFTER)}…` : afterRaw

  return { before, matched, after }
}

export function SearchView(props: SearchViewProps) {
  const store = props.scope.get(SearchStoreKey)
  const i18n = getI18n(props.scope)

  let searchInputEl: HTMLInputElement | undefined
  let replaceInputEl: HTMLInputElement | undefined
  let scrollEl: HTMLDivElement | undefined

  const flatRows = createMemo<FlatSearchRow[]>(() => {
    const collapsed = store.collapsedFiles()
    const rows: FlatSearchRow[] = []
    for (const file of store.results()) {
      const isCollapsed = collapsed.has(file.relPath)
      rows.push({ kind: 'file', file, collapsed: isCollapsed })
      if (!isCollapsed) {
        for (const match of file.matches) {
          rows.push({ kind: 'match', match })
        }
      }
    }
    return rows
  })

  const virtualizer = createVirtualizer({
    get count() {
      return flatRows().length
    },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => 26,
    overscan: 15,
  })

  const allCollapsed = createMemo(() => {
    const list = store.results()
    if (list.length === 0) return false
    const collapsed = store.collapsedFiles()
    return list.every((f) => collapsed.has(f.relPath))
  })

  const hasFilters = createMemo(
    () =>
      store.filesToInclude().trim().length > 0 ||
      store.filesToExclude().trim().length > 0 ||
      !store.useIgnoreFiles(),
  )

  function applyFocus(target: 'search' | 'replace') {
    queueMicrotask(() => {
      const el = target === 'replace' ? replaceInputEl : searchInputEl
      el?.focus()
      el?.select()
    })
  }

  onMount(() => {
    const savedScroll = store.scrollOffset()
    if (scrollEl && savedScroll > 0) {
      requestAnimationFrame(() => {
        if (scrollEl) scrollEl.scrollTop = savedScroll
      })
    }
    const req = store.focusRequest()
    if (req) {
      applyFocus(req.target)
    } else {
      queueMicrotask(() => searchInputEl?.focus())
    }
  })

  let lastAppliedFocusSeq = store.focusRequest()?.seq ?? 0
  createEffect(() => {
    const req = store.focusRequest()
    if (!req || req.seq === lastAppliedFocusSeq) return
    lastAppliedFocusSeq = req.seq
    applyFocus(req.target)
  })

  const summaryText = createMemo(() => {
    const files = store.totalFiles()
    const matches = store.totalMatches()
    const base =
      files === 1 && matches === 1
        ? i18n.t('search.summaryOne')
        : i18n.t('search.summary', { files, matches })
    return store.truncated()
      ? `${base}${i18n.t('search.summaryTruncated', { limit: SEARCH_MAX_MATCHES })}`
      : base
  })

  return (
    <div class="flex-1 min-h-0 flex flex-col select-none">
      {/* Toolbar */}
      <div class="px-2.5 pt-2 pb-1.5 flex items-center justify-between gap-1 shrink-0">
        <span class="text-[11px] font-medium text-[var(--text-secondary)] truncate leading-normal">
          {i18n.t('search.view.title')}
        </span>
        <div class="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            title={i18n.t('search.refresh')}
            aria-label={i18n.t('search.refresh')}
            disabled={!store.query() || store.searching()}
            class="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none transition-colors"
            onClick={() => void store.runSearchNow()}
          >
            <RefreshCw class={`w-3.5 h-3.5 ${store.searching() ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            title={i18n.t('search.clear')}
            aria-label={i18n.t('search.clear')}
            disabled={!store.query() && store.results().length === 0}
            class="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none transition-colors"
            onClick={() => store.clearSearch()}
          >
            <Eraser class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title={allCollapsed() ? i18n.t('search.expandAll') : i18n.t('search.collapseAll')}
            aria-label={allCollapsed() ? i18n.t('search.expandAll') : i18n.t('search.collapseAll')}
            disabled={store.results().length === 0}
            class="w-6 h-6 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none transition-colors"
            onClick={() => (allCollapsed() ? store.expandAll() : store.collapseAll())}
          >
            <Show
              when={allCollapsed()}
              fallback={<ChevronsDownUp class="w-3.5 h-3.5" />}
            >
              <ChevronsUpDown class="w-3.5 h-3.5" />
            </Show>
          </button>
          <button
            type="button"
            title={i18n.t('search.toggleFilters')}
            aria-label={i18n.t('search.toggleFilters')}
            aria-expanded={store.filtersExpanded()}
            class={`relative w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
              store.filtersExpanded()
                ? 'bg-[var(--bg-active)] text-[var(--accent)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
            onClick={() => store.toggleFiltersExpanded()}
          >
            <SlidersHorizontal class="w-3.5 h-3.5" />
            <Show when={hasFilters() && !store.filtersExpanded()}>
              <span class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            </Show>
          </button>
        </div>
      </div>

      {/* Search & Replace Inputs */}
      <div class="px-2.5 pb-2 flex items-stretch gap-1 shrink-0">
        <button
          type="button"
          title={i18n.t('search.toggleReplace')}
          aria-label={i18n.t('search.toggleReplace')}
          aria-expanded={store.replaceExpanded()}
          class="w-5 shrink-0 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          onClick={() => store.toggleReplaceExpanded()}
        >
          <ChevronRight
            class={`w-3.5 h-3.5 transition-transform duration-150 ${
              store.replaceExpanded() ? 'rotate-90' : ''
            }`}
          />
        </button>

        <div class="flex-1 min-w-0 flex flex-col gap-1.5">
          {/* Search input row */}
          <div
            class={`flex items-center h-[28px] rounded-lg bg-[var(--bg-inset)] border transition-colors focus-within:bg-[var(--bg-inset-focus)] ${
              store.error()
                ? 'border-[var(--danger-border)]'
                : 'border-[var(--border-subtle)] focus-within:border-[var(--accent-border)]'
            }`}
          >
            <input
              ref={searchInputEl}
              type="text"
              data-testid="search-query-input"
              value={store.query()}
              placeholder={i18n.t('search.placeholder')}
              aria-label={i18n.t('search.placeholder')}
              onInput={(e) => store.setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void store.runSearchNow()
                }
              }}
              class="flex-1 min-w-0 h-full pl-2.5 pr-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none leading-normal"
            />

            <div class="flex items-center gap-0.5 pr-1 shrink-0">
              <button
                type="button"
                title={i18n.t('search.caseSensitive')}
                aria-label={i18n.t('search.caseSensitive')}
                aria-pressed={store.caseSensitive()}
                data-testid="search-toggle-case"
                class={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  store.caseSensitive()
                    ? 'bg-[var(--bg-active)] text-[var(--accent)] border border-[var(--accent-border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-transparent'
                }`}
                onClick={() => store.toggleCaseSensitive()}
              >
                <CaseSensitive class="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title={i18n.t('search.wholeWord')}
                aria-label={i18n.t('search.wholeWord')}
                aria-pressed={store.wholeWord()}
                data-testid="search-toggle-whole-word"
                class={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  store.wholeWord()
                    ? 'bg-[var(--bg-active)] text-[var(--accent)] border border-[var(--accent-border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-transparent'
                }`}
                onClick={() => store.toggleWholeWord()}
              >
                <WholeWord class="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title={i18n.t('search.useRegex')}
                aria-label={i18n.t('search.useRegex')}
                aria-pressed={store.useRegex()}
                data-testid="search-toggle-regex"
                class={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  store.useRegex()
                    ? 'bg-[var(--bg-active)] text-[var(--accent)] border border-[var(--accent-border)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-transparent'
                }`}
                onClick={() => store.toggleUseRegex()}
              >
                <RegexIcon class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Replace input row */}
          <Show when={store.replaceExpanded()}>
            <div class="flex items-center gap-1">
              <div class="flex-1 min-w-0 flex items-center h-[28px] rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus-within:bg-[var(--bg-inset-focus)] focus-within:border-[var(--accent-border)] transition-colors">
                <input
                  ref={replaceInputEl}
                  type="text"
                  data-testid="search-replace-input"
                  value={store.replaceText()}
                  placeholder={i18n.t('search.replacePlaceholder')}
                  aria-label={i18n.t('search.replacePlaceholder')}
                  onInput={(e) => store.setReplaceText(e.currentTarget.value)}
                  class="flex-1 min-w-0 h-full px-2.5 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none leading-normal"
                />
              </div>
              <button
                type="button"
                title={i18n.t('search.replaceAll')}
                aria-label={i18n.t('search.replaceAll')}
                data-testid="search-replace-all"
                disabled={
                  !store.compiledPattern() ||
                  store.results().length === 0 ||
                  store.replacing()
                }
                class="w-[28px] h-[28px] shrink-0 rounded-lg flex items-center justify-center border border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:pointer-events-none transition-colors"
                onClick={() => void store.replaceAll()}
              >
                <ReplaceAll class="w-3.5 h-3.5" />
              </button>
            </div>
          </Show>
        </div>
      </div>

      {/* Include / Exclude Filters */}
      <Show when={store.filtersExpanded()}>
        <div class="px-2.5 pb-2 pt-0.5 flex flex-col gap-1.5 border-b border-[var(--border-subtle)] shrink-0">
          <div class="flex flex-col gap-0.5">
            <label class="text-[10.5px] text-[var(--text-muted)] leading-normal">
              {i18n.t('search.includeLabel')}
            </label>
            <input
              type="text"
              data-testid="search-include-input"
              value={store.filesToInclude()}
              placeholder={i18n.t('search.includePlaceholder')}
              aria-label={i18n.t('search.includeLabel')}
              onInput={(e) => store.setFilesToInclude(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void store.runSearchNow()
                }
              }}
              class="h-[26px] px-2 rounded-md bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:bg-[var(--bg-inset-focus)] focus:border-[var(--accent-border)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none leading-normal"
            />
          </div>
          <div class="flex flex-col gap-0.5">
            <label class="text-[10.5px] text-[var(--text-muted)] leading-normal">
              {i18n.t('search.excludeLabel')}
            </label>
            <input
              type="text"
              data-testid="search-exclude-input"
              value={store.filesToExclude()}
              placeholder={i18n.t('search.excludePlaceholder')}
              aria-label={i18n.t('search.excludeLabel')}
              onInput={(e) => store.setFilesToExclude(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void store.runSearchNow()
                }
              }}
              class="h-[26px] px-2 rounded-md bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:bg-[var(--bg-inset-focus)] focus:border-[var(--accent-border)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none leading-normal"
            />
          </div>
          <label class="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer py-0.5">
            <input
              type="checkbox"
              data-testid="search-use-ignore"
              checked={store.useIgnoreFiles()}
              onChange={() => store.toggleUseIgnoreFiles()}
              class="accent-[var(--accent)] rounded"
            />
            <span class="truncate leading-normal">{i18n.t('search.useIgnoreFiles')}</span>
          </label>
        </div>
      </Show>

      {/* Regex / Search Error */}
      <Show when={store.error()}>
        {(errMsg) => (
          <div class="mx-2.5 mb-2 px-2.5 py-1.5 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[11px] text-[var(--danger-text)] flex items-start gap-1.5 shrink-0">
            <AlertTriangle class="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--danger-icon)]" />
            <span class="break-words leading-normal">{errMsg()}</span>
          </div>
        )}
      </Show>

      {/* Result Summary Bar */}
      <Show when={(store.hasSearched() || store.replacing()) && !store.error()}>
        <div
          data-testid="search-summary"
          class="px-3 py-1 text-[11px] text-[var(--text-muted)] border-y border-[var(--border-subtle)] flex items-center gap-1.5 shrink-0"
        >
          <Show when={store.searching() || store.replacing()}>
            <Loader2 class="w-3 h-3 animate-spin text-[var(--accent)] shrink-0" />
          </Show>
          <span class="truncate leading-normal">
            {store.replacing()
              ? i18n.t('search.replacing')
              : store.searching()
                ? i18n.t('search.searching')
                : store.results().length === 0
                  ? i18n.t('search.noResults')
                  : summaryText()}
          </span>
        </div>
      </Show>

      {/* Results List */}
      <div
        ref={scrollEl}
        role="tree"
        aria-label={i18n.t('search.resultsAria')}
        class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 py-1.5"
        onScroll={(e) => store.setScrollOffset(e.currentTarget.scrollTop)}
      >
        <Show
          when={flatRows().length > 0}
          fallback={
            <Show when={!store.hasSearched() && !store.searching() && !store.error()}>
              <div class="px-3 py-6 text-center text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                {i18n.t('search.emptyHint')}
              </div>
            </Show>
          }
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const row = createMemo(() => flatRows()[virtualRow.index])
                return (
                  <Show when={row()}>
                    {(current) => (
                      <div
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <Switch>
                          <Match when={current().kind === 'file' ? current() : undefined}>
                            {(fileRow) => {
                              const file = () => (fileRow() as Extract<FlatSearchRow, { kind: 'file' }>).file
                              const collapsed = () => (fileRow() as Extract<FlatSearchRow, { kind: 'file' }>).collapsed
                              return (
                                <div
                                  role="treeitem"
                                  aria-expanded={!collapsed()}
                                  data-testid={`search-file-${file().relPath}`}
                                  class="group h-[26px] px-1.5 rounded-md flex items-center gap-1.5 hover:bg-[var(--bg-hover)] text-xs cursor-pointer transition-colors"
                                  onClick={() => store.toggleFileCollapsed(file().relPath)}
                                >
                                  <ChevronRight
                                    class={`w-3.5 h-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-100 ${
                                      collapsed() ? '' : 'rotate-90'
                                    }`}
                                  />
                                  <FileIcon name={file().name} isDir={false} />
                                  <span class="font-medium text-[var(--text-primary)] truncate leading-normal">
                                    {file().name}
                                  </span>
                                  <Show when={file().dir}>
                                    <span class="text-[10.5px] text-[var(--text-muted)] truncate leading-normal">
                                      {file().dir}
                                    </span>
                                  </Show>
                                  <span class="ml-auto flex items-center gap-1 shrink-0">
                                    <Show when={store.replaceExpanded()}>
                                      <button
                                        type="button"
                                        title={i18n.t('search.replaceInFile')}
                                        aria-label={i18n.t('search.replaceInFile')}
                                        data-testid={`search-replace-file-${file().relPath}`}
                                        class="opacity-0 group-hover:opacity-100 focus:opacity-100 w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover-strong)] transition-all"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          void store.replaceInFile(file().relPath)
                                        }}
                                      >
                                        <ReplaceAll class="w-3 h-3" />
                                      </button>
                                    </Show>
                                    <span class="px-1.5 py-[1px] rounded-full bg-[var(--bg-subtle)] text-[10px] text-[var(--text-secondary)] tabular-nums">
                                      {file().matches.length}
                                    </span>
                                  </span>
                                </div>
                              )
                            }}
                          </Match>

                          <Match when={current().kind === 'match' ? current() : undefined}>
                            {(matchRow) => {
                              const match = () => (matchRow() as Extract<FlatSearchRow, { kind: 'match' }>).match
                              const replacementPreview = createMemo(() => {
                                if (!store.replaceExpanded()) return null
                                const pattern = store.compiledPattern()
                                if (!pattern) return null
                                return computeReplacementPreview(
                                  match(),
                                  store.replaceText(),
                                  pattern,
                                )
                              })
                              const snippet = createMemo(() => {
                                const preview = replacementPreview()
                                return buildLineSnippet(match(), preview === null ? null : preview.length)
                              })
                              return (
                                <div
                                  role="treeitem"
                                  data-testid={`search-match-${match().relPath}:${match().line}:${match().column}`}
                                  title={`${match().relPath}:${match().line}:${match().column}`}
                                  class="group h-[26px] pl-6 pr-1.5 rounded-md flex items-center gap-1.5 hover:bg-[var(--bg-hover)] text-[11.5px] cursor-pointer transition-colors"
                                  onClick={() => void store.openMatch(match())}
                                >
                                  <span class="text-[10px] font-mono text-[var(--text-muted)] tabular-nums shrink-0">
                                    {match().line}:
                                  </span>
                                  <span class="min-w-0 flex-1 font-mono text-[11.5px] text-[var(--text-secondary)] truncate leading-normal">
                                    <span>{snippet().before}</span>
                                    <span
                                      class={
                                        replacementPreview() !== null
                                          ? 'px-0.5 rounded bg-[var(--diff-del-bg)] text-[var(--diff-del-text)] line-through'
                                          : 'px-0.5 rounded bg-[var(--bg-active)] text-[var(--text-primary)] font-medium'
                                      }
                                    >
                                      {snippet().matched}
                                    </span>
                                    <Show when={replacementPreview() !== null}>
                                      <span class="px-0.5 rounded bg-[var(--diff-add-bg)] text-[var(--diff-add-text)] font-medium">
                                        {replacementPreview()}
                                      </span>
                                    </Show>
                                    <span>{snippet().after}</span>
                                  </span>
                                  <Show when={store.replaceExpanded()}>
                                    <button
                                      type="button"
                                      title={i18n.t('search.replaceOne')}
                                      aria-label={i18n.t('search.replaceOne')}
                                      data-testid={`search-replace-one-${match().relPath}:${match().line}:${match().column}`}
                                      class="hidden group-hover:flex group-focus-within:flex w-5 h-5 shrink-0 rounded items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover-strong)] transition-all"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        void store.replaceMatch(match())
                                      }}
                                    >
                                      <Replace class="w-3 h-3" />
                                    </button>
                                  </Show>
                                </div>
                              )
                            }}
                          </Match>
                        </Switch>
                      </div>
                    )}
                  </Show>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
