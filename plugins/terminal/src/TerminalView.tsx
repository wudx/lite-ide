import type { ProjectScope } from '@lite-ide/kernel'
import { getI18n, PanelStateKey, ThemeStateKey } from '@lite-ide/workbench'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import TriangleAlert from 'lucide-solid/icons/triangle-exclamation-point'
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TERMINAL_PANEL_ID, TerminalStoreKey } from './terminal-store'

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

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function buildTerminalTheme(appearance: 'dark' | 'light') {
  const palette = appearance === 'dark' ? DARK_ANSI : LIGHT_ANSI
  return {
    foreground: cssVar('--text-primary', appearance === 'dark' ? '#d4d4d4' : '#333333'),
    // xterm viewport paints an opaque background, so mirror the panel card
    // color directly instead of relying on 'transparent'.
    background: cssVar('--bg-sidebar', appearance === 'dark' ? '#1e2229' : '#fdf6e3'),
    cursor: cssVar('--accent', appearance === 'dark' ? '#61afef' : '#2e5f9e'),
    cursorAccent: cssVar('--bg-sidebar', '#1e2229'),
    selectionBackground: appearance === 'dark' ? 'rgba(148, 163, 184, 0.30)' : 'rgba(100, 116, 139, 0.28)',
    ...palette,
  }
}

/**
 * Bottom-panel terminal view. Owns the xterm.js instance for the project's
 * TerminalStore; the PTY session outlives visibility toggles because the
 * host keeps this component mounted (display:none) while the project is warm.
 */
export function TerminalView(props: { scope: ProjectScope }) {
  const i18n = getI18n(props.scope)
  const store = props.scope.get(TerminalStoreKey)
  const panelState = props.scope.get(PanelStateKey)
  const themeState = props.scope.tryGet(ThemeStateKey)

  const appearance = () => themeState?.appearance() ?? 'dark'

  let hostRef: HTMLDivElement | undefined
  const [termReady, setTermReady] = createSignal(false)
  let term: Terminal | null = null
  let fitAddon: FitAddon | null = null
  let observer: ResizeObserver | null = null

  function fitIfVisible(): void {
    if (!term || !fitAddon || !hostRef) return
    if (hostRef.clientWidth === 0 || hostRef.clientHeight === 0) return
    try {
      fitAddon.fit()
      store.resize(term.cols, term.rows)
      // 懒启动：只有面板真实可见（有布局尺寸）才拉起 shell——热项目在后台
      // display:none 保活时挂载本视图但不占 shell 进程；ResizeObserver 在
      // 面板首次展示时触发这里的 start。
      if (store.status() === 'idle') {
        void store.start(Math.max(term.cols, 20), Math.max(term.rows, 6))
      }
    } catch {
      // fit() can throw while the host is mid-layout; the observer retries.
    }
  }

  onMount(() => {
    const created = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 2000,
      theme: buildTerminalTheme(appearance()),
    })
    term = created
    fitAddon = new FitAddon()
    created.loadAddon(fitAddon)
    created.open(hostRef!)
    setTermReady(true)

    const unsubOutput = store.onOutput((bytes) => {
      created.write(bytes)
    })
    const unsubExit = store.onExit((code) => {
      created.write(`\r\n\x1b[2m${i18n.t('terminal.restartHint', { code })}\x1b[0m\r\n`)
    })
    created.onData((data) => {
      store.write(data)
    })

    // First layout pass: fit and lazily spawn when the panel is visible.
    const spawnRaf = requestAnimationFrame(() => {
      fitIfVisible()
    })

    observer = new ResizeObserver(() => fitIfVisible())
    observer.observe(hostRef!)

    onCleanup(() => {
      cancelAnimationFrame(spawnRaf)
      unsubOutput()
      unsubExit()
      observer?.disconnect()
      observer = null
      created.dispose()
      term = null
      fitAddon = null
    })
  })

  // Re-fit after the panel reopens (display:none → flex invalidates layout);
  // while hidden the fit is skipped, so the session keeps its cell geometry.
  createEffect(() => {
    const visible = panelState.visible()
    if (!termReady() || !visible) return
    const rafId = requestAnimationFrame(() => fitIfVisible())
    onCleanup(() => cancelAnimationFrame(rafId))
  })

  // Track theme appearance so terminal colors follow theme switches.
  createEffect(() => {
    const nextAppearance = appearance()
    if (!termReady() || !term) return
    term.options.theme = buildTerminalTheme(nextAppearance)
  })

  function restart() {
    if (!term) return
    term.reset()
    fitIfVisible()
    void store.start(Math.max(term.cols, 20), Math.max(term.rows, 6))
  }

  function retrySpawn() {
    if (!term) return
    // Spawn failed (status back to idle + error banner): clear the error and
    // try again with the current fitted geometry.
    void store.start(Math.max(term.cols, 20), Math.max(term.rows, 6))
  }

  const isTerminalActive = () => panelState.activePanelId() === TERMINAL_PANEL_ID

  return (
    <div
      class="relative flex-1 min-h-0 flex"
      data-testid={`panel-view-${TERMINAL_PANEL_ID}`}
      onMouseUp={() => {
        // Click selects text by default; focus the shell when nothing is selected.
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed) {
          if (isTerminalActive()) term?.focus()
        }
      }}
    >
      <div ref={(el) => (hostRef = el)} class="liteide-terminal-host" />

      <Show when={store.status() === 'starting'}>
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span class="text-xs text-[var(--text-muted)] animate-pulse">
            {i18n.t('terminal.starting')}
          </span>
        </div>
      </Show>

      <Show when={store.status() === 'exited'}>
        <button
          type="button"
          data-testid="terminal-restart"
          title={i18n.t('terminal.restartHint', { code: store.exitCode() ?? -1 })}
          class="absolute top-1.5 right-3 z-10 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-[var(--bg-surface)] border border-[var(--border-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] shadow-sm transition-all duration-150"
          onClick={restart}
        >
          <RotateCcw class="w-3 h-3" />
          <span>{i18n.t('terminal.restart')}</span>
        </button>
      </Show>

      <Show when={store.status() === 'unsupported'}>
        <div class="absolute inset-0 flex items-center justify-center p-4">
          <div class="flex items-start gap-2 max-w-md text-xs text-[var(--text-secondary)]">
            <TriangleAlert class="w-4 h-4 shrink-0 text-[var(--warning-icon)]" />
            <span>{i18n.t('terminal.unsupported')}</span>
          </div>
        </div>
      </Show>

      <Show when={store.error()}>
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
