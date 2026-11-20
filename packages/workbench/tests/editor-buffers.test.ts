import { createAppKernel, type KernelProjectHost } from '@lite-ide/kernel'
import type { DirEntry, FileMeta, FsDelta, TextPayload, WorkspaceBackend, WriteTextResult } from '@lite-ide/protocol'
import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import {
  parseSaveTarget,
  requestCloseAllTabs,
  requestCloseOtherTabs,
  requestCloseProject,
  requestCloseTab,
  requestCloseWindow,
  requestSaveFile,
  saveUntitledAs,
} from '../src/close-guards'
import { ConfirmDialogKey, createConfirmDialogService } from '../src/dialogs'
import { createEditorBufferService, EditorBufferKey } from '../src/editor-buffers'
import { createProjectSelection, createWorkbenchKernel, ProjectSelectionKey } from '../src/services'

interface TestFileRecord {
  content: string
  modifiedMs: number
  encoding?: string
  truncated?: boolean
}

function createControllableBackend(initialFiles: Record<string, TestFileRecord>) {
  const files = new Map<string, TestFileRecord>(
    Object.entries(initialFiles).map(([k, v]) => [k, { ...v }]),
  )
  const dirs = new Set<string>()
  let fsListener: ((delta: FsDelta) => void) | null = null
  let clock = 1000

  function dirExists(dirPath: string): boolean {
    if (dirPath === '') return true
    if (dirs.has(dirPath)) return true
    // Mirrors the mock backend: any file under the prefix implies the folder.
    for (const filePath of files.keys()) {
      if (filePath.startsWith(`${dirPath}/`)) return true
    }
    return false
  }

  function makeMeta(projectId: string, relPath: string, rec: TestFileRecord): FileMeta {
    const name = relPath.split('/').pop() ?? relPath
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    return {
      projectId,
      relPath,
      name,
      ext,
      size: new TextEncoder().encode(rec.content).length,
      modifiedMs: rec.modifiedMs,
      mime: ext === 'md' ? 'text/markdown' : 'text/typescript',
      isBinary: false,
      encoding: rec.encoding ?? 'utf-8',
    }
  }

  const backend: WorkspaceBackend = {
    kind: 'mock',
    async openProject(path, onFsEvent) {
      fsListener = onFsEvent
      return { id: 'p1', name: 'test-proj', rootPath: path }
    },
    async closeProject() {
      fsListener = null
    },
    async listDir(): Promise<DirEntry[]> {
      return []
    },
    async statPreview(projectId, relPath) {
      const rec = files.get(relPath)
      if (!rec) throw new Error(`File not found: ${relPath}`)
      return makeMeta(projectId, relPath, rec)
    },
    async readText(_projectId, relPath, maxBytes = 2 * 1024 * 1024): Promise<TextPayload> {
      const rec = files.get(relPath)
      if (!rec) throw new Error(`File not found: ${relPath}`)
      const bytes = new TextEncoder().encode(rec.content)
      const truncated = Boolean(rec.truncated && bytes.length > maxBytes) || rec.truncated === true
      return {
        content: rec.content,
        totalBytes: bytes.length,
        loadedBytes: Math.min(bytes.length, maxBytes),
        truncated,
        lineCount: rec.content ? rec.content.split('\n').length : 0,
        encoding: rec.encoding ?? 'utf-8',
      }
    },
    async writeText(projectId, relPath, content, encoding = 'utf-8'): Promise<WriteTextResult> {
      const rec = files.get(relPath)
      if (!rec) throw new Error(`File not found: ${relPath}`)
      clock += 10
      rec.content = content
      rec.modifiedMs = clock
      rec.encoding = encoding
      rec.truncated = false
      fsListener?.({
        projectId,
        affectedDirs: [''],
        affectedPaths: [relPath],
        overflow: false,
      })
      return {
        meta: makeMeta(projectId, relPath, rec),
        lineCount: content ? content.split('\n').length : 0,
        writtenBytes: new TextEncoder().encode(content).length,
      }
    },
    async createFile(projectId, relPath): Promise<FileMeta> {
      const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      if (!dirExists(parent)) {
        throw new Error(`Parent directory does not exist: ${parent}`)
      }
      if (files.has(relPath)) {
        throw new Error(`Path already exists: ${relPath}`)
      }
      clock += 10
      const rec: TestFileRecord = { content: '', modifiedMs: clock }
      files.set(relPath, rec)
      return makeMeta(projectId, relPath, rec)
    },
    async createDir(_projectId, relPath): Promise<DirEntry> {
      const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
      if (!dirExists(parent)) {
        throw new Error(`Parent directory does not exist: ${parent}`)
      }
      if (dirs.has(relPath) || files.has(relPath)) {
        throw new Error(`Path already exists: ${relPath}`)
      }
      dirs.add(relPath)
      return {
        name: relPath.split('/').pop() ?? relPath,
        relPath,
        isDir: true,
        size: 0,
        modifiedMs: clock,
        ignored: false,
        hidden: false,
      }
    },
    async renamePath(_projectId, oldRelPath, newRelPath): Promise<DirEntry> {
      const rec = files.get(oldRelPath)
      if (!rec) throw new Error('missing')
      files.delete(oldRelPath)
      files.set(newRelPath, rec)
      return {
        name: newRelPath.split('/').pop() ?? newRelPath,
        relPath: newRelPath,
        isDir: false,
        size: rec.content.length,
        modifiedMs: rec.modifiedMs,
        ignored: false,
        hidden: false,
      }
    },
    async deletePath(_projectId, relPath): Promise<void> {
      files.delete(relPath)
    },
    async pickFolder() {
      return null
    },
  }

  return {
    backend,
    files,
    dirs,
    externalModify(relPath: string, content: string) {
      clock += 100
      const rec = files.get(relPath)
      if (rec) {
        rec.content = content
        rec.modifiedMs = clock
      }
    },
    externalDelete(relPath: string) {
      files.delete(relPath)
    },
    emitDelta(affectedPaths: string[]): FsDelta {
      return {
        projectId: 'p1',
        affectedDirs: [''],
        affectedPaths,
        overflow: false,
      }
    },
  }
}

