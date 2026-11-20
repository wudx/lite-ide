import { createAppKernel, type KernelProjectHost } from '@lite-ide/kernel'
import type { DirEntry, FileMeta, FsDelta, TextPayload, WorkspaceBackend, WriteTextResult } from '@lite-ide/protocol'
import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import {
  requestCloseAllTabs,
  requestCloseOtherTabs,
  requestCloseProject,
  requestCloseTab,
  requestCloseWindow,
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
  let fsListener: ((delta: FsDelta) => void) | null = null
  let clock = 1000

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
      clock += 10
      const rec: TestFileRecord = { content: '', modifiedMs: clock }
      files.set(relPath, rec)
      return makeMeta(projectId, relPath, rec)
    },
    async createDir(): Promise<DirEntry> {
      throw new Error('not needed')
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
