import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend, MOCK_DEMO_PATHS } from '@lite-ide/protocol'
import {
  createConfirmDialogService,
  createEditorBufferService,
  createNavigationService,
  createProjectSelection,
  createSymbolIndexService,
} from '@lite-ide/workbench'
import { createSearchStore } from '../src/search-store'

describe('createSearchStore', () => {
  let backend = createMockBackend()
  let projectId = ''

  beforeEach(async () => {
    backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
    projectId = info.id
  })

  function setupStore() {
    const selection = createProjectSelection(projectId, backend)
    const buffers = createEditorBufferService(projectId, backend)
    const symbolIndex = createSymbolIndexService(backend, projectId, {
      getContentOverride: (relPath) => buffers.getBuffer(relPath)?.content ?? null,
    })
    const navigation = createNavigationService(selection, symbolIndex)
    const dialogs = createConfirmDialogService()
    const store = createSearchStore(projectId, {
      backend,
      selection,
      buffers,
      navigation,
      dialogs,
      t: (key, params) => `${key}${params ? JSON.stringify(params) : ''}`,
    })
    return { store, selection, buffers, navigation, dialogs }
  }

  it('searches across project files and navigates to a match', async () => {
    const { store, selection, navigation } = setupStore()
    store.setQuery('createServiceKey')
    await store.runSearchNow()

    expect(store.error()).toBeNull()
    expect(store.totalFiles()).toBe(3)
    expect(store.totalMatches()).toBe(6)
    expect(store.results().map((r) => r.relPath)).toEqual([
      'src/kernel.ts',
      'src/long-reference.ts',
      'src/services.ts',
    ])

    const targetMatch = store.results()[1]!.matches[1]!
    await store.openMatch(targetMatch)
    expect(selection.selectedPath()).toBe('src/long-reference.ts')
    expect(navigation.revealRequest()).toMatchObject({
      relPath: 'src/long-reference.ts',
      line: targetMatch.line,
      column: targetMatch.column,
    })
    store.dispose()
  })

  it('filters by include/exclude globs and respects useIgnoreFiles', async () => {
    const { store } = setupStore()
    store.setQuery('createServiceKey')
    store.setFilesToInclude('src/services.ts')
    await store.runSearchNow()
    expect(store.results().map((r) => r.relPath)).toEqual(['src/services.ts'])

    store.setFilesToInclude('')
    store.setFilesToExclude('src/long-reference.ts')
    await store.runSearchNow()
    expect(store.results().map((r) => r.relPath)).toEqual(['src/kernel.ts', 'src/services.ts'])

    // dist/bundle.log is gitignored in the demo template; disabling ignore files reveals it.
    store.setFilesToExclude('')
    store.setQuery('bundle')
    await store.runSearchNow()
    const withoutIgnored = store.results().map((r) => r.relPath)
    expect(withoutIgnored).not.toContain('dist/bundle.log')

    store.toggleUseIgnoreFiles()
    await store.runSearchNow()
    expect(store.results().map((r) => r.relPath)).toContain('dist/bundle.log')
    store.dispose()
  })

  it('searches live unsaved editor buffers', async () => {
    const { store, buffers } = setupStore()
    const buf = await buffers.ensureLoaded('README.md')
    buffers.updateContent('README.md', `${buf.content}\nUNIQUE_UNSAVED_TOKEN_42\n`, buf.lineCount + 1)

    store.setQuery('UNIQUE_UNSAVED_TOKEN_42')
    await store.runSearchNow()

    expect(store.totalFiles()).toBe(1)
    expect(store.totalMatches()).toBe(1)
    expect(store.results()[0]?.relPath).toBe('README.md')
    store.dispose()
  })

  it('replaces single matches, per-file matches, and confirms replaceAll', async () => {
    const { store, buffers, dialogs } = setupStore()
    store.setQuery('createServiceKey')
    await store.runSearchNow()

    // 1. Replace single match in src/kernel.ts
    const firstMatch = store.results()[0]!.matches[0]!
    store.setReplaceText('createTokenKey')
    await store.replaceMatch(firstMatch)

    const kernelText = await backend.readText(projectId, 'src/kernel.ts')
    expect(kernelText.content).toContain('export function createTokenKey<T>')
    expect(store.results().map((r) => r.relPath)).not.toContain('src/kernel.ts')

    // 2. Replace all in src/services.ts (which also has an open clean buffer)
    const beforeBuf = await buffers.ensureLoaded('src/services.ts')
    const beforeRev = beforeBuf.diskRevision
    await store.replaceInFile('src/services.ts')
    const servicesText = await backend.readText(projectId, 'src/services.ts')
    expect(servicesText.content).not.toContain('createServiceKey')
    expect(buffers.getBuffer('src/services.ts')?.dirty).toBe(false)
    expect(buffers.getBuffer('src/services.ts')?.content).toContain('createTokenKey')
    // diskRevision must advance so mounted CodeMirror views resync immediately.
    expect(buffers.getBuffer('src/services.ts')?.diskRevision).toBe(beforeRev + 1)

    // 3. Replace all remaining with confirmation dialog (cancel first, then confirm)
    const cancelPromise = store.replaceAll()
    await Promise.resolve()
    expect(dialogs.current()).not.toBeNull()
    dialogs.dismiss('cancel')
    await cancelPromise
    expect(store.totalMatches()).toBe(3)

    const confirmPromise = store.replaceAll()
    await Promise.resolve()
    dialogs.dismiss('replace')
    await confirmPromise
    expect(store.totalMatches()).toBe(0)
    const longRefText = await backend.readText(projectId, 'src/long-reference.ts')
    expect(longRefText.content).not.toContain('createServiceKey')
    expect(longRefText.content).toContain('createTokenKey')

    store.dispose()
  })

  it('invalidates cached files on fs delta events', async () => {
    const { store } = setupStore()
    store.setQuery('FRESH_FILE_TOKEN')
    await store.runSearchNow()
    expect(store.totalMatches()).toBe(0)

    await backend.createFile(projectId, 'notes.txt')
    await backend.writeText(projectId, 'notes.txt', 'hello FRESH_FILE_TOKEN world')
    store.handleFsDelta({
      projectId,
      affectedDirs: [''],
      affectedPaths: ['notes.txt'],
      overflow: false,
    })

    await store.runSearchNow()
    expect(store.results().map((r) => r.relPath)).toEqual(['notes.txt'])
    store.dispose()
  })

  it('bypasses stale contentCache during mutation and surfaces read-only errors', async () => {
    const { store, buffers } = setupStore()
    store.setQuery('activateDemo')
    await store.runSearchNow()
    expect(store.totalMatches()).toBe(1)

    // Simulate external disk update before FsDelta arrives.
    await backend.writeText(projectId, 'src/kernel.ts', 'export function activateDemo() {}\n// external-keep\n')
    store.setReplaceText('bootDemo')
    await store.replaceInFile('src/kernel.ts')

    const onDisk = await backend.readText(projectId, 'src/kernel.ts')
    expect(onDisk.content).toContain('bootDemo')
    expect(onDisk.content).toContain('// external-keep')

    // Read-only buffer surfaces error instead of failing silently.
    await backend.createFile(projectId, 'ro.txt')
    await backend.writeText(projectId, 'ro.txt', 'token_ro')
    store.handleFsDelta({
      projectId,
      affectedDirs: [''],
      affectedPaths: ['ro.txt'],
      overflow: false,
    })
    await buffers.ensureLoaded('ro.txt', 2) // truncated => readOnly
    store.setQuery('token_ro')
    await store.runSearchNow()
    await store.replaceInFile('ro.txt')
    expect(store.error()).toContain('ro.txt')

    store.dispose()
  })
})
