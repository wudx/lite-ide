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
import { ConfirmDialogKey, createConfirmDialogService } from './dialogs'
import {
  createEditorBufferService,
  EditorBufferKey,
  isUntitledPath,
  untitledDisplayNameOf,
} from './editor-buffers'

export interface EditorTab {
  relPath: string
  name: string
  preferredPreviewerId: string | null
}

export interface ProjectSelectionService {
  readonly selectedPath: Accessor<string | null>
  readonly openTabs: Accessor<readonly EditorTab[]>
  readonly fileMeta: Accessor<FileMeta | null>
  readonly loading: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly preferredPreviewerId: Accessor<string | null>
  /** Untitled buffer path awaiting a file name in the save-as popover. */
  readonly pendingSaveAs: Accessor<string | null>
  /** Error to surface in the save-as popover when it opens. */
  readonly pendingSaveAsError: Accessor<string | null>
  setPreferredPreviewerId(id: string | null): void
  selectFile(
    relPath: string,
    options?: { preferredPreviewerId?: string | null },
  ): Promise<void>
  openUntitledTab(relPath: string, name: string): void
  requestSaveAs(relPath: string, presetError?: string | null): void
  cancelSaveAs(): void
  syncFileMeta(meta: FileMeta): void
  refreshCurrentFile(): Promise<void>
  closeTab(relPath: string): Promise<void>
  closeOtherTabs(relPath: string): Promise<void>
  closeAllTabs(): void
  activateAdjacentTab(delta: 1 | -1): Promise<void>
  renamePaths(oldRelPath: string, newRelPath: string, isDir: boolean): Promise<void>
  removePaths(relPath: string, isDir: boolean): Promise<void>
  clearSelection(): void
}

export interface LayoutStateService {
  readonly sidebarVisible: Accessor<boolean>
  readonly sidebarWidth: Accessor<number>
  toggleSidebar(): void
  setSidebarWidth(width: number): void
}

export type ThemeMode = 'dark' | 'light'

export interface ThemeStateService {
  readonly theme: Accessor<ThemeMode>
  setTheme(mode: ThemeMode): void
  toggleTheme(): void
}

export const WorkspaceBackendKey = createServiceKey<WorkspaceBackend>('workbench.backend')
export const ProjectSelectionKey = createServiceKey<ProjectSelectionService>(
  'workbench.projectSelection',
)
export const ProjectFsEventsKey = createServiceKey<EventBus<{ delta: FsDelta }>>(
  'workbench.projectFsEvents',
)
export const LayoutStateKey = createServiceKey<LayoutStateService>('workbench.layoutState')
export const ThemeStateKey = createServiceKey<ThemeStateService>('workbench.themeState')

function baseNameOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
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

