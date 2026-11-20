import type { AppKernel } from '@lite-ide/kernel'
import Braces from 'lucide-solid/icons/braces'
import Loader2 from 'lucide-solid/icons/loader-circle'
import X from 'lucide-solid/icons/x'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from 'solid-js'
import { getI18n } from '../i18n'
import { CodeNavigationKey, type NavigationPanelMode } from '../navigation'
import { FileIcon } from './FileIcon'

/**
 * Bottom-docked results panel for code navigation: definition candidates,
 * references, or implementations. Rows jump to their location; the panel
 * stays open for browsing (Esc or the × button closes it).
 */
export function NavigationPanel(props: { kernel: AppKernel }) {
  const i18n = getI18n(props.kernel)
  const navigation = createMemo(() =>
    props.kernel.activeProject()?.tryGet(CodeNavigationKey),
  )
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let panelEl: HTMLDivElement | undefined

  const state = createMemo(() => navigation()?.panel() ?? null)
  const locations = createMemo(() => state()?.locations ?? [])

  createEffect(() => {
    // Reset the highlight whenever the result list changes identity.
    locations()
    state()?.mode
    state()?.symbol
    setSelectedIndex(0)
  })

  // Only Escape is a global shortcut. Arrow/Enter handling lives on the panel
  // itself, so an open panel never steals keys from the editor, the CodeMirror
  // search panel or any other input.
  createEffect(() => {
    if (!state()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        navigation()?.closePanel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    onCleanup(() => window.removeEventListener('keydown', onKey, true))
  })

  // Take focus when opening so ↑/Enter work immediately; rows keep focus on
  // the panel via mousedown preventDefault, allowing click-to-browse.
  createEffect(() => {
    if (!state()) return
    queueMicrotask(() => panelEl?.focus())
  })

  function onPanelKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const count = locations().length
      if (count === 0) return
      setSelectedIndex((prev) =>
        e.key === 'ArrowDown' ? (prev + 1) % count : (prev - 1 + count) % count,
      )
      return
    }
    if (e.key === 'Enter') {
      // preventDefault suppresses the native click of a focused row button.
      e.preventDefault()
      const target = locations()[selectedIndex()]
      if (target) void navigation()?.revealLocation(target.relPath, target.line, target.column)
    }
  }

  // Keep the keyboard-selected row visible while arrowing through results.
  createEffect(() => {
    const idx = selectedIndex()
    if (!panelEl) return
    panelEl.querySelectorAll('[data-navigation-row]')[idx]?.scrollIntoView({ block: 'nearest' })
  })

  function modeLabel(mode: NavigationPanelMode): string {
    if (mode === 'references') return i18n.t('navigation.mode.references')
    if (mode === 'implementations') return i18n.t('navigation.mode.implementations')
    return i18n.t('navigation.mode.definitions')
  }

  function baseNameOf(relPath: string): string {
    const idx = relPath.lastIndexOf('/')
    return idx === -1 ? relPath : relPath.slice(idx + 1)
  }

  function parentOf(relPath: string): string {
    const idx = relPath.lastIndexOf('/')
    return idx === -1 ? '' : relPath.slice(0, idx)
  }

  const bodyContent = createMemo(() => {
    const current = state()
    if (!current) return null
    if (current.notice === 'noCursor') {
      return (
        <div class="px-4 py-5 text-xs text-[var(--text-muted)] leading-normal">
          {i18n.t('navigation.noCursor')}
        </div>
      )
    }
    if (current.loading) {
      return (
        <div class="px-4 py-5 flex items-center gap-2 text-xs text-[var(--text-muted)] leading-normal">
          <Loader2 class="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
          <span>{i18n.t('navigation.indexing')}</span>
        </div>
      )
    }
    const currentLocations = locations()
    if (currentLocations.length === 0) {
      return (
        <div class="px-4 py-5 text-xs text-[var(--text-muted)] leading-normal">
          {i18n.t('navigation.notFound', {
            symbol: current.symbol,
            mode: modeLabel(current.mode),
          })}
        </div>
      )
    }
    return (
      <For each={currentLocations}>
        {(loc, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index() === selectedIndex()}
            data-navigation-row
            data-rel-path={loc.relPath}
            data-line={loc.line}
            class={`w-full text-left px-3 py-1.5 rounded-lg flex items-center gap-2.5 transition-colors leading-normal ${
              index() === selectedIndex()
                ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            }`}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setSelectedIndex(index())}
            onClick={() =>
              void navigation()?.revealLocation(loc.relPath, loc.line, loc.column)
            }
          >
            <FileIcon name={baseNameOf(loc.relPath)} isDir={false} />
            <span class="min-w-0 flex-1 flex items-baseline gap-2">
              <span
                class={`truncate font-mono text-[12px] ${
                  loc.isDefinition ? 'text-[var(--text-primary)] font-medium' : ''
                }`}
                title={loc.text}
              >
                {loc.text || '…'}
              </span>
              <Show when={loc.isDefinition}>
                <span class="shrink-0 px-1.5 py-0.5 rounded-md bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[10px] font-medium text-[var(--accent)]">
                  {i18n.t('navigation.definitionBadge')}
                </span>
              </Show>
            </span>
            <span class="shrink-0 max-w-[40%] truncate text-[11px] text-[var(--text-muted)]">
              {parentOf(loc.relPath) ? `${parentOf(loc.relPath)}/` : ''}
              {baseNameOf(loc.relPath)}:{loc.line}
            </span>
          </button>
        )}
      </For>
    )
  })

  return (
    <Show when={state()}>
      <div
        ref={(el) => (panelEl = el)}
        role="dialog"
        aria-label={i18n.t('navigation.panelAria')}
        data-navigation-panel
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        class="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 w-[min(720px,92vw)] rounded-2xl glass-surface shadow-2xl overflow-hidden animate-popover-in outline-none"
      >
        <div class="flex items-center gap-2.5 px-3.5 py-2 border-b border-[var(--border-subtle)]">
          <Braces class="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
          <span class="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-md bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
            {modeLabel(state()!.mode)}
          </span>
          <span class="min-w-0 truncate font-mono text-[13px] font-medium text-[var(--text-primary)]">
            {state()!.symbol}
          </span>
          <Show when={!state()!.loading}>
            <span class="shrink-0 text-[11px] text-[var(--text-muted)] tabular-nums">
              {i18n.t('navigation.resultCount', { count: locations().length })}
            </span>
          </Show>
          <button
            type="button"
            title={i18n.t('navigation.hintClose')}
            class="ml-auto p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shrink-0"
            onClick={() => navigation()?.closePanel()}
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div role="listbox" aria-label={i18n.t('navigation.resultsAria')} class="max-h-[38vh] min-h-[44px] overflow-y-auto p-1.5">
          {bodyContent()}
        </div>
        <div class="flex items-center gap-3 px-3.5 py-1.5 border-t border-[var(--border-subtle)] text-[10.5px] text-[var(--text-muted)] leading-normal">
          <span>{i18n.t('navigation.hintNavigate')}</span>
          <span>{i18n.t('navigation.hintJump')}</span>
          <span>{i18n.t('navigation.hintClose')}</span>
        </div>
      </div>
    </Show>
  )
}
