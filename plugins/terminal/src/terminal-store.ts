import { createServiceKey, moveWithin } from '@lite-ide/kernel'
import type { PanelStateService } from '@lite-ide/workbench'
import type { TerminalEvent, WorkspaceBackend } from '@lite-ide/protocol'
import { batch, createMemo, createSignal, type Accessor } from 'solid-js'

export type TerminalStatus =
  /** Backend has no terminal capability (custom backends). */
  | 'unsupported'
  /** No session yet; ready to spawn. */
  | 'idle'
  | 'starting'
  | 'ready'
  /** Session process ended (exit event received) — restartable. */
  | 'exited'

export interface TerminalStore {
  readonly status: Accessor<TerminalStatus>
  readonly error: Accessor<string | null>
  readonly exitCode: Accessor<number | null>
  readonly shellLabel: Accessor<string>
  /** Registers the decoded-output sink; call before start(). */
  onOutput(handler: (bytes: Uint8Array) => void): () => void
  /** Registers the exit sink (also fired after kill()). */
  onExit(handler: (code: number) => void): () => void
  /** Spawns a session; no-op while one is starting or ready. */
  start(cols: number, rows: number): Promise<void>
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Kills the running session; the exit event settles the status. */
  kill(): Promise<void>
  /** Idempotent teardown used by scope disposal. */
  dispose(): void
}

export interface TerminalTabSession {
  readonly id: string
  readonly index: number
  readonly store: TerminalStore
}

export interface TerminalManagerStore {
  readonly tabs: Accessor<readonly TerminalTabSession[]>
  readonly activeTabId: Accessor<string | null>
  readonly activeTab: Accessor<TerminalTabSession | undefined>
  readonly supported: boolean
  createTab(): TerminalTabSession
  selectTab(id: string): void
  closeTab(id: string): void
  moveTab(fromIndex: number, toIndex: number): void
  ensureDefaultTab(): TerminalTabSession
  dispose(): void
}

export const TerminalStoreKey = createServiceKey<TerminalManagerStore>('plugin.terminal.store')

