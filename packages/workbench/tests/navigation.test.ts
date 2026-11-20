import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend, MOCK_DEMO_PATHS } from '@lite-ide/protocol'
import { createNavigationService } from '../src/navigation'
import { createProjectSelection } from '../src/services'
import { createSymbolIndexService } from '../src/symbol-index'

describe('createNavigationService', () => {
  let backend = createMockBackend()
  let projectId = ''

  beforeEach(async () => {
    backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
    projectId = info.id
  })

  function setup() {
    const selection = createProjectSelection(projectId, backend)
    const index = createSymbolIndexService(backend, projectId)
    return { selection, index, nav: createNavigationService(selection, index) }
  }

  it('gotoDefinition with no cursor opens the guidance panel', async () => {
    const { nav } = setup()
    await nav.gotoDefinition()
    const state = nav.panel()
    expect(state?.notice).toBe('noCursor')
    expect(state?.mode).toBe('definitions')
  })

  it('gotoDefinition jumps straight to a unique definition and reveals it', async () => {
    const { nav } = setup()
    // Cursor sits on the `MemoryFileStore` usage inside src/App.tsx.
    nav.setCursor({ relPath: 'src/App.tsx', line: 6, column: 10, word: 'MemoryFileStore' })
    await nav.gotoDefinition()

    expect(nav.panel()).toBeNull()
    expect(nav.revealRequest()?.relPath).toBe('src/services.ts')
    expect(nav.revealRequest()?.line).toBe(12)
  })

  it('gotoDefinition lists candidates when several definitions exist', async () => {
    // Rust demo: `visit` is defined in the trait and again in the impl block.
    const rustInfo = await backend.openProject(MOCK_DEMO_PATHS[1], () => {})
    const selection = createProjectSelection(rustInfo.id, backend)
    const index = createSymbolIndexService(backend, rustInfo.id)
    const nav = createNavigationService(selection, index)

    nav.setCursor({ relPath: 'src/scanner.rs', line: 15, column: 20, word: 'visit' })
    await nav.gotoDefinition()

    const state = nav.panel()
    expect(state?.mode).toBe('definitions')
    expect(state?.locations.length).toBe(2)
    expect(state?.locations.every((l) => l.isDefinition)).toBe(true)
  })

  it('gotoDefinition on an unknown symbol opens the empty panel message', async () => {
    const { nav } = setup()
    nav.setCursor({ relPath: 'src/kernel.ts', line: 1, column: 1, word: 'missingSymbol' })
    await nav.gotoDefinition()
    const state = nav.panel()
    expect(state?.mode).toBe('definitions')
    expect(state?.locations).toEqual([])
    expect(state?.symbol).toBe('missingSymbol')
  })

  it('findReferences opens the panel with occurrences, current file first', async () => {
    const { nav } = setup()
    nav.setCursor({ relPath: 'src/services.ts', line: 3, column: 15, word: 'createServiceKey' })
    await nav.findReferences()

    const state = nav.panel()
    expect(state?.mode).toBe('references')
    expect(state?.loading).toBe(false)
    expect(state?.locations.length).toBeGreaterThanOrEqual(2)

    const relPaths = state?.locations.map((l) => l.relPath) ?? []
    expect(relPaths[0]).toBe('src/services.ts')
    expect(relPaths).toContain('src/kernel.ts')

    const def = state?.locations.find((l) => l.isDefinition)
    expect(def?.relPath).toBe('src/kernel.ts')
  })

  it('findReferences without a cursor word shows guidance', async () => {
    const { nav } = setup()
    nav.setCursor({ relPath: 'src/kernel.ts', line: 1, column: 1, word: null })
    await nav.findReferences()
    expect(nav.panel()?.notice).toBe('noCursor')
  })

  it('gotoImplementation jumps from a TS interface to its class', async () => {
    const { nav } = setup()
    // Cursor on `FileStore` in the interface declaration line of services.ts.
    nav.setCursor({ relPath: 'src/services.ts', line: 3, column: 18, word: 'FileStore' })
    await nav.gotoImplementation()

    expect(nav.panel()).toBeNull()
    expect(nav.revealRequest()?.relPath).toBe('src/services.ts')
    expect(nav.revealRequest()?.line).toBe(12)
  })

  it('gotoImplementation falls back to same-name definitions elsewhere', async () => {
    const { nav } = setup()
    // `visit`-style toggle: from the trait method to its impl method (Rust demo).
    const rustInfo = await backend.openProject(MOCK_DEMO_PATHS[1], () => {})
    const selection = createProjectSelection(rustInfo.id, backend)
    const index = createSymbolIndexService(backend, rustInfo.id)
    const rustNav = createNavigationService(selection, index)

    // Cursor on `fn visit` inside the trait (src/scanner.rs line 2).
    rustNav.setCursor({ relPath: 'src/scanner.rs', line: 2, column: 8, word: 'visit' })
    await rustNav.gotoImplementation()

    // Fallback yields the impl-block `fn visit` (line 10) — unique, so it
    // jumps straight instead of opening the panel.
    expect(rustNav.panel()).toBeNull()
    expect(rustNav.revealRequest()?.relPath).toBe('src/scanner.rs')
    expect(rustNav.revealRequest()?.line).toBe(10)
  })

  it('revealLocation opens the target file and emits a reveal request', async () => {
    const { nav, selection } = setup()
    await nav.revealLocation('src/services.ts', 9, 7)

    expect(selection.selectedPath()).toBe('src/services.ts')
    const request = nav.revealRequest()
    expect(request?.relPath).toBe('src/services.ts')
    expect(request?.line).toBe(9)
    expect(request?.column).toBe(7)
    expect(request?.seq).toBeGreaterThan(0)
  })

  it('closePanel clears panel state', async () => {
    const { nav } = setup()
    nav.setCursor({ relPath: 'src/kernel.ts', line: 1, column: 1, word: 'createServiceKey' })
    await nav.findReferences()
    expect(nav.panel()).not.toBeNull()
    nav.closePanel()
    expect(nav.panel()).toBeNull()
  })
})
