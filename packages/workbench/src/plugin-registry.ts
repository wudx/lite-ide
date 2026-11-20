import { createServiceKey, type AppKernel, type Disposable, type Plugin } from '@lite-ide/kernel'
import type {
  CatalogPlugin,
  InstalledPlugin,
  PluginListResult,
  WorkspaceBackend,
} from '@lite-ide/protocol'
import { batch, createMemo, createSignal, type Accessor } from 'solid-js'

export type ExternalPluginStatus = 'loading' | 'running' | 'stopped' | 'error'

/** Installed plugin merged with runtime load state for the manager UI. */
export interface ExternalPluginState {
  manifest: InstalledPlugin['manifest']
  dirName: string
  installedMs: number
  enabled: boolean
  status: ExternalPluginStatus
  error: string | null
}

export interface PluginRegistryService {
  /** True when the backend implements plugin management. */
  readonly supported: boolean
  readonly states: Accessor<readonly ExternalPluginState[]>
  readonly catalog: Accessor<readonly CatalogPlugin[]>
  /** Managed plugins root (desktop only); null on the browser demo backend. */
  readonly rootPath: Accessor<string | null>
  refresh(): Promise<void>
  installFromCatalog(catalogId: string): Promise<void>
  installFromPath(sourcePath: string): Promise<void>
  uninstall(pluginId: string): Promise<void>
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  reload(pluginId: string): Promise<void>
}

export const PluginRegistryKey = createServiceKey<PluginRegistryService>(
  'workbench.pluginRegistry',
)

const DISABLED_STORAGE_KEY = 'lite-ide.plugins.disabled.v1'

