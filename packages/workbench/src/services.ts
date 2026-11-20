import {
  createAppKernel,
  createServiceKey,
  EventBus,
  type AppKernel,
  type ContributionMap,
  type KernelProjectHost,
  type ProjectScope,
} from '@lite-ide/kernel'
import type { FileMeta, FsDelta, WorkspaceBackend } from '@lite-ide/protocol'
import { createEffect, createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import { AiModelKey, createAiModelService } from './ai-model'
import { ConfirmDialogKey, createConfirmDialogService, SettingsDialogKey, createSettingsDialogService } from './dialogs'
import {
  createEditorBufferService,
  EditorBufferKey,
  isUntitledPath,
  untitledDisplayNameOf,
} from './editor-buffers'
import { createI18nState, I18nStateKey } from './i18n'
import { createPluginRegistry, PluginRegistryKey } from './plugin-registry'
import { createQuickOpenService, QuickOpenKey } from './quick-open'

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
    options?: {
      preferredPreviewerId?: string | null
      /**
       * When stat fails (path no longer exists, e.g. a Git panel row for a
       * worktree-deleted file), synthesize a stub FileMeta instead of
       * surfacing the error, so previewers that render from other sources
       * (like the git diff view) can still take over.
       */
      allowMissing?: boolean
    },
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

/** 主题 id：内置主题 + 插件注册主题的开放集合。 */
export type ThemeMode = string

export type ThemeAppearance = 'dark' | 'light'

export interface ThemeDefinition {
  id: ThemeMode
  label: string
  labelKey?: string
  /** 明暗基调：驱动根元素 dark/light class 与代码编辑器配色回退 */
  appearance: ThemeAppearance
  /** 激活时以行内样式注入根元素的 CSS 自定义属性；内置主题样式由 app.css 提供故为空 */
  variables?: Record<string, string>
}

/** 内置主题：样式由 app.css 的 [data-theme] 选择器提供（index.html FOUC 脚本维护同名白名单）。 */
export const THEME_DEFINITIONS: readonly ThemeDefinition[] = [
  { id: 'dark', label: '深色', labelKey: 'settings.theme.dark', appearance: 'dark' },
  { id: 'light', label: '浅色', labelKey: 'settings.theme.light', appearance: 'light' },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    labelKey: 'settings.theme.solarized-light',
    appearance: 'light',
  },
]

const DEFAULT_THEME_ID: ThemeMode = 'dark'

/** 内核 theme 贡献点形态（见 ContributionMap['theme']）。 */
export type ThemeContribution = ContributionMap['theme']

