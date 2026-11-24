import type { ProjectScope } from '@lite-ide/kernel'
import { createTabDragReorder, getI18n, PanelStateKey, ThemeStateKey } from '@lite-ide/workbench'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import Plus from 'lucide-solid/icons/plus'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import TerminalIcon from 'lucide-solid/icons/terminal'
import TriangleAlert from 'lucide-solid/icons/triangle-exclamation-point'
import X from 'lucide-solid/icons/x'
import { batch, createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TERMINAL_PANEL_ID, TerminalStoreKey, type TerminalTabSession } from './terminal-store'

/** Neutral ANSI palettes; fg/bg/cursor/accent follow the active theme vars. */
const DARK_ANSI = {
  black: '#252932',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

const LIGHT_ANSI = {
  black: '#3b3b3b',
  red: '#c4484c',
  green: '#4f7a3f',
  yellow: '#967004',
  blue: '#2e5f9e',
  magenta: '#98429a',
  cyan: '#2b7a86',
  white: '#8a8a8a',
  brightBlack: '#5f5f5f',
  brightRed: '#a33236',
  brightGreen: '#3d6132',
  brightYellow: '#7a5a03',
  brightBlue: '#24497c',
  brightMagenta: '#7d3580',
  brightCyan: '#22636d',
  brightWhite: '#1f1f1f',
}

// Solarized Light ANSI palette; white/brightWhite are calibrated to dark Solarized
// base01/base02 so ANSI white output stays legible against the #eee8d5 panel.
const SOLARIZED_LIGHT_ANSI = {
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#586e75',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#425860',
  brightYellow: '#657b83',
  brightBlue: '#268bd2',
  brightMagenta: '#6c71c4',
  brightCyan: '#2aa198',
  brightWhite: '#073642',
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function buildTerminalTheme(themeId: string, appearance: 'dark' | 'light') {
  const isSolarized = themeId === 'solarized-light'
  const palette = isSolarized ? SOLARIZED_LIGHT_ANSI : appearance === 'dark' ? DARK_ANSI : LIGHT_ANSI
  const fallbackBg = isSolarized ? '#eee8d5' : appearance === 'dark' ? '#1e2229' : '#f5f6f9'
  const fallbackFg = isSolarized ? '#425860' : appearance === 'dark' ? '#d4d4d4' : '#333333'
  return {
    foreground: cssVar('--text-primary', fallbackFg),
    // xterm viewport paints an opaque background, so mirror the panel card
    // color directly instead of relying on 'transparent'.
    background: cssVar('--bg-sidebar', fallbackBg),
    cursor: cssVar('--accent', appearance === 'dark' ? '#61afef' : '#2e5f9e'),
    cursorAccent: cssVar('--bg-sidebar', fallbackBg),
    selectionBackground: isSolarized
      ? 'rgba(223, 202, 136, 0.55)'
      : appearance === 'dark'
        ? 'rgba(148, 163, 184, 0.30)'
        : 'rgba(100, 116, 139, 0.28)',
    ...palette,
  }
}

const MIN_TERM_COLS = 20
const MIN_TERM_ROWS = 6

interface TerminalPaneProps {
  scope: ProjectScope
  tab: TerminalTabSession
  active: boolean
  panelVisible: boolean
  isPanelActive: boolean
  themeId: string
  appearance: 'dark' | 'light'
}

/**
 * Single terminal session pane: owns one xterm.js instance bound to a
 * TerminalTabSession. Kept mounted with display:none while inactive so
 * running PTY output and scrollback survive tab switches.
 */
function TerminalPane(props: TerminalPaneProps) {
  const i18n = getI18n(props.scope)

  let hostRef: HTMLDivElement | undefined
  const [termReady, setTermReady] = createSignal(false)
  let term: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let observer: ResizeObserver | null = null

  function startSession(currentTerm: Terminal): void {
    void props.tab.store.start(
      Math.max(currentTerm.cols, MIN_TERM_COLS),
      Math.max(currentTerm.rows, MIN_TERM_ROWS),
    )
  }

  function fitIfVisible(): boolean {
    if (!term || !fitAddon || !hostRef) return false
    if (!props.panelVisible || !props.active) return false
    if (hostRef.clientWidth === 0 || hostRef.clientHeight === 0) return false
    try {
      fitAddon.fit()
      props.tab.store.resize(term.cols, term.rows)
      // 懒启动：只有面板与当前页签均可见（有布局尺寸）才拉起 shell，
      // 后台热项目与未激活页签不占空闲 shell 进程。
      if (props.tab.store.status() === 'idle') {
        startSession(term)
      }
      return true
    } catch {
      // fit() can throw while the host is mid-layout; the observer retries.
      return false
    }
  }

  onMount(() => {
    const created = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 2000,
      theme: buildTerminalTheme(props.themeId, props.appearance),
    })
    term = created
    fitAddon = new FitAddon()
    created.loadAddon(fitAddon)
    created.open(hostRef!)
    setTermReady(true)

    const unsubOutput = props.tab.store.onOutput((bytes) => {
      created.write(bytes)
    })
    const unsubExit = props.tab.store.onExit((code) => {
      created.write(`\r\n\x1b[2m${i18n.t('terminal.restartHint', { code })}\x1b[0m\r\n`)
    })
    created.onData((data) => {
      props.tab.store.write(data)
    })

    observer = new ResizeObserver(() => fitIfVisible())
    observer.observe(hostRef!)

    onCleanup(() => {
      unsubOutput()
      unsubExit()
      observer?.disconnect()
      observer = null
      created.dispose()
      term = null
      fitAddon = null
    })
  })

  // Re-fit & focus whenever this pane becomes visible (panel reopen or tab switch).
  createEffect(() => {
    const shown = props.panelVisible && props.active
    if (!termReady() || !shown) return
    const rafId = requestAnimationFrame(() => {
      if (fitIfVisible() && props.isPanelActive) {
        term?.focus()
      }
    })
    onCleanup(() => cancelAnimationFrame(rafId))
  })

  // Track theme id & appearance so terminal colors follow every theme switch.
  createEffect(() => {
    const nextThemeId = props.themeId
    const nextAppearance = props.appearance
    if (!termReady() || !term) return
    term.options.theme = buildTerminalTheme(nextThemeId, nextAppearance)
  })

  function restart() {
    if (!term) return
    term.reset()
    fitIfVisible()
    startSession(term)
  }

  function retrySpawn() {
    if (!term) return
    startSession(term)
  }

  return (
    <div
      class="relative flex-1 min-h-0 flex"
      style={{ display: props.active ? 'flex' : 'none' }}
      data-testid={`terminal-pane-${props.tab.index}`}
      data-terminal-tab-id={props.tab.id}
      data-active={props.active ? 'true' : 'false'}
      onMouseUp={() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed) {
          if (props.isPanelActive && props.active) term?.focus()
        }
      }}
    >
      <div ref={(el) => (hostRef = el)} class="liteide-terminal-host" />

      <Show when={props.tab.store.status() === 'starting'}>
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span class="text-xs text-[var(--text-muted)] animate-pulse">
            {i18n.t('terminal.starting')}
          </span>
        </div>
      </Show>

      <Show when={props.tab.store.status() === 'exited'}>
        <button
          type="button"
          data-testid="terminal-restart"
          title={i18n.t('terminal.restartHint', { code: props.tab.store.exitCode() ?? -1 })}
          class="absolute top-1.5 right-3 z-10 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-[var(--bg-surface)] border border-[var(--border-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] shadow-sm transition-all duration-150"
          onClick={restart}
        >
          <RotateCcw class="w-3 h-3" />
          <span>{i18n.t('terminal.restart')}</span>
        </button>
      </Show>

      <Show when={props.tab.store.status() === 'unsupported'}>
        <div class="absolute inset-0 flex items-center justify-center p-4">
          <div class="flex items-start gap-2 max-w-md text-xs text-[var(--text-secondary)]">
            <TriangleAlert class="w-4 h-4 shrink-0 text-[var(--warning-icon)]" />
            <span>{i18n.t('terminal.unsupported')}</span>
          </div>
        </div>
      </Show>

      <Show when={props.tab.store.error()}>
        {(errMsg) => (
          <div class="absolute top-1.5 left-3 right-3 z-10 p-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-[11px] flex items-center gap-2">
            <TriangleAlert class="w-3.5 h-3.5 shrink-0" />
            <span class="truncate leading-normal">{i18n.t('terminal.error', { message: errMsg() })}</span>
            <button
              type="button"
              data-testid="terminal-retry"
              title={i18n.t('terminal.restart')}
              class="ml-auto shrink-0 px-2 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150"
              onClick={retrySpawn}
            >
              {i18n.t('terminal.restart')}
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}

/**
 * Bottom-panel terminal view with integrated multi-terminal tab strip.
 * Each tab keeps its own xterm.js & PTY session alive across tab switches
 * and panel visibility toggles while the project scope remains warm.
 */
export function TerminalView(props: { scope: ProjectScope }) {
  const i18n = getI18n(props.scope)
  const manager = props.scope.get(TerminalStoreKey)
  const panelState = props.scope.get(PanelStateKey)
  const themeState = props.scope.tryGet(ThemeStateKey)

  const themeId = () => themeState?.theme() ?? 'dark'
  const appearance = () => themeState?.appearance() ?? 'dark'
  const isTerminalActive = () => {
    const id = panelState.activePanelId()
    return id === TERMINAL_PANEL_ID || id === null
  }

  let tabStrip: HTMLDivElement | undefined

  const tabDrag = createTabDragReorder({
    getStrip: () => tabStrip,
    reorder: (fromIndex, toIndex) => manager.moveTab(fromIndex, toIndex),
  })

  // Ensure a fresh default tab whenever the panel opens after all tabs were closed.
  createEffect((wasVisible: boolean) => {
    const visible = panelState.visible()
    if (visible && !wasVisible && manager.tabs().length === 0) {
      manager.ensureDefaultTab()
    }
    return visible
  }, false)

  // Reveal the active terminal tab inside the scrollable tab strip.
  createEffect(() => {
    const activeId = manager.activeTab()?.id
    if (!activeId || !tabStrip || !panelState.visible() || tabDrag.draggingId()) return
    if (tabStrip.scrollWidth <= tabStrip.clientWidth) return
    const els = tabStrip.querySelectorAll<HTMLElement>('[data-tab-drag-id]')
    for (const el of els) {
      if (el.dataset.tabDragId === activeId) {
        el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
        break
      }
    }
  })

  function handleTabStripWheel(event: WheelEvent) {
    const strip = event.currentTarget as HTMLElement
    if (event.ctrlKey) return
    if (strip.scrollWidth <= strip.clientWidth) return
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
    const dominant = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    const delta = dominant * scale
    if (delta === 0) return
    event.preventDefault()
    strip.scrollLeft += delta
  }

  function closeTerminalTab(id: string) {
    batch(() => {
      manager.closeTab(id)
      if (manager.tabs().length === 0) {
        panelState.setVisible(false)
      }
    })
  }

  return (
    <div
      class="flex-1 min-h-0 flex flex-col"
      data-testid={`panel-view-${TERMINAL_PANEL_ID}`}
    >
      <div class="h-[34px] shrink-0 flex items-end bg-[var(--bg-editor-chrome)] border-b border-[var(--border-subtle)] select-none">
        <div
          ref={(el) => (tabStrip = el)}
          role="tablist"
          aria-label={i18n.t('terminal.tabsAria')}
          data-testid="terminal-tabs"
          onWheel={handleTabStripWheel}
          class="flex-1 min-w-0 h-full px-2 pt-1 flex items-end gap-1 overflow-x-auto no-scrollbar"
        >
          <For each={manager.tabs()}>
            {(tab) => {
              const isActive = () => manager.activeTab()?.id === tab.id
              const isExited = () => tab.store.status() === 'exited'
              const isDragging = () => tabDrag.draggingId() === tab.id
              const tabTitle = () => i18n.t('terminal.tabTitle', { index: tab.index })
              const tabTooltip = () => {
                const label = tab.store.shellLabel()
                const base = label ? `${tabTitle()} (${label})` : tabTitle()
                return isExited() ? `${base} - ${i18n.t('terminal.exitedBadge')}` : base
              }
              return (
                <div
                  role="tab"
                  aria-selected={isActive()}
                  title={tabTooltip()}
                  data-testid={`terminal-tab-${tab.index}`}
                  data-tab-drag-id={tab.id}
                  {...tabDrag.tabHandlers(tab.id)}
                  class={`group relative flex items-center gap-1.5 min-w-[88px] max-w-[180px] text-xs transition-colors duration-150 shrink-0 cursor-pointer ${
                    isDragging() ? 'opacity-70 z-20' : ''
                  } ${
                    isActive()
                      ? 'h-[28px] rounded-t-lg px-2.5 bg-[var(--bg-sidebar)] text-[var(--text-primary)] border-t border-x border-[var(--border-subtle)] -mb-px z-10'
                      : 'h-[26px] mb-[2px] rounded-lg px-2 bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  onClick={() => manager.selectTab(tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      closeTerminalTab(tab.id)
                    }
                  }}
                >
                  <TerminalIcon
                    class={`w-3.5 h-3.5 shrink-0 ${
                      isExited()
                        ? 'opacity-50 text-[var(--text-muted)]'
                        : isActive()
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--text-muted)]'
                    }`}
                  />

                  <span
                    class={`truncate leading-normal ${
                      isExited() ? 'opacity-65' : isActive() ? 'font-medium' : ''
                    }`}
                  >
                    {tabTitle()}
                  </span>

                  <Show when={isExited()}>
                    <span class="text-[10px] text-[var(--text-muted)] shrink-0">
                      {i18n.t('terminal.exitedBadge')}
                    </span>
                  </Show>

                  <button
                    type="button"
                    data-testid={`terminal-tab-close-${tab.index}`}
                    title={i18n.t('terminal.closeTab')}
                    aria-label={i18n.t('terminal.closeTab')}
                    class={`ml-auto p-0.5 rounded-md hover:bg-[var(--bg-hover-strong)] transition-all duration-150 shrink-0 ${
                      isActive()
                        ? 'opacity-65 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-80 hover:opacity-100'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTerminalTab(tab.id)
                    }}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              )
            }}
          </For>
        </div>

        <div class="shrink-0 h-full flex items-center gap-0.5 px-1.5">
          <button
            type="button"
            data-testid="terminal-new-tab"
            title={i18n.t('terminal.newTab')}
            aria-label={i18n.t('terminal.newTab')}
            class="p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-150"
            onClick={() => manager.createTab()}
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="terminal-hide-panel"
            title={i18n.t('terminal.hidePanel')}
            aria-label={i18n.t('terminal.hidePanel')}
            class="p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-150"
            onClick={() => panelState.setVisible(false)}
          >
            <ChevronDown class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div class="relative flex-1 min-h-0 flex">
        <For each={manager.tabs()}>
          {(tab) => (
            <TerminalPane
              scope={props.scope}
              tab={tab}
              active={manager.activeTab()?.id === tab.id}
              panelVisible={panelState.visible()}
              isPanelActive={isTerminalActive()}
              themeId={themeId()}
              appearance={appearance()}
            />
          )}
        </For>
      </div>
    </div>
  )
}