export const TERMINAL_PANEL_ID = 'terminal'

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function createTerminalStore(projectId: string, backend: WorkspaceBackend): TerminalStore {
  const [status, setStatus] = createSignal<TerminalStatus>(
    backend.terminalSpawn ? 'idle' : 'unsupported',
  )
  const [error, setError] = createSignal<string | null>(null)
  const [exitCode, setExitCode] = createSignal<number | null>(null)
  const [shellLabel, setShellLabel] = createSignal('')

  let outputHandler: ((bytes: Uint8Array) => void) | null = null
  let exitHandler: ((code: number) => void) | null = null
  let sessionId: string | null = null
  let disposed = false
  let startSeq = 0

  function handleEvent(event: TerminalEvent) {
    if (disposed) return
    if (event.type === 'data') {
      outputHandler?.(base64ToBytes(event.base64))
      return
    }
    sessionId = null
    setStatus('exited')
    setExitCode(event.code)
    exitHandler?.(event.code)
  }

  function abandonPending(handle: { sessionId: string } | undefined): void {
    if (!handle || !backend.terminalKill) return
    void backend.terminalKill(handle.sessionId).catch(() => {
      // Session leak on a dying backend is not actionable here.
    })
  }

  const store: TerminalStore = {
    status,
    error,
    exitCode,
    shellLabel,

    onOutput(handler) {
      outputHandler = handler
      return () => {
        if (outputHandler === handler) outputHandler = null
      }
    },

    onExit(handler) {
      exitHandler = handler
      return () => {
        if (exitHandler === handler) exitHandler = null
      }
    },

    start(cols, rows) {
      if (!backend.terminalSpawn) {
        setStatus('unsupported')
        return Promise.resolve()
      }
      const current = status()
      if (current === 'starting' || current === 'ready') return Promise.resolve()
      if (disposed) return Promise.resolve()

      const seq = ++startSeq
      setStatus('starting')
      setError(null)
      setExitCode(null)
      return backend.terminalSpawn(projectId, { cols, rows, onEvent: handleEvent }).then(
        (handle) => {
          if (seq !== startSeq || disposed) {
            abandonPending(handle)
            return
          }
          sessionId = handle.sessionId
          setShellLabel(handle.shellLabel)
          setStatus('ready')
        },
        (err) => {
          if (seq !== startSeq || disposed) return
          setStatus('idle')
          setError(err instanceof Error ? err.message : String(err))
        },
      )
    },

    write(data) {
      const id = sessionId
      if (!id || !backend.terminalWrite) return
      void backend.terminalWrite(id, data).catch(() => {
        // Input errors surface as a dead shell; exit handling covers recovery.
      })
    },

    resize(cols, rows) {
      const id = sessionId
      if (!id || !backend.terminalResize) return
      void backend.terminalResize(id, cols, rows).catch(() => {
        // Resize is cosmetic; the next fit retries.
      })
    },

    async kill() {
      const id = sessionId
      sessionId = null
      if (!id || !backend.terminalKill) return
      try {
        await backend.terminalKill(id)
      } catch {
        // Already gone on the backend; the exit event will settle the status.
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      outputHandler = null
      exitHandler = null
      const id = sessionId
      sessionId = null
      if (id && backend.terminalKill) {
        void backend.terminalKill(id).catch(() => {
          // Best-effort teardown during scope disposal.
        })
      }
    },
  }

  return store
}

export function createTerminalManager(
  projectId: string,
  backend: WorkspaceBackend,
): TerminalManagerStore {
  let idSeq = 0
  let nextIndex = 1
  let disposed = false

  function makeTab(currentLength: number): TerminalTabSession {
    const index = currentLength === 0 ? (nextIndex = 1) : ++nextIndex
    return {
      id: `term-tab-${++idSeq}`,
      index,
      store: createTerminalStore(projectId, backend),
    }
  }

  // 默认预置 1 个 idle 页签：热项目保活期间不拉起 PTY，展开面板时再由视图懒启动。
  const initialTab = makeTab(0)
  const [tabs, setTabs] = createSignal<readonly TerminalTabSession[]>([initialTab])
  const [activeTabId, setActiveTabId] = createSignal<string | null>(initialTab.id)
  const activeTab = createMemo(() => {
    const id = activeTabId()
    return tabs().find((tab) => tab.id === id) ?? tabs()[0]
  })

  function createTab(): TerminalTabSession {
    const current = tabs()
    const tab = makeTab(current.length)
    if (disposed) {
      tab.store.dispose()
      return tab
    }
    batch(() => {
      setTabs([...current, tab])
      setActiveTabId(tab.id)
    })
    return tab
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    supported: Boolean(backend.terminalSpawn),

    createTab,

    selectTab(id: string) {
      if (disposed) return
      if (tabs().some((tab) => tab.id === id)) {
        setActiveTabId(id)
      }
    },

    closeTab(id: string) {
      if (disposed) return
      const current = tabs()
      const idx = current.findIndex((tab) => tab.id === id)
      if (idx === -1) return

      const target = current[idx]
      const nextTabs = current.filter((tab) => tab.id !== id)
      batch(() => {
        setTabs(nextTabs)
        if (activeTabId() === id) {
          const fallback = nextTabs[idx] ?? nextTabs[idx - 1]
          setActiveTabId(fallback ? fallback.id : null)
        }
      })
      target.store.dispose()
    },

    moveTab(fromIndex: number, toIndex: number) {
      if (disposed) return
      setTabs((prev) => moveWithin(prev, fromIndex, toIndex) ?? prev)
    },

    ensureDefaultTab(): TerminalTabSession {
      const existing = activeTab()
      if (existing) return existing
      return createTab()
    },

    dispose() {
      if (disposed) return
      disposed = true
      const current = tabs()
      batch(() => {
        setTabs([])
        setActiveTabId(null)
      })
      for (const tab of current) {
        tab.store.dispose()
      }
    },
  }
}

/**
 * Shared toggle semantics for the status bar item and the `terminal.toggle`
 * command: opening always focuses the terminal tab (and ensures at least one
 * terminal session tab exists); toggling hides only when the terminal panel
 * is already active.
 */
export function toggleTerminalPanel(
  panelState: PanelStateService,
  panelId = TERMINAL_PANEL_ID,
  manager?: TerminalManagerStore,
): void {
  if (!panelState.visible()) {
    manager?.ensureDefaultTab()
    panelState.setVisible(true)
    panelState.setActivePanelId(panelId)
    return
  }
  if (panelState.activePanelId() === panelId) {
    panelState.setVisible(false)
    return
  }
  manager?.ensureDefaultTab()
  panelState.setActivePanelId(panelId)
}
