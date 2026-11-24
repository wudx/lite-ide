import type { TerminalEvent, TerminalSessionHandle, TerminalSpawnOptions } from '@lite-ide/protocol'
import { createPanelState } from '@lite-ide/workbench'
import { describe, expect, it } from 'vitest'
import {
  createTerminalManager,
  createTerminalStore,
  toggleTerminalPanel,
} from '../src/terminal-store'

interface FakeBackendCalls {
  spawnCols: number[]
  spawnRows: number[]
  writes: string[]
  resizes: Array<[number, number]>
  kills: string[]
}

function createFakeBackend(options?: {
  spawnError?: Error
  noCapability?: boolean
  /** Spawns return manually-resolved promises (see resolveSpawn). */
  deferSpawn?: boolean
}) {
  const calls: FakeBackendCalls = {
    spawnCols: [],
    spawnRows: [],
    writes: [],
    resizes: [],
    kills: [],
  }
  let pushEvent: ((event: TerminalEvent) => void) | null = null
  const pendingSpawns: Array<(handle: TerminalSessionHandle) => void> = []
  let nextId = 0

  const backend = {
    kind: 'mock' as const,
    openProject: async () => {
      throw new Error('not used')
    },
    closeProject: async () => {},
    listDir: async () => [],
    statPreview: async () => {
      throw new Error('not used')
    },
    readText: async () => {
      throw new Error('not used')
    },
    writeText: async () => {
      throw new Error('not used')
    },
    createFile: async () => {
      throw new Error('not used')
    },
    createDir: async () => {
      throw new Error('not used')
    },
    renamePath: async () => {
      throw new Error('not used')
    },
    deletePath: async () => {},
    pickFolder: async () => null,
    ...(options?.noCapability
      ? {}
      : {
          terminalSpawn(
            projectId: string,
            spawnOptions: TerminalSpawnOptions,
          ): Promise<TerminalSessionHandle> {
            void projectId
            if (options?.spawnError) return Promise.reject(options.spawnError)
            calls.spawnCols.push(spawnOptions.cols)
            calls.spawnRows.push(spawnOptions.rows)
            pushEvent = spawnOptions.onEvent
            const handle = { sessionId: `term-${++nextId}`, shellLabel: 'Fake Shell' }
            if (options?.deferSpawn) {
              return new Promise<TerminalSessionHandle>((resolve) => {
                pendingSpawns.push(resolve)
              })
            }
            return Promise.resolve(handle)
          },
          async terminalWrite(sessionId: string, data: string) {
            void sessionId
            calls.writes.push(data)
          },
          async terminalResize(sessionId: string, cols: number, rows: number) {
            void sessionId
            calls.resizes.push([cols, rows])
          },
          async terminalKill(sessionId: string) {
            calls.kills.push(sessionId)
          },
        }),
  }

  return {
    backend: backend as never,
    calls,
    /** Delivers a backend event like the PTY pump would. */
    emit(event: TerminalEvent) {
      if (!pushEvent) throw new Error('spawn not called yet')
      pushEvent(event)
    },
    /** Resolves the nth deferred spawn call (FIFO). */
    resolveSpawn(handle: TerminalSessionHandle) {
      const resolve = pendingSpawns.shift()
      if (!resolve) throw new Error('no pending spawn')
      resolve(handle)
    },
  }
}

function decodeChunks(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])))
}

