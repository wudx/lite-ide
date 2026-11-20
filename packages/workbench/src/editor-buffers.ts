import { createServiceKey, EventBus } from '@lite-ide/kernel'
import type { FileMeta, FsDelta, TextPayload, WorkspaceBackend } from '@lite-ide/protocol'
import { createMemo, createSignal, type Accessor } from 'solid-js'

export const DEFAULT_BUFFER_MAX_BYTES = 2 * 1024 * 1024
const SELF_WRITE_WINDOW_MS = 1500
const WRITABLE_ENCODINGS = new Set(['', 'utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'])

export type BufferConflict = 'none' | 'modified' | 'deleted'

export interface DocumentBuffer {
  relPath: string
  content: string
  savedContent: string
  encoding: string
  diskModifiedMs: number
  totalBytes: number
  loadedBytes: number
  truncated: boolean
  maxBytes: number
  lineCount: number
  dirty: boolean
  saving: boolean
  saveError: string | null
  conflict: BufferConflict
  diskRevision: number
  readOnly: boolean
  readOnlyReason: string | null
}

export interface EditorBufferEvents {
  discarded: { relPath: string }
  renamed: { oldRelPath: string; newRelPath: string; isDir: boolean }
  removed: { relPath: string; isDir: boolean }
  [key: string]: unknown
}

export interface EditorBufferService {
  readonly buffers: Accessor<ReadonlyMap<string, DocumentBuffer>>
  readonly dirtyPaths: Accessor<ReadonlySet<string>>
  readonly hasDirtyFiles: Accessor<boolean>
  readonly dirtyCount: Accessor<number>
  readonly events: EventBus<EditorBufferEvents>
  getBuffer(relPath: string): DocumentBuffer | undefined
  hasBuffer(relPath: string): boolean
  isDirty(relPath: string): boolean
  ensureLoaded(
    relPath: string,
    maxBytes?: number,
    knownModifiedMs?: number,
  ): Promise<DocumentBuffer>
  reloadBuffer(relPath: string, maxBytes?: number): Promise<DocumentBuffer>
  updateContent(relPath: string, content: string, lineCount: number): void
  saveBuffer(relPath: string): Promise<boolean>
  overwriteConflict(relPath: string): Promise<boolean>
  dismissConflict(relPath: string): void
  saveAllDirty(): Promise<boolean>
  discardBuffer(relPath: string): void
  renamePaths(oldRelPath: string, newRelPath: string, isDir: boolean): void
  removePaths(relPath: string, isDir: boolean): void
  suppressPath(relPath: string, isDir: boolean): () => void
  handleFsDelta(delta: FsDelta): Promise<void>
}

export const EditorBufferKey = createServiceKey<EditorBufferService>('workbench.editorBuffers')

function computeReadOnlyState(payload: TextPayload): {
  readOnly: boolean
  readOnlyReason: string | null
} {
  if (payload.truncated) {
    return {
      readOnly: true,
      readOnlyReason: 'Large file is partially loaded and protected as read-only.',
    }
  }
  const normalizedEnc = payload.encoding.trim().toLowerCase()
  if (!WRITABLE_ENCODINGS.has(normalizedEnc)) {
    return {
      readOnly: true,
      readOnlyReason: `Encoding "${payload.encoding}" is read-only.`,
    }
  }
  return { readOnly: false, readOnlyReason: null }
}

function remapPath(target: string, oldRelPath: string, newRelPath: string, isDir: boolean): string | null {
  if (target === oldRelPath) return newRelPath
  if (isDir) {
    const prefix = `${oldRelPath}/`
    if (target.startsWith(prefix)) {
      return `${newRelPath}/${target.slice(prefix.length)}`
    }
  }
  return null
}

function matchesPath(target: string, relPath: string, isDir: boolean): boolean {
  if (target === relPath) return true
  if (isDir && target.startsWith(`${relPath}/`)) return true
  return false
}

export interface CreateEditorBufferServiceOptions {
  onMetaUpdated?: (meta: FileMeta) => void
}