describe('EditorBufferService', () => {
  it('tracks dirty state accurately, clears on revert to savedContent, and saves cleanly', async () => {
    const env = createControllableBackend({
      'src/a.ts': { content: 'const a = 1', modifiedMs: 100 },
    })

    const { buffers, dispose } = createRoot((d) => ({
      buffers: createEditorBufferService('p1', env.backend),
      dispose: d,
    }))

    try {
      const loaded = await buffers.ensureLoaded('src/a.ts')
      expect(loaded.content).toBe('const a = 1')
      expect(loaded.dirty).toBe(false)

      buffers.updateContent('src/a.ts', 'const a = 2', 1)
      expect(buffers.isDirty('src/a.ts')).toBe(true)
      expect(buffers.dirtyCount()).toBe(1)

      // Simulates undo back to original disk content.
      buffers.updateContent('src/a.ts', 'const a = 1', 1)
      expect(buffers.isDirty('src/a.ts')).toBe(false)
      expect(buffers.hasDirtyFiles()).toBe(false)

      buffers.updateContent('src/a.ts', 'const a = 3\nconsole.log(a)', 2)
      expect(buffers.isDirty('src/a.ts')).toBe(true)

      const saved = await buffers.saveBuffer('src/a.ts')
      expect(saved).toBe(true)
      expect(buffers.isDirty('src/a.ts')).toBe(false)
      expect(env.files.get('src/a.ts')?.content).toBe('const a = 3\nconsole.log(a)')

      // Self-triggered FsDelta must not bump diskRevision or trigger conflict.
      const prevRev = buffers.getBuffer('src/a.ts')!.diskRevision
      await buffers.handleFsDelta(env.emitDelta(['src/a.ts']))
      expect(buffers.getBuffer('src/a.ts')!.diskRevision).toBe(prevRev)
      expect(buffers.getBuffer('src/a.ts')!.conflict).toBe('none')
    } finally {
      dispose()
    }
  })

  it('handles external clean reload, dirty modification conflict, and deletion conflict', async () => {
    const env = createControllableBackend({
      'src/clean.ts': { content: 'v1', modifiedMs: 100 },
      'src/dirty.ts': { content: 'local-base', modifiedMs: 100 },
    })

    const { buffers, dispose } = createRoot((d) => ({
      buffers: createEditorBufferService('p1', env.backend),
      dispose: d,
    }))

    try {
      await buffers.ensureLoaded('src/clean.ts')
      await buffers.ensureLoaded('src/dirty.ts')

      // Clean file externally modified -> silent reload and bump diskRevision.
      env.externalModify('src/clean.ts', 'v2-from-disk')
      await buffers.handleFsDelta(env.emitDelta(['src/clean.ts']))
      expect(buffers.getBuffer('src/clean.ts')?.content).toBe('v2-from-disk')
      expect(buffers.getBuffer('src/clean.ts')?.diskRevision).toBe(1)
      expect(buffers.getBuffer('src/clean.ts')?.dirty).toBe(false)

      // Dirty file externally modified -> mark conflict without clobbering edits.
      buffers.updateContent('src/dirty.ts', 'unsaved-edit', 1)
      env.externalModify('src/dirty.ts', 'external-edit')
      await buffers.handleFsDelta(env.emitDelta(['src/dirty.ts']))
      expect(buffers.getBuffer('src/dirty.ts')?.content).toBe('unsaved-edit')
      expect(buffers.getBuffer('src/dirty.ts')?.conflict).toBe('modified')

      // Overwrite disk resolves conflict with local content.
      expect(await buffers.overwriteConflict('src/dirty.ts')).toBe(true)
      expect(buffers.getBuffer('src/dirty.ts')?.conflict).toBe('none')
      expect(env.files.get('src/dirty.ts')?.content).toBe('unsaved-edit')

      // External delete -> mark deleted conflict, recreate & save restores file.
      buffers.updateContent('src/dirty.ts', 'recreated-content', 1)
      env.externalDelete('src/dirty.ts')
      await buffers.handleFsDelta(env.emitDelta(['src/dirty.ts']))
      expect(buffers.getBuffer('src/dirty.ts')?.conflict).toBe('deleted')

      expect(await buffers.overwriteConflict('src/dirty.ts')).toBe(true)
      expect(env.files.get('src/dirty.ts')?.content).toBe('recreated-content')
      expect(buffers.getBuffer('src/dirty.ts')?.conflict).toBe('none')
    } finally {
      dispose()
    }
  })

  it('protects truncated and unsupported-encoding files as read-only and supports rename/remove', async () => {
    const env = createControllableBackend({
      'big.txt': { content: 'partial', modifiedMs: 100, truncated: true },
      'u32.txt': { content: 'utf32', modifiedMs: 100, encoding: 'utf-32' },
      'dir/mod.ts': { content: 'export const x = 1', modifiedMs: 100 },
    })

    const { buffers, dispose } = createRoot((d) => ({
      buffers: createEditorBufferService('p1', env.backend),
      dispose: d,
    }))

    try {
      const big = await buffers.ensureLoaded('big.txt')
      expect(big.readOnly).toBe(true)
      expect(await buffers.saveBuffer('big.txt')).toBe(false)

      const u32 = await buffers.ensureLoaded('u32.txt')
      expect(u32.readOnly).toBe(true)
      expect(await buffers.saveBuffer('u32.txt')).toBe(false)

      await buffers.ensureLoaded('dir/mod.ts')
      buffers.updateContent('dir/mod.ts', 'export const x = 2', 1)
      buffers.renamePaths('dir', 'lib', true)
      expect(buffers.hasBuffer('dir/mod.ts')).toBe(false)
      expect(buffers.getBuffer('lib/mod.ts')?.content).toBe('export const x = 2')

      buffers.removePaths('lib', true)
      expect(buffers.hasBuffer('lib/mod.ts')).toBe(false)
    } finally {
      dispose()
    }
  })

  it('supports untitled buffers: unique names, sticky dirty, no direct save, rename-to-file', async () => {
    const env = createControllableBackend({})

    const { buffers, dispose } = createRoot((d) => ({
      buffers: createEditorBufferService('p1', env.backend),
      dispose: d,
    }))

    try {
      const untitled1 = buffers.createUntitled()
      expect(untitled1.relPath).toBe('untitled:1')
      expect(untitled1.untitled).toBe(true)
      expect(untitled1.dirty).toBe(true)
      expect(untitled1.content).toBe('')
      expect(untitled1.readOnly).toBe(false)

      // Names increment without reusing numbers still open in buffers.
      const untitled2 = buffers.createUntitled()
      expect(untitled2.relPath).toBe('untitled:2')

      // Emptying an untitled buffer keeps it dirty until saved to a real file.
      buffers.updateContent('untitled:1', 'draft text', 1)
      expect(buffers.isDirty('untitled:1')).toBe(true)
      buffers.updateContent('untitled:1', '', 0)
      expect(buffers.isDirty('untitled:1')).toBe(true)

      // Untitled buffers must never be written to their virtual path.
      expect(await buffers.saveBuffer('untitled:1')).toBe(false)
      expect(await buffers.saveAllDirty()).toBe(true)
      expect(env.files.size).toBe(0)

      // Overflow deltas scan all buffers; untitled paths must be excluded so
      // they are never stat'ed on the backend (which would throw).
      await buffers.handleFsDelta({
        projectId: 'p1',
        affectedDirs: [],
        affectedPaths: [],
        overflow: true,
      })
      expect(buffers.getBuffer('untitled:1')?.conflict).toBe('none')

      // Saving under a real name converts the buffer to a regular file-backed one.
      await env.backend.createFile('p1', 'notes.md')
      buffers.updateContent('untitled:1', '# Draft', 1)
      buffers.renamePaths('untitled:1', 'notes.md', false)
      expect(buffers.getBuffer('notes.md')?.untitled).toBe(false)
      expect(buffers.getBuffer('notes.md')?.content).toBe('# Draft')

      const saved = await buffers.saveBuffer('notes.md')
      expect(saved).toBe(true)
      expect(buffers.isDirty('notes.md')).toBe(false)
      expect(env.files.get('notes.md')?.content).toBe('# Draft')
      expect(buffers.hasBuffer('untitled:1')).toBe(false)

      // untitled:2 remains untouched and still dirty.
      expect(buffers.isDirty('untitled:2')).toBe(true)
    } finally {
      dispose()
    }
  })
})