describe('TerminalStore', () => {
  it('marks unsupported backends and never spawns', async () => {
    const { backend } = createFakeBackend({ noCapability: true })
    const store = createTerminalStore('p1', backend)
    expect(store.status()).toBe('unsupported')

    await store.start(80, 24)
    expect(store.status()).toBe('unsupported')
  })

  it('streams decoded output, records exit codes, and routes writes', async () => {
    const { backend, calls, emit } = createFakeBackend()
    const store = createTerminalStore('p1', backend)
    const chunks: Uint8Array[] = []
    store.onOutput((bytes) => chunks.push(bytes))

    await store.start(100, 30)
    expect(store.status()).toBe('ready')
    expect(store.shellLabel()).toBe('Fake Shell')
    expect(calls.spawnCols).toEqual([100])
    expect(calls.spawnRows).toEqual([30])

    emit({
      type: 'data',
      base64: btoa(new TextEncoder().encode('你好 LiteIDE').reduce((s, b) => s + String.fromCharCode(b), '')),
    })
    expect(decodeChunks(chunks)).toBe('你好 LiteIDE')

    store.write('ls\r')
    expect(calls.writes).toEqual(['ls\r'])

    store.resize(90, 20)
    expect(calls.resizes).toEqual([[90, 20]])

    const exits: number[] = []
    store.onExit((code) => exits.push(code))
    emit({ type: 'exit', code: 3 })
    expect(store.status()).toBe('exited')
    expect(store.exitCode()).toBe(3)
    expect(exits).toEqual([3])
  })

  it('reports spawn failures and returns to a restartable idle state', async () => {
    const { backend } = createFakeBackend({ spawnError: new Error('pty boom') })
    const store = createTerminalStore('p1', backend)

    await store.start(80, 24)
    expect(store.status()).toBe('idle')
    expect(store.error()).toBe('pty boom')

    // The failure path leaves the store startable again.
    const retry = createFakeBackend()
    const store2 = createTerminalStore('p1', retry.backend)
    await store2.start(80, 24)
    expect(store2.status()).toBe('ready')
  })

  it('ignores concurrent starts while one is already in flight', async () => {
    const { backend, calls } = createFakeBackend()
    const store = createTerminalStore('p1', backend)

    const first = store.start(80, 24)
    const second = store.start(96, 32)
    await Promise.all([first, second])
    expect(calls.spawnCols).toEqual([80])
    expect(store.status()).toBe('ready')

    await store.start(80, 24)
    expect(calls.spawnCols).toEqual([80])
  })

  it('abandons stale spawn results so only the live session is adopted', async () => {
    const { backend, calls, emit, resolveSpawn } = createFakeBackend({ deferSpawn: true })
    const store = createTerminalStore('p1', backend)
    const chunks: Uint8Array[] = []
    store.onOutput((bytes) => chunks.push(bytes))

    const first = store.start(80, 24)
    expect(store.status()).toBe('starting')

    // Session 1 reports an exit before its spawn promise resolves; the next
    // start bumps the sequence, making the pending spawn stale.
    emit({ type: 'exit', code: 0 })
    expect(store.status()).toBe('exited')
    const second = store.start(96, 32)
    expect(store.status()).toBe('starting')
    expect(calls.spawnCols).toEqual([80, 96])

    // The stale resolve must be killed, never adopted.
    resolveSpawn({ sessionId: 'term-stale', shellLabel: 'Stale' })
    await first
    expect(calls.kills).toEqual(['term-stale'])

    resolveSpawn({ sessionId: 'term-live', shellLabel: 'Live' })
    await second
    expect(store.status()).toBe('ready')
    expect(store.shellLabel()).toBe('Live')

    emit({ type: 'data', base64: btoa('live') })
    expect(chunks.length).toBe(1)
    expect(calls.kills).toEqual(['term-stale'])
  })

  it('kills the pending spawn when disposed mid-start', async () => {
    const { backend, calls, resolveSpawn } = createFakeBackend({ deferSpawn: true })
    const store = createTerminalStore('p1', backend)

    const pending = store.start(80, 24)
    store.dispose()
    resolveSpawn({ sessionId: 'term-x', shellLabel: 'X' })
    await pending
    expect(calls.kills).toEqual(['term-x'])
  })

  it('kills the live session on kill() and dispose()', async () => {
    const { backend, calls } = createFakeBackend()
    const store = createTerminalStore('p1', backend)
    await store.start(80, 24)

    await store.kill()
    expect(calls.kills.length).toBe(1)
    // Exit event settles the status; without it the session is already gone.
    store.dispose()
    expect(calls.kills.length).toBe(1)

    const { backend: backend2, calls: calls2 } = createFakeBackend()
    const store2 = createTerminalStore('p1', backend2)
    await store2.start(80, 24)
    store2.dispose()
    expect(calls2.kills.length).toBe(1)
  })
})

describe('toggleTerminalPanel', () => {
  it('opens the panel focused on the terminal tab', () => {
    const state = createPanelState()
    toggleTerminalPanel(state)
    expect(state.visible()).toBe(true)
    expect(state.activePanelId()).toBe('terminal')
  })

  it('hides only while the terminal tab is active', () => {
    const state = createPanelState()
    toggleTerminalPanel(state)
    toggleTerminalPanel(state)
    expect(state.visible()).toBe(false)

    state.setVisible(true)
    state.setActivePanelId('other')
    toggleTerminalPanel(state)
    expect(state.visible()).toBe(true)
    expect(state.activePanelId()).toBe('terminal')
  })

  it('ensures a default terminal tab when opening after all tabs were closed', () => {
    const { backend } = createFakeBackend()
    const state = createPanelState()
    const manager = createTerminalManager('p1', backend)
    const first = manager.tabs()[0]
    manager.closeTab(first.id)
    expect(manager.tabs().length).toBe(0)

    toggleTerminalPanel(state, 'terminal', manager)
    expect(state.visible()).toBe(true)
    expect(manager.tabs().length).toBe(1)
    expect(manager.tabs()[0].index).toBe(1)
  })
})