function readDisabledIds(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(DISABLED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function writeDisabledIds(ids: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DISABLED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

/**
 * Evaluates an external plugin's classic entry script and captures the
 * definition registered through the injected `liteide.plugin({...})` global.
 * CSP 未启用（tauri.conf.json csp: null），`new Function` 可用；脚本在
 * 独立全局捕获层下执行，结束后恢复 `liteide` 全局的旧值。
 */
export function evaluateExternalPlugin(source: string, pluginId: string): Plugin {
  const holder = globalThis as Record<string, unknown>
  const previous = holder.liteide
  let captured: unknown

  holder.liteide = {
    plugin(def: unknown) {
      if (captured !== undefined) {
        throw new Error(`Plugin "${pluginId}" calls liteide.plugin() more than once`)
      }
      captured = def
    },
  }

  try {
    // 经典脚本（samples/plugins 的 main.js），与应用自身代码同源策略下执行。
    new Function(source)()
  } finally {
    if (previous === undefined) {
      delete holder.liteide
    } else {
      holder.liteide = previous
    }
  }

  if (captured === null || typeof captured !== 'object') {
    throw new Error(`Plugin "${pluginId}" never calls liteide.plugin({...})`)
  }
  const def = captured as { name?: unknown; activate?: unknown }
  if (typeof def.activate !== 'function') {
    throw new Error(`Plugin "${pluginId}" registers no activate() function`)
  }

  return {
    // manifest id 为注册键（与安装目录一致）；def.id 若存在则忽略。
    id: pluginId,
    name: typeof def.name === 'string' && def.name.trim() ? def.name : pluginId,
    activate: def.activate as Plugin['activate'],
  }
}

export function createPluginRegistry(
  kernel: AppKernel,
  backend: WorkspaceBackend,
): PluginRegistryService {
  const supported = typeof backend.pluginList === 'function'
  const [installed, setInstalled] = createSignal<readonly InstalledPlugin[]>([])
  const [rootPath, setRootPath] = createSignal<string | null>(null)
  const [catalog, setCatalog] = createSignal<readonly CatalogPlugin[]>([])
  const [disabledIds, setDisabledIds] = createSignal<ReadonlySet<string>>(readDisabledIds())
  const [runtime, setRuntime] = createSignal<ReadonlyMap<string, { status: ExternalPluginStatus; error: string | null }>>(
    new Map(),
  )

  const running = new Map<string, Disposable>()
  const activating = new Set<string>()
  let refreshSeq = 0

  function setRuntimeEntry(id: string, status: ExternalPluginStatus, error: string | null) {
    setRuntime((prev) => {
      const next = new Map(prev)
      next.set(id, { status, error })
      return next
    })
  }

  function deactivate(id: string) {
    const disposable = running.get(id)
    if (!disposable) return
    running.delete(id)
    disposable.dispose()
    setRuntimeEntry(id, 'stopped', null)
  }

  async function activate(entry: InstalledPlugin): Promise<void> {
    const id = entry.manifest.id
    // 并发保护：构造期 refresh 与手动启用/重载可能同时触发同一插件。
    if (running.has(id) || activating.has(id)) return
    if (!backend.pluginReadEntry) {
      setRuntimeEntry(id, 'error', 'backend does not implement pluginReadEntry')
      return
    }
    activating.add(id)
    setRuntimeEntry(id, 'loading', null)
    try {
      const source = await backend.pluginReadEntry(id)
      const plugin = evaluateExternalPlugin(source, id)
      const disposable = kernel.registerPlugin(plugin)
      running.set(id, disposable)
      setRuntimeEntry(id, 'running', null)
    } catch (err) {
      running.delete(id)
      setRuntimeEntry(id, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      activating.delete(id)
    }
  }

  /** Re-reads the installed list and reconciles running plugins with it. */
  async function refresh(): Promise<void> {
    if (!backend.pluginList) return
    const seq = ++refreshSeq
    const result: PluginListResult = await backend.pluginList()
    if (seq !== refreshSeq) return

    batch(() => {
      setRootPath(result.rootPath)
      setInstalled(result.plugins)
    })

    // 卸载残留（列表里已消失的）先下线，再补齐启用项。
    const known = new Set(result.plugins.map((p) => p.manifest.id))
    for (const id of [...running.keys()]) {
      if (!known.has(id)) deactivate(id)
    }

    for (const entry of result.plugins) {
      const id = entry.manifest.id
      if (entry.error) {
        deactivate(id)
        setRuntimeEntry(id, 'error', entry.error)
        continue
      }
      const enabled = !disabledIds().has(id)
      if (enabled && !running.has(id)) {
        await activate(entry)
      } else if (!enabled && running.has(id)) {
        deactivate(id)
      } else if (!enabled) {
        setRuntimeEntry(id, 'stopped', null)
      }
    }
  }

  function persistDisabled(ids: Set<string>) {
    setDisabledIds(new Set(ids))
    writeDisabledIds(ids)
  }

  const states = createMemo<readonly ExternalPluginState[]>(() =>
    installed().map((entry) => {
      const id = entry.manifest.id
      const enabled = !disabledIds().has(id)
      const rt = runtime().get(id)
      const status: ExternalPluginStatus = entry.error
        ? 'error'
        : rt?.status ?? (enabled ? 'loading' : 'stopped')
      return {
        manifest: entry.manifest,
        dirName: entry.dirName,
        installedMs: entry.installedMs,
        enabled,
        status,
        error: rt?.error ?? entry.error ?? null,
      }
    }),
  )

  const service: PluginRegistryService = {
    supported,
    states,
    catalog,
    rootPath,

    refresh,

    async installFromCatalog(catalogId: string): Promise<void> {
      if (!backend.pluginInstallFromCatalog) {
        throw new Error('当前后端不支持从目录安装插件')
      }
      await backend.pluginInstallFromCatalog(catalogId)
      // 新装插件默认启用：不在 disabled 名单即自动激活。
      await refresh()
    },

    async installFromPath(sourcePath: string): Promise<void> {
      if (!backend.pluginInstallFromPath) {
        throw new Error('当前后端不支持从文件夹安装插件')
      }
      await backend.pluginInstallFromPath(sourcePath)
      await refresh()
    },

    async uninstall(pluginId: string): Promise<void> {
      deactivate(pluginId)
      if (backend.pluginUninstall) {
        await backend.pluginUninstall(pluginId)
      }
      // 清掉停用标记，重装后恢复默认启用。
      if (disabledIds().has(pluginId)) {
        const next = new Set(disabledIds())
        next.delete(pluginId)
        persistDisabled(next)
      }
      await refresh()
    },

    async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
      const next = new Set(disabledIds())
      if (enabled) {
        next.delete(pluginId)
      } else {
        next.add(pluginId)
      }
      persistDisabled(next)

      if (enabled) {
        const entry = installed().find((p) => p.manifest.id === pluginId)
        if (entry && !entry.error) await activate(entry)
      } else {
        deactivate(pluginId)
      }
    },

    async reload(pluginId: string): Promise<void> {
      deactivate(pluginId)
      const entry = installed().find((p) => p.manifest.id === pluginId)
      if (entry && !entry.error) await activate(entry)
    },
  }

  if (backend.pluginCatalog) {
    void backend.pluginCatalog().then(setCatalog, () => setCatalog([]))
  }
  if (supported) {
    void refresh().catch(() => {
      // 列表读取失败：保持空列表，UI 由 supported/空态兜底。
    })
  }

  return service
}