describe('ProjectSelectionService tabs & close-guards', () => {
  it('manages multiple tabs, remembers previewer mode per tab, and updates on rename/remove', async () => {
    const env = createControllableBackend({
      'README.md': { content: '# Hi', modifiedMs: 100 },
      'src/a.ts': { content: 'a', modifiedMs: 100 },
      'src/b.ts': { content: 'b', modifiedMs: 100 },
    })

    const { selection, dispose } = createRoot((d) => ({
      selection: createProjectSelection('p1', env.backend),
      dispose: d,
    }))

    try {
      await selection.selectFile('README.md')
      selection.setPreferredPreviewerId('preview-code')
      await selection.selectFile('src/a.ts')
      await selection.selectFile('src/b.ts')

      expect(selection.openTabs().map((t) => t.relPath)).toEqual([
        'README.md',
        'src/a.ts',
        'src/b.ts',
      ])

      // Switching back to README.md remembers 'preview-code'.
      await selection.selectFile('README.md')
      expect(selection.preferredPreviewerId()).toBe('preview-code')

      // Rename src -> lib migrates tabs and keeps selection intact.
      await selection.selectFile('src/a.ts')
      await selection.renamePaths('src', 'lib', true)
      expect(selection.openTabs().map((t) => t.relPath)).toEqual([
        'README.md',
        'lib/a.ts',
        'lib/b.ts',
      ])
      expect(selection.selectedPath()).toBe('lib/a.ts')

      // Closing active tab selects adjacent right tab.
      await selection.closeTab('lib/a.ts')
      expect(selection.selectedPath()).toBe('lib/b.ts')

      await selection.removePaths('lib/b.ts', false)
      expect(selection.selectedPath()).toBe('README.md')
    } finally {
      dispose()
    }
  })

  it('guards closing dirty tabs and dirty projects via ConfirmDialogService', async () => {
    const env = createControllableBackend({
      'a.ts': { content: 'a0', modifiedMs: 100 },
      'b.ts': { content: 'b0', modifiedMs: 100 },
    })
    const kernel = createWorkbenchKernel(env.backend)
    const dialogs = kernel.get(ConfirmDialogKey)
    const scope = await kernel.openProject('/test-proj')
    const selection = scope.get(ProjectSelectionKey)
    const buffers = scope.get(EditorBufferKey)

    await selection.selectFile('a.ts')
    await buffers.ensureLoaded('a.ts')
    buffers.updateContent('a.ts', 'a1', 1)

    await selection.selectFile('b.ts')
    await buffers.ensureLoaded('b.ts')
    buffers.updateContent('b.ts', 'b1', 1)

    // Cancel closing a dirty tab keeps it open.
    const cancelPromise = requestCloseTab(kernel, scope, 'a.ts')
    expect(dialogs.current()?.request.title).toBe('Unsaved Changes')
    dialogs.dismiss('cancel')
    expect(await cancelPromise).toBe(false)
    expect(selection.openTabs().some((t) => t.relPath === 'a.ts')).toBe(true)

    // Save & close writes to disk and closes tab.
    const savePromise = requestCloseTab(kernel, scope, 'a.ts')
    dialogs.dismiss('save')
    expect(await savePromise).toBe(true)
    expect(env.files.get('a.ts')?.content).toBe('a1')
    expect(selection.openTabs().map((t) => t.relPath)).toEqual(['b.ts'])

    // Window close guard prompts for remaining dirty 'b.ts'.
    const winPromise = requestCloseWindow(kernel)
    expect(dialogs.current()?.request.details).toEqual(['test-proj/b.ts'])
    dialogs.dismiss('discard')
    expect(await winPromise).toBe(true)

    // Close project with remaining dirty 'b.ts' via discard.
    const projPromise = requestCloseProject(kernel, scope)
    dialogs.dismiss('discard')
    expect(await projPromise).toBe(true)
    expect(kernel.projects().length).toBe(0)

    // Reopen and verify closeOtherTabs / closeAllTabs clean path.
    const scope2 = await kernel.openProject('/test-proj-2')
    const sel2 = scope2.get(ProjectSelectionKey)
    await sel2.selectFile('a.ts')
    await sel2.selectFile('b.ts')
    expect(await requestCloseOtherTabs(kernel, scope2, 'b.ts')).toBe(true)
    expect(sel2.openTabs().map((t) => t.relPath)).toEqual(['b.ts'])
    expect(await requestCloseAllTabs(kernel, scope2)).toBe(true)
    expect(sel2.openTabs().length).toBe(0)

    kernel.dispose()
  })

  it('routes untitled saves through the save-as popover and keeps close flows honest', async () => {
    const env = createControllableBackend({})
    const kernel = createWorkbenchKernel(env.backend)
    const dialogs = kernel.get(ConfirmDialogKey)
    const scope = await kernel.openProject('/test-untitled')
    const selection = scope.get(ProjectSelectionKey)
    const buffers = scope.get(EditorBufferKey)

    // "+" flow: untitled buffer opens a synthesized tab without touching disk.
    const untitled = buffers.createUntitled()
    selection.openUntitledTab(untitled.relPath, 'Untitled-1')
    expect(selection.selectedPath()).toBe('untitled:1')
    expect(selection.fileMeta()?.name).toBe('Untitled-1')
    expect(selection.error()).toBeNull()

    // Editing keeps it dirty; Ctrl+S opens the save-as popover, not a disk write.
    buffers.updateContent('untitled:1', 'hello world', 1)
    expect(await requestSaveFile(kernel, scope, 'untitled:1')).toBe(false)
    expect(selection.pendingSaveAs()).toBe('untitled:1')
    expect(env.files.size).toBe(0)
    selection.cancelSaveAs()

    // Closing a dirty untitled tab with "Save" opens save-as and aborts the close.
    const closePromise = requestCloseTab(kernel, scope, 'untitled:1')
    expect(dialogs.current()?.request.title).toBe('Unsaved Changes')
    dialogs.dismiss('save')
    expect(await closePromise).toBe(false)
    expect(selection.pendingSaveAs()).toBe('untitled:1')
    expect(selection.openTabs().map((t) => t.relPath)).toEqual(['untitled:1'])
    selection.cancelSaveAs()

    // "Don't Save" discards the untitled buffer and closes the tab.
    const discardPromise = requestCloseTab(kernel, scope, 'untitled:1')
    dialogs.dismiss('discard')
    expect(await discardPromise).toBe(true)
    expect(selection.openTabs().length).toBe(0)
    expect(buffers.hasBuffer('untitled:1')).toBe(false)

    // Selecting an untitled path re-activates its tab without a stat error.
    buffers.createUntitled()
    await selection.selectFile('untitled:2')
    expect(selection.selectedPath()).toBe('untitled:2')
    expect(selection.error()).toBeNull()
    expect(selection.fileMeta()?.mime).toBe('text/plain')

    kernel.dispose()
  })

  it('saves untitled buffers into user-chosen folders, creating missing parents', async () => {
    const env = createControllableBackend({
      'src/exists.md': { content: 'taken', modifiedMs: 100 },
    })
    const kernel = createWorkbenchKernel(env.backend)
    const scope = await kernel.openProject('/test-save-as')
    const selection = scope.get(ProjectSelectionKey)
    const buffers = scope.get(EditorBufferKey)

    const untitled = buffers.createUntitled()
    selection.openUntitledTab(untitled.relPath, 'Untitled-1')
    buffers.updateContent('untitled:1', '# nested draft', 1)

    // Invalid targets are rejected before touching the backend.
    expect(parseSaveTarget('  ')).toBe('Name cannot be empty.')
    expect(parseSaveTarget('/abs/path.md')).toBe('Use a path relative to the project root.')
    expect(parseSaveTarget('a/../b.md')).toBe('Path cannot contain empty, "." or ".." segments.')
    expect(parseSaveTarget('a/b<c.md')).toContain('invalid characters')

    // Nested save creates missing parents and writes buffered content.
    const result = await saveUntitledAs(kernel, scope, 'untitled:1', 'deep\\nested\\notes.md')
    expect(result).toEqual({ ok: true, error: null })
    expect(env.dirs.has('deep')).toBe(true)
    expect(env.dirs.has('deep/nested')).toBe(true)
    expect(env.files.get('deep/nested/notes.md')?.content).toBe('# nested draft')
    expect(buffers.hasBuffer('untitled:1')).toBe(false)
    expect(buffers.getBuffer('deep/nested/notes.md')?.untitled).toBe(false)
    expect(buffers.isDirty('deep/nested/notes.md')).toBe(false)
    expect(selection.selectedPath()).toBe('deep/nested/notes.md')
    expect(selection.openTabs().map((t) => t.relPath)).toEqual(['deep/nested/notes.md'])
    expect(selection.pendingSaveAs()).toBeNull()

    // Saving onto an existing file fails and rolls the buffer back to untitled.
    // createUntitled reuses the freed "untitled:1" slot, so use the returned path.
    const second = buffers.createUntitled()
    selection.openUntitledTab(second.relPath, 'Untitled-1')
    buffers.updateContent(second.relPath, 'keep me', 1)

    const conflict = await saveUntitledAs(kernel, scope, second.relPath, 'src/exists.md')
    expect(conflict.ok).toBe(false)
    expect(conflict.error).toContain('already exists')
    expect(buffers.getBuffer(second.relPath)?.content).toBe('keep me')
    expect(buffers.getBuffer(second.relPath)?.untitled).toBe(true)
    expect(env.files.get('src/exists.md')?.content).toBe('taken')
    expect(selection.openTabs().map((t) => t.relPath)).toEqual([
      'deep/nested/notes.md',
      second.relPath,
    ])

    kernel.dispose()
  })

  it('saves untitled files through the native save dialog when the backend offers one', async () => {
    const env = createControllableBackend({})
    let pickedSuggestedName = ''
    const dialogBackend: WorkspaceBackend = {
      ...env.backend,
      // Desktop-like backend: requestSaveFile must prefer the dialog over the popover.
      pickSavePath: async (_projectId, suggestedName) => {
        pickedSuggestedName = suggestedName
        return 'reports/summary.md'
      },
    }
    const kernel = createWorkbenchKernel(dialogBackend)
    const scope = await kernel.openProject('/test-dialog-save')
    const selection = scope.get(ProjectSelectionKey)
    const buffers = scope.get(EditorBufferKey)

    const untitled = buffers.createUntitled()
    selection.openUntitledTab(untitled.relPath, 'Untitled-1')
    buffers.updateContent('untitled:1', 'dialog save body', 1)

    // Ctrl+S / Save routes through the dialog and completes the save.
    expect(await requestSaveFile(kernel, scope, 'untitled:1')).toBe(true)
    expect(pickedSuggestedName).toBe('Untitled-1')
    expect(env.files.get('reports/summary.md')?.content).toBe('dialog save body')
    expect(buffers.hasBuffer('untitled:1')).toBe(false)
    expect(buffers.getBuffer('reports/summary.md')?.untitled).toBe(false)
    expect(buffers.isDirty('reports/summary.md')).toBe(false)
    expect(selection.selectedPath()).toBe('reports/summary.md')
    expect(selection.pendingSaveAs()).toBeNull()

    // Dialog cancel keeps the buffer untitled and dirty.
    const cancelBackend: WorkspaceBackend = {
      ...env.backend,
      pickSavePath: async () => null,
    }
    const kernel2 = createWorkbenchKernel(cancelBackend)
    const scope2 = await kernel2.openProject('/test-dialog-cancel')
    const selection2 = scope2.get(ProjectSelectionKey)
    const buffers2 = scope2.get(EditorBufferKey)
    const untitled2 = buffers2.createUntitled()
    selection2.openUntitledTab(untitled2.relPath, 'Untitled-1')
    buffers2.updateContent('untitled:1', 'unsaved', 1)

    expect(await requestSaveFile(kernel2, scope2, 'untitled:1')).toBe(false)
    expect(selection2.pendingSaveAs()).toBeNull()
    expect(buffers2.getBuffer('untitled:1')?.untitled).toBe(true)
    expect(buffers2.isDirty('untitled:1')).toBe(true)
    expect(env.files.size).toBe(1)

    kernel.dispose()
    kernel2.dispose()
  })

  it('suppresses FsDelta false deleted conflict during open-file rename', async () => {
    const env = createControllableBackend({
      'notes/todo.txt': { content: 'initial', modifiedMs: 100 },
    })

    const { buffers, dispose } = createRoot((d) => ({
      buffers: createEditorBufferService('p1', env.backend),
      dispose: d,
    }))

    try {
      await buffers.ensureLoaded('notes/todo.txt')
      buffers.updateContent('notes/todo.txt', 'buy milk', 1)

      const release = buffers.suppressPath('notes/todo.txt', false)
      try {
        await env.backend.renamePath('p1', 'notes/todo.txt', 'notes/tasks.txt')
        // Simulate FsDelta arriving before renamePaths finishes.
        await buffers.handleFsDelta(env.emitDelta(['notes/todo.txt', 'notes/tasks.txt']))
        buffers.renamePaths('notes/todo.txt', 'notes/tasks.txt', false)
      } finally {
        release()
      }

      // Subsequent FsDelta on new path within self-write window also preserves clean state.
      await buffers.handleFsDelta(env.emitDelta(['notes/tasks.txt']))

      const renamedBuf = buffers.getBuffer('notes/tasks.txt')
      expect(renamedBuf?.content).toBe('buy milk')
      expect(renamedBuf?.dirty).toBe(true)
      expect(renamedBuf?.conflict).toBe('none')
    } finally {
      dispose()
    }
  })

  it('switches selection and meta cleanly when discarding a dirty tab via requestCloseTab', async () => {
    const env = createControllableBackend({
      'a.ts': { content: 'a0', modifiedMs: 100 },
      'b.ts': { content: 'b0', modifiedMs: 100 },
    })
    const kernel = createWorkbenchKernel(env.backend)
    const dialogs = kernel.get(ConfirmDialogKey)
    const scope = await kernel.openProject('/test-discard-switch')
    const selection = scope.get(ProjectSelectionKey)
    const buffers = scope.get(EditorBufferKey)

    await selection.selectFile('a.ts')
    await buffers.ensureLoaded('a.ts')
    buffers.updateContent('a.ts', 'a-unsaved', 1)

    await selection.selectFile('b.ts')
    await buffers.ensureLoaded('b.ts')

    // Switch back to dirty a.ts and close it with Don't Save.
    await selection.selectFile('a.ts')
    const closePromise = requestCloseTab(kernel, scope, 'a.ts')
    dialogs.dismiss('discard')
    expect(await closePromise).toBe(true)

    expect(selection.selectedPath()).toBe('b.ts')
    expect(selection.fileMeta()?.relPath).toBe('b.ts')
    expect(buffers.hasBuffer('a.ts')).toBe(false)
    expect(buffers.getBuffer('b.ts')?.content).toBe('b0')

    kernel.dispose()
  })
})

// Keep createAppKernel / createConfirmDialogService referenced cleanly in case direct import checks run.
void createAppKernel
void createConfirmDialogService
void (null as unknown as KernelProjectHost)