describe('TerminalManagerStore', () => {
  it('starts with one idle tab and reflects backend capability', () => {
    const supported = createFakeBackend()
    const manager = createTerminalManager('p1', supported.backend)
    expect(manager.supported).toBe(true)
    expect(manager.tabs().length).toBe(1)
    expect(manager.tabs()[0].index).toBe(1)
    expect(manager.tabs()[0].store.status()).toBe('idle')
    expect(manager.activeTab()?.id).toBe(manager.tabs()[0].id)

    const unsupported = createFakeBackend({ noCapability: true })
    const manager2 = createTerminalManager('p1', unsupported.backend)
    expect(manager2.supported).toBe(false)
    expect(manager2.tabs()[0].store.status()).toBe('unsupported')
  })

  it('creates multiple tabs with incrementing indices and selects the new tab', async () => {
    const { backend } = createFakeBackend()
    const manager = createTerminalManager('p1', backend)
    const t1 = manager.tabs()[0]
    const t2 = manager.createTab()
    const t3 = manager.createTab()

    expect(manager.tabs().map((t) => t.index)).toEqual([1, 2, 3])
    expect(manager.activeTabId()).toBe(t3.id)

    manager.selectTab(t1.id)
    expect(manager.activeTabId()).toBe(t1.id)
    manager.selectTab('non-existent')
    expect(manager.activeTabId()).toBe(t1.id)

    // Each tab keeps an isolated store & session.
    await t1.store.start(80, 24)
    await t2.store.start(90, 24)
    expect(t1.store.status()).toBe('ready')
    expect(t2.store.status()).toBe('ready')
    expect(t3.store.status()).toBe('idle')
  })

  it('handles closing inactive, active, middle, tail, and last tabs cleanly', async () => {
    const { backend, calls } = createFakeBackend()
    const manager = createTerminalManager('p1', backend)
    const t1 = manager.tabs()[0]
    const t2 = manager.createTab()
    const t3 = manager.createTab()

    await t1.store.start(80, 24)
    await t2.store.start(80, 24)
    await t3.store.start(80, 24)

    // Active is t3; closing inactive t1 keeps t3 active and kills term-1.
    manager.closeTab(t1.id)
    expect(manager.tabs().map((t) => t.id)).toEqual([t2.id, t3.id])
    expect(manager.activeTabId()).toBe(t3.id)
    expect(calls.kills).toEqual(['term-1'])

    // Add t4 (index 4); select t2 and close it -> falls back to next tab t3.
    const t4 = manager.createTab()
    expect(t4.index).toBe(4)
    manager.selectTab(t2.id)
    manager.closeTab(t2.id)
    expect(manager.tabs().map((t) => t.id)).toEqual([t3.id, t4.id])
    expect(manager.activeTabId()).toBe(t3.id)

    // Select tail tab t4 and close it -> falls back to previous tab t3.
    manager.selectTab(t4.id)
    manager.closeTab(t4.id)
    expect(manager.tabs().map((t) => t.id)).toEqual([t3.id])
    expect(manager.activeTabId()).toBe(t3.id)

    // Close the last remaining tab -> empty list and null activeTabId.
    manager.closeTab(t3.id)
    expect(manager.tabs()).toEqual([])
    expect(manager.activeTabId()).toBeNull()
    expect(calls.kills).toEqual(['term-1', 'term-2', 'term-3'])

    // Next ensureDefaultTab resets numbering to 1.
    const reopened = manager.ensureDefaultTab()
    expect(reopened.index).toBe(1)
    expect(manager.tabs().map((t) => t.index)).toEqual([1])
    expect(manager.activeTabId()).toBe(reopened.id)
  })

  it('reorders tabs via moveTab without changing the active tab', () => {
    const { backend } = createFakeBackend()
    const manager = createTerminalManager('p1', backend)
    const t1 = manager.tabs()[0]
    const t2 = manager.createTab()
    const t3 = manager.createTab()
    manager.selectTab(t2.id)

    manager.moveTab(2, 0)
    expect(manager.tabs().map((t) => t.id)).toEqual([t3.id, t1.id, t2.id])
    expect(manager.activeTabId()).toBe(t2.id)

    // No-op on invalid/same index.
    manager.moveTab(1, 1)
    expect(manager.tabs().map((t) => t.id)).toEqual([t3.id, t1.id, t2.id])
  })

  it('disposes all spawned sessions on manager.dispose()', async () => {
    const { backend, calls } = createFakeBackend()
    const manager = createTerminalManager('p1', backend)
    const t1 = manager.tabs()[0]
    const t2 = manager.createTab()
    const t3 = manager.createTab()

    await t1.store.start(80, 24)
    await t3.store.start(80, 24)
    // t2 stayed idle so only 2 PTYs were started.
    expect(t2.store.status()).toBe('idle')

    manager.dispose()
    expect(calls.kills).toEqual(['term-1', 'term-2'])
    expect(manager.tabs()).toEqual([])
    expect(manager.activeTabId()).toBeNull()

    // Idempotent second dispose.
    manager.dispose()
    expect(calls.kills).toEqual(['term-1', 'term-2'])
  })
})
