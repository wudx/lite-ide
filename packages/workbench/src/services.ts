import {
  createAppKernel,
  createServiceKey,
  EventBus,
  moveWithin,
  type AppKernel,
  type ContributionMap,
  type KernelProjectHost,
  type ProjectScope,
} from '@lite-ide/kernel'
import type { FileMeta, FsDelta, WorkspaceBackend } from '@lite-ide/protocol'
import { batch, createEffect, createMemo, createRoot, createSignal, type Accessor } from 'solid-js'
import { AiModelKey, createAiModelService } from './ai-model'
import { ConfirmDialogKey, createConfirmDialogService, SettingsDialogKey, createSettingsDialogService } from './dialogs'
import {
  createEditorBufferService,
  EditorBufferKey,
  isUntitledPath,
  untitledDisplayNameOf,
} from './editor-buffers'
import { createI18nState, I18nStateKey } from './i18n'
import { createNavigationService, CodeNavigationKey } from './navigation'
import { createPluginRegistry, PluginRegistryKey, type EmbeddedPluginSource } from './plugin-registry'
import { createQuickOpenService, QuickOpenKey } from './quick-open'
import { createSymbolIndexService, SymbolIndexKey } from './symbol-index'

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
  /**
   * 重排文件页签：把 fromIndex 的页签移动到 toIndex（splice 落位语义）。
   * 不改变当前选中文件；越界下标收敛到合法区间，无效变动为 no-op。
   */
  moveTab(fromIndex: number, toIndex: number): void
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
  sidebarViewId(projectId: string): string | null
  toggleSidebar(): void
  setSidebarVisible(visible: boolean): void
  setSidebarWidth(width: number): void
  setSidebarViewId(projectId: string, id: string | null): void
  showSidebarView(projectId: string, id: string): void
}

export interface WorkspaceSearchOptions {
  query?: string
  include?: string
  focusReplace?: boolean
}

export interface WorkspaceSearchLauncher {
  findInFiles(options?: WorkspaceSearchOptions): void
}

/**
 * Bottom panel area state (kernel-level: one shared visibility/height across
 * projects; each project renders its own panel content, kept alive while warm).
 */
export interface PanelStateService {
  readonly visible: Accessor<boolean>
  readonly height: Accessor<number>
  readonly activePanelId: Accessor<string | null>
  toggle(): void
  setVisible(visible: boolean): void
  setActivePanelId(id: string): void
  setHeight(height: number): void
}

export const PANEL_DEFAULT_HEIGHT = 260
export const PANEL_MIN_HEIGHT = 120
export const PANEL_MAX_HEIGHT = 640

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
export const WorkspaceSearchLauncherKey = createServiceKey<WorkspaceSearchLauncher>(
  'workbench.workspaceSearchLauncher',
)
export const PanelStateKey = createServiceKey<PanelStateService>('workbench.panelState')
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

    moveTab(fromIndex: number, toIndex: number) {
      setOpenTabs((prev) => moveWithin(prev, fromIndex, toIndex) ?? prev)
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
  const [sidebarVisible, setSidebarVisibleState] = createSignal(true)
  const [sidebarWidth, setSidebarWidthState] = createSignal(260)
  const [sidebarViewIds, setSidebarViewIds] = createSignal<Record<string, string | null>>({})

  function setSidebarViewId(projectId: string, id: string | null) {
    setSidebarViewIds((prev) => {
      if (prev[projectId] === id) return prev
      return { ...prev, [projectId]: id }
    })
  }

  return {
    sidebarVisible,
    sidebarWidth,
    sidebarViewId(projectId: string) {
      return sidebarViewIds()[projectId] ?? null
    },
    toggleSidebar() {
      setSidebarVisibleState((v) => !v)
    },
    setSidebarVisible(visible: boolean) {
      setSidebarVisibleState(visible)
    },
    setSidebarWidth(width: number) {
      setSidebarWidthState(Math.max(180, Math.min(520, Math.round(width))))
    },
    setSidebarViewId,
    showSidebarView(projectId: string, id: string) {
      setSidebarVisibleState(true)
      setSidebarViewId(projectId, id)
    },
  }
}