export function createEditorBufferService(
  projectId: string,
  backend: WorkspaceBackend,
  options: CreateEditorBufferServiceOptions = {},
): EditorBufferService {
  const [buffers, setBuffers] = createSignal<Map<string, DocumentBuffer>>(new Map())
  const events = new EventBus<EditorBufferEvents>()
  const inflightLoads = new Map<string, Promise<DocumentBuffer>>()
  const recentSelfWrites = new Map<string, number>()
  const activeSuppressions = new Set<{ relPath: string; isDir: boolean }>()

  function isSuppressed(targetPath: string): boolean {
    for (const rule of activeSuppressions) {
      if (matchesPath(targetPath, rule.relPath, rule.isDir)) {
        return true
      }
    }
    return false
  }

  const dirtyPaths = createMemo<ReadonlySet<string>>(() => {
    const next = new Set<string>()
    for (const [path, buf] of buffers()) {
      if (buf.dirty) next.add(path)
    }
    return next
  })

  const dirtyCount = createMemo(() => dirtyPaths().size)
  const hasDirtyFiles = createMemo(() => dirtyCount() > 0)

  function patchBuffer(relPath: string, updater: (prev: DocumentBuffer) => DocumentBuffer) {
    setBuffers((prev) => {
      const existing = prev.get(relPath)
      if (!existing) return prev
      const next = new Map(prev)
      next.set(relPath, updater(existing))
      return next
    })
  }

  async function readPayloadAndMeta(
    relPath: string,
    maxBytes: number,
    knownMeta?: FileMeta,
  ): Promise<{ payload: TextPayload; meta: FileMeta | null }> {
    const payloadPromise = backend.readText(projectId, relPath, maxBytes)
    const metaPromise = knownMeta
      ? Promise.resolve(knownMeta)
      : backend.statPreview(projectId, relPath).catch(() => null)
    const [payload, meta] = await Promise.all([payloadPromise, metaPromise])
    return { payload, meta }
  }

  function buildBuffer(
    relPath: string,
    payload: TextPayload,
    maxBytes: number,
    modifiedMs: number,
    diskRevision: number,
  ): DocumentBuffer {
    const ro = computeReadOnlyState(payload)
    return {
      relPath,
      content: payload.content,
      savedContent: payload.content,
      encoding: payload.encoding,
      diskModifiedMs: modifiedMs,
      totalBytes: payload.totalBytes,
      loadedBytes: payload.loadedBytes,
      truncated: payload.truncated,
      maxBytes,
      lineCount: payload.lineCount,
      dirty: false,
      saving: false,
      saveError: null,
      conflict: 'none',
      diskRevision,
      readOnly: ro.readOnly,
      readOnlyReason: ro.readOnlyReason,
    }
  }

  async function saveBufferInternal(relPath: string): Promise<boolean> {
    const buf = buffers().get(relPath)
    if (!buf || buf.readOnly || buf.saving) {
      return false
    }

    const snapshot = buf.content
    recentSelfWrites.set(relPath, Date.now())
    patchBuffer(relPath, (prev) => ({
      ...prev,
      saving: true,
      saveError: null,
    }))

    try {
      const res = await backend.writeText(projectId, relPath, snapshot, buf.encoding)
      recentSelfWrites.set(relPath, Date.now())

      patchBuffer(relPath, (latest) => ({
        ...latest,
        savedContent: snapshot,
        encoding: res.meta.encoding,
        diskModifiedMs: res.meta.modifiedMs,
        totalBytes: res.meta.size,
        loadedBytes: res.writtenBytes,
        truncated: false,
        lineCount: latest.content === snapshot ? res.lineCount : latest.lineCount,
        dirty: latest.content !== snapshot,
        saving: false,
        saveError: null,
        conflict: 'none',
      }))

      options.onMetaUpdated?.(res.meta)
      return true
    } catch (err) {
      patchBuffer(relPath, (latest) => ({
        ...latest,
        saving: false,
        saveError: err instanceof Error ? err.message : String(err),
      }))
      return false
    }
  }

  return {
    buffers,
    dirtyPaths,
    hasDirtyFiles,
    dirtyCount,
    events,

    getBuffer(relPath: string): DocumentBuffer | undefined {
      return buffers().get(relPath)
    },

    hasBuffer(relPath: string): boolean {
      return buffers().has(relPath)
    },

    isDirty(relPath: string): boolean {
      return buffers().get(relPath)?.dirty ?? false
    },

    async ensureLoaded(
      relPath: string,
      maxBytes = DEFAULT_BUFFER_MAX_BYTES,
      knownModifiedMs?: number,
    ): Promise<DocumentBuffer> {
      const existing = buffers().get(relPath)
      if (existing && maxBytes <= existing.maxBytes) {
        return existing
      }

      const inflightKey = `${relPath}::${maxBytes}`
      const pending = inflightLoads.get(inflightKey)
      if (pending) return pending

      const promise = (async () => {
        const { payload, meta } = await readPayloadAndMeta(relPath, maxBytes)
        const modifiedMs = meta?.modifiedMs ?? knownModifiedMs ?? 0
        if (meta) {
          options.onMetaUpdated?.(meta)
        }

        const current = buffers().get(relPath)
        if (current && maxBytes <= current.maxBytes) {
          return current
        }

        const nextBuf = buildBuffer(
          relPath,
          payload,
          maxBytes,
          modifiedMs,
          current ? current.diskRevision + 1 : 0,
        )
        setBuffers((prev) => {
          const next = new Map(prev)
          next.set(relPath, nextBuf)
          return next
        })
        return nextBuf
      })()

      inflightLoads.set(inflightKey, promise)
      try {
        return await promise
      } finally {
        inflightLoads.delete(inflightKey)
      }
    },

    async reloadBuffer(
      relPath: string,
      maxBytes?: number,
    ): Promise<DocumentBuffer> {
      const current = buffers().get(relPath)
      const cap = maxBytes ?? current?.maxBytes ?? DEFAULT_BUFFER_MAX_BYTES
      const { payload, meta } = await readPayloadAndMeta(relPath, cap)
      const modifiedMs = meta?.modifiedMs ?? current?.diskModifiedMs ?? 0
      if (meta) {
        options.onMetaUpdated?.(meta)
      }

      const nextBuf = buildBuffer(
        relPath,
        payload,
        cap,
        modifiedMs,
        (current?.diskRevision ?? -1) + 1,
      )
      setBuffers((prev) => {
        const next = new Map(prev)
        next.set(relPath, nextBuf)
        return next
      })
      return nextBuf
    },

    updateContent(relPath: string, content: string, lineCount: number): void {
      patchBuffer(relPath, (prev) => ({
        ...prev,
        content,
        lineCount,
        dirty: content !== prev.savedContent,
        saveError: null,
      }))
    },

    async saveBuffer(relPath: string): Promise<boolean> {
      return saveBufferInternal(relPath)
    },

    async overwriteConflict(relPath: string): Promise<boolean> {
      const buf = buffers().get(relPath)
      if (!buf || buf.readOnly || buf.saving) {
        return false
      }

      if (buf.conflict === 'deleted') {
        try {
          recentSelfWrites.set(relPath, Date.now())
          await backend.createFile(projectId, relPath)
        } catch (err) {
          patchBuffer(relPath, (latest) => ({
            ...latest,
            saveError: err instanceof Error ? err.message : String(err),
          }))
          return false
        }
      }

      return saveBufferInternal(relPath)
    },

    dismissConflict(relPath: string): void {
      patchBuffer(relPath, (prev) => ({
        ...prev,
        conflict: 'none',
      }))
    },

    async saveAllDirty(): Promise<boolean> {
      const targets = [...buffers().values()]
        .filter((b) => b.dirty && !b.readOnly)
        .map((b) => b.relPath)

      let allOk = true
      for (const path of targets) {
        const ok = await saveBufferInternal(path)
        if (!ok) allOk = false
      }
      return allOk
    },

    discardBuffer(relPath: string): void {
      if (!buffers().has(relPath)) return
      setBuffers((prev) => {
        if (!prev.has(relPath)) return prev
        const next = new Map(prev)
        next.delete(relPath)
        return next
      })
      recentSelfWrites.delete(relPath)
      events.emit('discarded', { relPath })
    },

    renamePaths(oldRelPath: string, newRelPath: string, isDir: boolean): void {
      let changed = false
      const now = Date.now()
      setBuffers((prev) => {
        const next = new Map<string, DocumentBuffer>()
        for (const [path, buf] of prev) {
          const mapped = remapPath(path, oldRelPath, newRelPath, isDir)
          if (mapped && mapped !== path) {
            changed = true
            recentSelfWrites.set(mapped, now)
            next.set(mapped, { ...buf, relPath: mapped, conflict: 'none' })
          } else {
            next.set(path, buf)
          }
        }
        return changed ? next : prev
      })

      for (const [path, ts] of [...recentSelfWrites]) {
        const mapped = remapPath(path, oldRelPath, newRelPath, isDir)
        if (mapped && mapped !== path) {
          recentSelfWrites.delete(path)
          recentSelfWrites.set(mapped, Math.max(ts, now))
        }
      }

      if (changed) {
        events.emit('renamed', { oldRelPath, newRelPath, isDir })
      }
    },

    suppressPath(relPath: string, isDir: boolean): () => void {
      const rule = { relPath, isDir }
      activeSuppressions.add(rule)
      return () => {
        activeSuppressions.delete(rule)
      }
    },

    removePaths(relPath: string, isDir: boolean): void {
      let changed = false
      setBuffers((prev) => {
        const next = new Map<string, DocumentBuffer>()
        for (const [path, buf] of prev) {
          if (matchesPath(path, relPath, isDir)) {
            changed = true
          } else {
            next.set(path, buf)
          }
        }
        return changed ? next : prev
      })

      for (const path of [...recentSelfWrites.keys()]) {
        if (matchesPath(path, relPath, isDir)) {
          recentSelfWrites.delete(path)
        }
      }

      if (changed) {
        events.emit('removed', { relPath, isDir })
      }
    },

    async handleFsDelta(delta: FsDelta): Promise<void> {
      const currentBuffers = buffers()
      if (currentBuffers.size === 0) return

      const candidates = new Set<string>()
      if (delta.overflow) {
        for (const path of currentBuffers.keys()) {
          if (!isSuppressed(path)) {
            candidates.add(path)
          }
        }
      } else {
        for (const path of delta.affectedPaths) {
          if (currentBuffers.has(path) && !isSuppressed(path)) {
            candidates.add(path)
          }
        }
      }

      if (candidates.size === 0) return

      await Promise.all(
        [...candidates].map(async (relPath) => {
          if (isSuppressed(relPath)) return
          const snapshotBuf = buffers().get(relPath)
          if (!snapshotBuf || snapshotBuf.saving) return

          try {
            const freshMeta = await backend.statPreview(projectId, relPath)
            if (isSuppressed(relPath)) return
            options.onMetaUpdated?.(freshMeta)

            const latestBuf = buffers().get(relPath)
            if (!latestBuf || latestBuf.saving) return

            const sameStat =
              freshMeta.modifiedMs === latestBuf.diskModifiedMs &&
              freshMeta.size === latestBuf.totalBytes

            const selfWriteTs = recentSelfWrites.get(relPath)
            const isSelfWrite =
              selfWriteTs !== undefined &&
              Date.now() - selfWriteTs < SELF_WRITE_WINDOW_MS &&
              freshMeta.size === latestBuf.totalBytes &&
              freshMeta.modifiedMs >= latestBuf.diskModifiedMs

            if (sameStat || isSelfWrite) {
              if (isSelfWrite && freshMeta.modifiedMs !== latestBuf.diskModifiedMs) {
                patchBuffer(relPath, (prev) => ({
                  ...prev,
                  diskModifiedMs: freshMeta.modifiedMs,
                }))
              }
              return
            }

            if (latestBuf.dirty) {
              patchBuffer(relPath, (prev) => ({
                ...prev,
                diskModifiedMs: freshMeta.modifiedMs,
                totalBytes: freshMeta.size,
                conflict: 'modified',
              }))
              return
            }

            const { payload } = await readPayloadAndMeta(relPath, latestBuf.maxBytes, freshMeta)
            const postReadBuf = buffers().get(relPath)
            if (!postReadBuf || postReadBuf.saving) return
            if (postReadBuf.dirty) {
              patchBuffer(relPath, (prev) => ({
                ...prev,
                diskModifiedMs: freshMeta.modifiedMs,
                totalBytes: freshMeta.size,
                conflict: 'modified',
              }))
              return
            }

            const contentChanged =
              payload.content !== postReadBuf.content ||
              payload.truncated !== postReadBuf.truncated ||
              payload.encoding !== postReadBuf.encoding

            const nextBuf = buildBuffer(
              relPath,
              payload,
              postReadBuf.maxBytes,
              freshMeta.modifiedMs,
              contentChanged ? postReadBuf.diskRevision + 1 : postReadBuf.diskRevision,
            )
            setBuffers((prev) => {
              if (!prev.has(relPath)) return prev
              const next = new Map(prev)
              next.set(relPath, nextBuf)
              return next
            })
          } catch {
            if (isSuppressed(relPath)) return
            patchBuffer(relPath, (prev) => ({
              ...prev,
              conflict: 'deleted',
            }))
          }
        }),
      )
    },
  }
}
