import {
  createAppKernel,
  createServiceKey,
  EventBus,
  type AppKernel,
  type KernelProjectHost,
  type ProjectScope,
} from '@lite-ide/kernel'
import type { FileMeta, FsDelta, WorkspaceBackend } from '@lite-ide/protocol'
import { createSignal, type Accessor } from 'solid-js'

export interface ProjectSelectionService {
  readonly selectedPath: Accessor<string | null>
  readonly fileMeta: Accessor<FileMeta | null>
  readonly loading: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly preferredPreviewerId: Accessor<string | null>
  setPreferredPreviewerId(id: string | null): void
  selectFile(relPath: string): Promise<void>
  refreshCurrentFile(): Promise<void>
  clearSelection(): void
}

export interface LayoutStateService {
  readonly sidebarVisible: Accessor<boolean>
  readonly sidebarWidth: Accessor<number>
  toggleSidebar(): void
  setSidebarWidth(width: number): void
}

export const WorkspaceBackendKey = createServiceKey<WorkspaceBackend>('workbench.backend')
export const ProjectSelectionKey = createServiceKey<ProjectSelectionService>(
  'workbench.projectSelection',
)
export const ProjectFsEventsKey = createServiceKey<EventBus<{ delta: FsDelta }>>(
  'workbench.projectFsEvents',
)
export const LayoutStateKey = createServiceKey<LayoutStateService>('workbench.layoutState')

function createProjectSelection(
  projectId: string,
  backend: WorkspaceBackend,
): ProjectSelectionService {
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null)
  const [fileMeta, setFileMeta] = createSignal<FileMeta | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [preferredPreviewerId, setPreferredPreviewerId] = createSignal<string | null>(null)

  let requestSeq = 0

  async function loadMeta(relPath: string, resetPreferred: boolean) {
    const seq = ++requestSeq
    setSelectedPath(relPath)
    if (resetPreferred) {
      setPreferredPreviewerId(null)
    }
    setLoading(true)
    setError(null)

    try {
      const meta = await backend.statPreview(projectId, relPath)
      if (seq !== requestSeq) return
      setFileMeta(meta)
    } catch (err) {
      if (seq !== requestSeq) return
      setFileMeta(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === requestSeq) {
        setLoading(false)
      }
    }
  }

  return {
    selectedPath,
    fileMeta,
    loading,
    error,
    preferredPreviewerId,
    setPreferredPreviewerId,
    async selectFile(relPath: string) {
      await loadMeta(relPath, true)
    },
    async refreshCurrentFile() {
      const current = selectedPath()
      if (!current) return
      await loadMeta(current, false)
    },
    clearSelection() {
      requestSeq += 1
      setSelectedPath(null)
      setFileMeta(null)
      setError(null)
      setLoading(false)
    },
  }
}

export function createLayoutState(): LayoutStateService {
  const [sidebarVisible, setSidebarVisible] = createSignal(true)
  const [sidebarWidth, setSidebarWidthState] = createSignal(260)

  return {
    sidebarVisible,
    sidebarWidth,
    toggleSidebar() {
      setSidebarVisible((v) => !v)
    },
    setSidebarWidth(width: number) {
      setSidebarWidthState(Math.max(180, Math.min(520, Math.round(width))))
    },
  }
}

export function createKernelHostFromBackend(backend: WorkspaceBackend): KernelProjectHost {
  return {
    async open(rootPath: string) {
      const fsEvents = new EventBus<{ delta: FsDelta }>()
      const info = await backend.openProject(rootPath, (delta) => {
        fsEvents.emit('delta', delta)
      })

      return {
        info,
        setupScope(scope: ProjectScope) {
          const selection = createProjectSelection(scope.id, backend)
          scope.provide(ProjectFsEventsKey, fsEvents)
          scope.provide(ProjectSelectionKey, selection)

          const unsub = fsEvents.on('delta', (delta) => {
            const current = selection.selectedPath()
            if (!current) return
            if (delta.overflow || delta.affectedPaths.includes(current)) {
              void selection.refreshCurrentFile()
            }
          })
          scope.onDispose(unsub)
          scope.onDispose(() => fsEvents.clear())
        },
        async close() {
          await backend.closeProject(info.id)
        },
      }
    },
    pickFolder() {
      return backend.pickFolder()
    },
  }
}

export function createWorkbenchKernel(
  backend: WorkspaceBackend,
  maxWarmProjects = 5,
): AppKernel {
  const kernel = createAppKernel({
    host: createKernelHostFromBackend(backend),
    maxWarmProjects,
  })
  kernel.provide(WorkspaceBackendKey, backend)
  kernel.provide(LayoutStateKey, createLayoutState())
  return kernel
}
