import { describe, expect, it } from 'vitest'
import type { DirEntry, FileMeta, FsDelta, ProjectInfo, TextPayload, WorkspaceBackend, WriteTextResult } from '@lite-ide/protocol'
import { createProjectSelection } from '../src/services'

function unreachable(name: string): never {
  throw new Error(`${name} should not be called in this test`)
}

function throwingBackend(statError: Error): WorkspaceBackend {
  return {
    kind: 'mock',
    openProject(path): Promise<ProjectInfo> {
      return Promise.resolve({ id: 'p1', name: 'p', rootPath: path })
    },
    closeProject(): Promise<void> {
      return Promise.resolve()
    },
    listDir(): Promise<DirEntry[]> {
      return Promise.resolve([])
    },
    async statPreview(): Promise<FileMeta> {
      throw statError
    },
    readText(): Promise<TextPayload> {
      return unreachable('readText')
    },
    writeText(): Promise<WriteTextResult> {
      return unreachable('writeText')
    },
    createFile(): Promise<FileMeta> {
      return unreachable('createFile')
    },
    createDir(): Promise<DirEntry> {
      return unreachable('createDir')
    },
    renamePath(): Promise<DirEntry> {
      return unreachable('renamePath')
    },
    deletePath(): Promise<void> {
      return unreachable('deletePath')
    },
    pickFolder(): Promise<string | null> {
      return Promise.resolve(null)
    },
  }
}

function fsDelta(paths: string[]): FsDelta {
  return { projectId: 'p1', affectedDirs: [], affectedPaths: paths, overflow: false }
}

describe('createProjectSelection allowMissing', () => {
  it('surfaces stat errors by default', async () => {
    const selection = createProjectSelection(
      'p1',
      throwingBackend(new Error('File not found: gone.ts')),
    )
    await selection.selectFile('gone.ts')
    expect(selection.selectedPath()).toBe('gone.ts')
    expect(selection.fileMeta()).toBeNull()
    expect(selection.error()).toBe('File not found: gone.ts')
  })

  it('synthesizes a stub meta for missing paths when allowMissing is set', async () => {
    const selection = createProjectSelection(
      'p1',
      throwingBackend(new Error('File not found: src/gone note.ts')),
    )
    await selection.selectFile('src/gone note.ts', {
      preferredPreviewerId: 'git-diff',
      allowMissing: true,
    })
    expect(selection.error()).toBeNull()
    expect(selection.loading()).toBe(false)
    const meta = selection.fileMeta()
    expect(meta).not.toBeNull()
    expect(meta!.projectId).toBe('p1')
    expect(meta!.relPath).toBe('src/gone note.ts')
    expect(meta!.name).toBe('gone note.ts')
    expect(meta!.ext).toBe('ts')
    expect(meta!.size).toBe(0)
    expect(meta!.isBinary).toBe(false)
    expect(selection.preferredPreviewerId()).toBe('git-diff')
  })

  it('reopening an existing missing-backed selection does not clear the stub', async () => {
    const backend = throwingBackend(new Error('File not found: gone.ts'))
    const selection = createProjectSelection('p1', backend)
    await selection.selectFile('gone.ts', { allowMissing: true })
    const first = selection.fileMeta()

    await selection.selectFile('gone.ts', { allowMissing: true })
    expect(selection.fileMeta()).toBe(first)
    // FS deltas for the deleted path must not wipe the diff view's stub.
    selection.syncFileMeta(first!)
    expect(selection.fileMeta()).toBe(first)
    expect(fsDelta(['gone.ts']).affectedPaths).toEqual(['gone.ts'])
  })
})