export function createProjectSelection(
  projectId: string,
  backend: WorkspaceBackend,
): ProjectSelectionService {
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null)
  const [openTabs, setOpenTabs] = createSignal<EditorTab[]>([])
  const [fileMeta, setFileMeta] = createSignal<FileMeta | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [preferredPreviewerId, setPreferredPreviewerIdState] = createSignal<string | null>(null)
  const [pendingSaveAs, setPendingSaveAs] = createSignal<string | null>(null)
  const [pendingSaveAsError, setPendingSaveAsError] = createSignal<string | null>(null)

  let requestSeq = 0

  function clearSelectionState() {
    requestSeq += 1
    setSelectedPath(null)
    setFileMeta(null)
    setError(null)
    setLoading(false)
    setPreferredPreviewerIdState(null)
  }

  function openUntitledTabImpl(relPath: string, name: string) {
    setOpenTabs((prev) =>
      prev.some((t) => t.relPath === relPath)
        ? prev
        : [...prev, { relPath, name, preferredPreviewerId: null }],
    )
    requestSeq += 1
    setSelectedPath(relPath)
    setPreferredPreviewerIdState(null)
    setFileMeta({
      projectId,
      relPath,
      name,
      ext: '',
      size: 0,
      modifiedMs: Date.now(),
      mime: 'text/plain',
      isBinary: false,
      encoding: '',
    })
    setError(null)
    setLoading(false)
  }

  async function loadMeta(relPath: string, nextPreferred: string | null) {
    const seq = ++requestSeq
    setSelectedPath(relPath)
    setPreferredPreviewerIdState(nextPreferred)
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
    openTabs,
    fileMeta,
    loading,
    error,
    preferredPreviewerId,
    pendingSaveAs,
    pendingSaveAsError,

    setPreferredPreviewerId(id: string | null) {
      setPreferredPreviewerIdState(id)
      const current = selectedPath()
      if (!current) return
      setOpenTabs((prev) =>
        prev.map((tab) =>
          tab.relPath === current ? { ...tab, preferredPreviewerId: id } : tab,
        ),
      )
    },

    async selectFile(relPath: string, options?: { preferredPreviewerId?: string | null }) {
      // Untitled buffers have no disk file to stat; activate their tab directly.
      if (isUntitledPath(relPath)) {
        openUntitledTabImpl(relPath, untitledDisplayNameOf(relPath))
        return
      }

      const tabs = openTabs()
      const existing = tabs.find((t) => t.relPath === relPath)
      const explicitPref = options?.preferredPreviewerId
      const targetPreferred =
        explicitPref !== undefined ? explicitPref : (existing?.preferredPreviewerId ?? null)

      if (!existing) {
        setOpenTabs((prev) => [
          ...prev,
          {
            relPath,
            name: baseNameOf(relPath),
            preferredPreviewerId: targetPreferred,
          },
        ])
      } else if (explicitPref !== undefined && existing.preferredPreviewerId !== explicitPref) {
        setOpenTabs((prev) =>
          prev.map((tab) =>
            tab.relPath === relPath ? { ...tab, preferredPreviewerId: explicitPref } : tab,
          ),
        )
      }

      if (
        selectedPath() === relPath &&
        fileMeta()?.relPath === relPath &&
        !error()
      ) {
        setPreferredPreviewerIdState(targetPreferred)
        return
      }

      await loadMeta(relPath, targetPreferred)
    },

    openUntitledTab(relPath: string, name: string) {
      openUntitledTabImpl(relPath, name)
    },

    requestSaveAs(relPath: string, presetError?: string | null) {
      setPendingSaveAsError(presetError ?? null)
      setPendingSaveAs(relPath)
    },

    cancelSaveAs() {
      setPendingSaveAs(null)
      setPendingSaveAsError(null)
    },

    syncFileMeta(meta: FileMeta) {
      if (selectedPath() === meta.relPath) {
        setFileMeta(meta)
      }
    },

    async refreshCurrentFile() {
      const current = selectedPath()
      if (!current || isUntitledPath(current)) return
      await loadMeta(current, preferredPreviewerId())
    },

    async closeTab(relPath: string) {
      const currentTabs = openTabs()
      const idx = currentTabs.findIndex((t) => t.relPath === relPath)
      if (idx === -1) return

      const nextTabs = currentTabs.filter((t) => t.relPath !== relPath)
      setOpenTabs(nextTabs)

      if (selectedPath() !== relPath) return

      const fallback = nextTabs[idx] ?? nextTabs[idx - 1]
      if (fallback) {
        await loadMeta(fallback.relPath, fallback.preferredPreviewerId)
      } else {
        clearSelectionState()
      }
    },

    async closeOtherTabs(relPath: string) {
      const target = openTabs().find((t) => t.relPath === relPath)
      if (!target) return
      setOpenTabs([target])
      if (selectedPath() !== target.relPath) {
        await loadMeta(target.relPath, target.preferredPreviewerId)
      }
    },

    closeAllTabs() {
      setOpenTabs([])
      clearSelectionState()
    },

    async activateAdjacentTab(delta: 1 | -1) {
      const tabs = openTabs()
      if (tabs.length <= 1) return
      const current = selectedPath()
      const idx = tabs.findIndex((t) => t.relPath === current)
      const baseIdx = idx === -1 ? 0 : idx
      const nextIdx = (baseIdx + delta + tabs.length) % tabs.length
      const target = tabs[nextIdx]
      if (target) {
        await loadMeta(target.relPath, target.preferredPreviewerId)
      }
    },

    async renamePaths(oldRelPath: string, newRelPath: string, isDir: boolean) {
      let tabsChanged = false
      setOpenTabs((prev) => {
        const next = prev.map((tab) => {
          const mapped = remapPath(tab.relPath, oldRelPath, newRelPath, isDir)
          if (mapped && mapped !== tab.relPath) {
            tabsChanged = true
            return {
              ...tab,
              relPath: mapped,
              name: baseNameOf(mapped),
            }
          }
          return tab
        })
        return tabsChanged ? next : prev
      })

      const current = selectedPath()
      if (!current) return
      const mappedSelected = remapPath(current, oldRelPath, newRelPath, isDir)
      if (mappedSelected && mappedSelected !== current) {
        const existingMeta = fileMeta()
        if (existingMeta && existingMeta.relPath === current) {
          setFileMeta({
            ...existingMeta,
            relPath: mappedSelected,
            name: baseNameOf(mappedSelected),
          })
        }
        await loadMeta(mappedSelected, preferredPreviewerId())
      }
    },

    async removePaths(relPath: string, isDir: boolean) {
      const currentTabs = openTabs()
      const activePath = selectedPath()
      const activeIdx = activePath ? currentTabs.findIndex((t) => t.relPath === activePath) : -1
      const nextTabs = currentTabs.filter((t) => !matchesPath(t.relPath, relPath, isDir))
      if (nextTabs.length !== currentTabs.length) {
        setOpenTabs(nextTabs)
      }

      if (!activePath || !matchesPath(activePath, relPath, isDir)) {
        return
      }

      const fallback = nextTabs[Math.min(Math.max(activeIdx, 0), nextTabs.length - 1)]
      if (fallback) {
        await loadMeta(fallback.relPath, fallback.preferredPreviewerId)
      } else {
        clearSelectionState()
      }
    },

    clearSelection() {
      clearSelectionState()
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

export const THEME_STORAGE_KEY = 'lite-ide.theme.v1'

function readStoredTheme(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'dark'
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function applyThemeToDom(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = mode
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
}

export function createThemeState(): ThemeStateService {
  const initial = readStoredTheme()
  applyThemeToDom(initial)
  const [theme, setThemeSignal] = createSignal<ThemeMode>(initial)

  function setTheme(mode: ThemeMode) {
    setThemeSignal(mode)
    applyThemeToDom(mode)
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, mode)
      } catch {
        // Ignore storage quota / privacy errors.
      }
    }
  }

  return {
    theme,
    setTheme,
    toggleTheme() {
      setTheme(theme() === 'dark' ? 'light' : 'dark')
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
          scope.runInScope(() => {
            const selection = createProjectSelection(scope.id, backend)
            const buffers = createEditorBufferService(scope.id, backend, {
              onMetaUpdated: (meta) => selection.syncFileMeta(meta),
            })
            scope.provide(ProjectFsEventsKey, fsEvents)
            scope.provide(ProjectSelectionKey, selection)
            scope.provide(EditorBufferKey, buffers)

            const unsub = fsEvents.on('delta', (delta) => {
              void buffers.handleFsDelta(delta)
              const current = selection.selectedPath()
              if (
                current &&
                !buffers.hasBuffer(current) &&
                (delta.overflow || delta.affectedPaths.includes(current))
              ) {
                void selection.refreshCurrentFile()
              }
            })
            scope.onDispose(unsub)
            scope.onDispose(() => fsEvents.clear())
          })
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
  kernel.provide(ThemeStateKey, createThemeState())
  kernel.provide(ConfirmDialogKey, createConfirmDialogService())
  return kernel
}