export interface ThemeStateService {
  /** 全部可用主题（内置 + 插件贡献），随内核贡献点响应式更新 */
  readonly themes: Accessor<readonly ThemeDefinition[]>
  readonly theme: Accessor<ThemeMode>
  /** 当前主题明暗基调；未知主题按 dark 处理 */
  readonly appearance: Accessor<ThemeAppearance>
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

function fileExtOf(relPath: string): string {
  const name = baseNameOf(relPath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
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

  async function loadMeta(relPath: string, nextPreferred: string | null, allowMissing = false) {
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
      if (allowMissing) {
        setFileMeta({
          projectId,
          relPath,
          name: baseNameOf(relPath),
          ext: fileExtOf(relPath),
          size: 0,
          modifiedMs: 0,
          mime: 'text/plain',
          isBinary: false,
          encoding: '',
        })
        return
      }
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

    async selectFile(
      relPath: string,
      options?: { preferredPreviewerId?: string | null; allowMissing?: boolean },
    ) {
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

      await loadMeta(relPath, targetPreferred, options?.allowMissing ?? false)
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

const THEME_ID_PATTERN = /^[\w-]+$/

function readStoredThemeId(): ThemeMode {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    // 插件主题 id 允许通过：启动时注册表可能尚未就绪，由下方 effect 在
    // 插件注册完成后校正；index.html 的 FOUC 脚本按内置白名单兜底首帧。
    return stored && THEME_ID_PATTERN.test(stored) ? stored : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

/** 曾注入根元素行内样式的变量名全集，切主题时整体清除。只增不减：
 *  多 ThemeState 实例（测试 / HMR 重建内核）共享模块状态时也不会漏清彼此的变量。 */
const injectedVariableNames = new Set<string>()

function applyThemeToDom(definition: ThemeDefinition) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = definition.id
  root.classList.toggle('dark', definition.appearance === 'dark')
  root.classList.toggle('light', definition.appearance !== 'dark')
  for (const name of injectedVariableNames) root.style.removeProperty(name)
  injectedVariableNames.clear()
  if (definition.variables) {
    for (const [name, value] of Object.entries(definition.variables)) {
      root.style.setProperty(name, value)
      injectedVariableNames.add(name)
    }
  }
}

export function createThemeState(kernel?: Pick<AppKernel, 'contributions'>): ThemeStateService {
  // 内置主题在前，插件贡献主题按注册顺序追加；贡献点变化时响应式重算。
  // 贡献项与 ThemeDefinition 结构一致，直接透传以免 <For> 按引用重挂载格子。
  const registry = createMemo<readonly ThemeDefinition[]>(() => [
    ...THEME_DEFINITIONS,
    ...(kernel?.contributions('theme')() ?? []),
  ])
  const [theme, setThemeSignal] = createSignal<ThemeMode>(readStoredThemeId())
  const activeDefinition = createMemo(() => registry().find((t) => t.id === theme()))

  function setTheme(mode: ThemeMode) {
    setThemeSignal(mode)
    const definition = registry().find((t) => t.id === mode)
    // 手动 apply 与下方 effect 的 apply 刻意冗余：保证无 effect 冲刷的环境
    // （如单元测试的同步断言）下 DOM 即时生效；effect 重跑一遍幂等。
    if (definition) applyThemeToDom(definition)
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, mode)
      } catch {
        // Ignore storage quota / privacy errors.
      }
    }
  }

  // Solid 1.9 在 batch 外同步冲刷 effect，插件又于 main.tsx 内同步注册，
  // 因此首帧前注册表即完整。effect 持续跟随注册表：未知 id（存储的插件
  // 主题未注册 / 已卸载 / 存储损坏）只把 DOM 兜底为内置 dark，theme()
  // 保留原 id 且不落盘——插件随后注册（含动态 import 迟到加载）时该主题
  // 会被自动应用。
  createRoot(() => {
    createEffect(() => {
      applyThemeToDom(activeDefinition() ?? THEME_DEFINITIONS[0])
    })
  })

  return {
    themes: registry,
    theme,
    appearance: createMemo<ThemeAppearance>(() => activeDefinition()?.appearance ?? 'dark'),
    setTheme,
    toggleTheme() {
      const defs = registry()
      const idx = defs.findIndex((t) => t.id === theme())
      // idx === -1 (未知主题) 时前进到 0，即内置 dark，随后正常循环。
      setTheme(defs[(idx + 1) % defs.length].id)
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
    pickFolder(options?: { title?: string }) {
      return backend.pickFolder(options)
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
  // 传入 kernel：ThemeState / I18nState 需要响应式读取插件贡献点。
  kernel.provide(ThemeStateKey, createThemeState(kernel))
  kernel.provide(I18nStateKey, createI18nState(kernel))
  kernel.provide(ConfirmDialogKey, createConfirmDialogService())
  kernel.provide(SettingsDialogKey, createSettingsDialogService())
  kernel.provide(QuickOpenKey, createQuickOpenService())
  kernel.provide(AiModelKey, createAiModelService())
  // 外部插件注册表：构造时自动从后端拉取已装列表并激活启用项。
  kernel.provide(PluginRegistryKey, createPluginRegistry(kernel, backend))
  return kernel
}