export function createPanelState(): PanelStateService {
  const [visible, setVisibleState] = createSignal(false)
  const [height, setHeightState] = createSignal(PANEL_DEFAULT_HEIGHT)
  const [activePanelId, setActivePanelIdState] = createSignal<string | null>(null)

  return {
    visible,
    height,
    activePanelId,
    toggle() {
      setVisibleState((v) => !v)
    },
    setVisible(visible: boolean) {
      setVisibleState(visible)
    },
    setActivePanelId(id: string) {
      setActivePanelIdState(id)
    },
    setHeight(height: number) {
      setHeightState(Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.round(height))))
    },
  }
}

export const THEME_STORAGE_KEY = 'lite-ide.theme.v1'
export const THEME_SNAPSHOT_STORAGE_KEY = 'lite-ide.theme.snapshot.v1'

const THEME_ID_PATTERN = /^[\w-]+$/

function isBuiltinThemeId(id: string): boolean {
  return THEME_DEFINITIONS.some((t) => t.id === id)
}

function readStoredThemeId(): ThemeMode {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME_ID
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    // 插件主题 id 允许通过：启动时注册表可能尚未就绪，由下方 effect 在
    // 插件注册完成后校正；index.html 的 FOUC 脚本按内置白名单与快照兜底首帧。
    return stored && THEME_ID_PATTERN.test(stored) ? stored : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

function readStoredThemeSnapshot(expectedId: string): ThemeDefinition | null {
  if (typeof localStorage === 'undefined' || !expectedId || isBuiltinThemeId(expectedId)) {
    return null
  }
  try {
    const raw = localStorage.getItem(THEME_SNAPSHOT_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as { id?: unknown; appearance?: unknown; variables?: unknown }
    if (
      candidate.id !== expectedId ||
      (candidate.appearance !== 'dark' && candidate.appearance !== 'light')
    ) {
      return null
    }
    let variables: Record<string, string> | undefined
    if (candidate.variables !== undefined) {
      if (!candidate.variables || typeof candidate.variables !== 'object' || Array.isArray(candidate.variables)) {
        return null
      }
      variables = {}
      for (const [k, v] of Object.entries(candidate.variables)) {
        if (typeof v === 'string') variables[k] = v
      }
    }
    return {
      id: candidate.id,
      label: candidate.id,
      appearance: candidate.appearance,
      variables,
    }
  } catch {
    return null
  }
}

function writeStoredThemeSnapshot(definition: ThemeDefinition | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (!definition || isBuiltinThemeId(definition.id)) {
      localStorage.removeItem(THEME_SNAPSHOT_STORAGE_KEY)
      return
    }
    localStorage.setItem(
      THEME_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        id: definition.id,
        appearance: definition.appearance,
        variables: definition.variables,
      }),
    )
  } catch {
    // Ignore storage quota / privacy errors.
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

export interface ThemeStateOptions {
  /**
   * 外部插件是否已完成首轮加载。未就绪期间若命中与当前主题 id 一致的
   * 本地快照，会先沿用快照而非退回默认 dark，避免首帧闪烁。
   */
  pluginsReady?: Accessor<boolean>
}

export function createThemeState(
  kernel?: Pick<AppKernel, 'contributions'>,
  options: ThemeStateOptions = {},
): ThemeStateService {
  // 内置主题在前，插件贡献主题按注册顺序追加；贡献点变化时响应式重算。
  // 按 id 去重保留先注册者（防止残留外部同名主题重复出卡），并保持原引用以免 <For> 重挂载格子。
  const registry = createMemo<readonly ThemeDefinition[]>(() => {
    const seen = new Set<string>()
    const result: ThemeDefinition[] = []
    for (const def of THEME_DEFINITIONS) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      result.push(def)
    }
    for (const def of kernel?.contributions('theme')() ?? []) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      result.push(def)
    }
    return result
  })
  const initialThemeId = readStoredThemeId()
  const initialSnapshot = readStoredThemeSnapshot(initialThemeId)
  // index.html 首帧脚本可能已把快照变量写入 root.style，先登记进清除集合以免切换时残留。
  if (initialSnapshot?.variables) {
    for (const name of Object.keys(initialSnapshot.variables)) {
      injectedVariableNames.add(name)
    }
  }
  const [theme, setThemeSignal] = createSignal<ThemeMode>(initialThemeId)
  const [pendingSnapshot, setPendingSnapshot] = createSignal<ThemeDefinition | null>(initialSnapshot)
  const pluginsReady = options.pluginsReady ?? (() => true)
  const activeDefinition = createMemo(() => registry().find((t) => t.id === theme()))
  const effectiveDefinition = createMemo<ThemeDefinition>(() => {
    const active = activeDefinition()
    if (active) return active
    const snap = pendingSnapshot()
    if (snap && snap.id === theme() && !pluginsReady()) return snap
    return THEME_DEFINITIONS[0]
  })

  function setTheme(mode: ThemeMode) {
    batch(() => {
      setPendingSnapshot(null)
      setThemeSignal(mode)
    })
    const definition = registry().find((t) => t.id === mode)
    // 手动 apply 与下方 effect 的 apply 刻意冗余：保证无 effect 冲刷的环境
    // （如单元测试的同步断言）下 DOM 即时生效；effect 重跑一遍幂等。
    if (definition) {
      applyThemeToDom(definition)
      writeStoredThemeSnapshot(definition)
    } else {
      writeStoredThemeSnapshot(null)
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, mode)
      } catch {
        // Ignore storage quota / privacy errors.
      }
    }
  }

  // Solid 1.9 在 batch 外同步冲刷 effect；若主题来自嵌入式/外部插件，在插件
  // 首轮加载完成前若命中同 id 快照则保持快照渲染，避免先闪默认 dark 再跳回。
  // 插件首轮加载结束后若仍未注册（已卸载/停用），清理过期快照并兜底 dark。
  createRoot(() => {
    createEffect(() => {
      const active = activeDefinition()
      if (active) {
        if (pendingSnapshot() !== null) setPendingSnapshot(null)
        writeStoredThemeSnapshot(active)
        applyThemeToDom(active)
        return
      }
      const snap = pendingSnapshot()
      if (snap && snap.id === theme() && !pluginsReady()) {
        applyThemeToDom(snap)
        return
      }
      if (snap !== null) setPendingSnapshot(null)
      writeStoredThemeSnapshot(null)
      applyThemeToDom(THEME_DEFINITIONS[0])
    })
  })

  return {
    themes: registry,
    theme,
    appearance: createMemo<ThemeAppearance>(() => effectiveDefinition().appearance),
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

            // Symbol index + navigation: dirty editor buffers override disk
            // reads so positions stay in sync with what the user sees.
            const symbolIndex = createSymbolIndexService(backend, scope.id, {
              getContentOverride: (relPath) => buffers.getBuffer(relPath)?.content ?? null,
            })
            scope.provide(SymbolIndexKey, symbolIndex)
            scope.provide(CodeNavigationKey, createNavigationService(selection, symbolIndex))
            scope.onDispose(fsEvents.on('delta', () => symbolIndex.invalidate()))

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
  options: { embeddedPlugins?: readonly EmbeddedPluginSource[] } = {},
): AppKernel {
  const kernel = createAppKernel({
    host: createKernelHostFromBackend(backend),
    maxWarmProjects,
  })
  const [pluginsReady, setPluginsReady] = createSignal(false)
  kernel.provide(WorkspaceBackendKey, backend)
  kernel.provide(LayoutStateKey, createLayoutState())
  kernel.provide(PanelStateKey, createPanelState())
  // 传入 kernel：ThemeState / I18nState 需要响应式读取插件贡献点。
  kernel.provide(ThemeStateKey, createThemeState(kernel, { pluginsReady }))
  kernel.provide(I18nStateKey, createI18nState(kernel))
  kernel.provide(ConfirmDialogKey, createConfirmDialogService())
  kernel.provide(SettingsDialogKey, createSettingsDialogService())
  kernel.provide(QuickOpenKey, createQuickOpenService())
  kernel.provide(AiModelKey, createAiModelService())
  // 外部插件注册表：构造时同步激活嵌入式内置插件，并自动从后端拉取已装列表。
  kernel.provide(
    PluginRegistryKey,
    createPluginRegistry(kernel, backend, options.embeddedPlugins ?? [], {
      onInitialRefreshDone: () => setPluginsReady(true),
    }),
  )
  return kernel
}
