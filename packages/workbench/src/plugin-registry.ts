import { createServiceKey, type AppKernel, type Disposable, type Plugin } from '@lite-ide/kernel'
import type {
  CatalogPlugin,
  InstalledPlugin,
  PluginListResult,
  PluginManifest,
  WorkspaceBackend,
} from '@lite-ide/protocol'
import { batch, createMemo, createSignal, type Accessor } from 'solid-js'
import {
  HOST_API_VERSION,
  buildHostRequire,
  evaluateCjsModule,
  injectPluginStyles,
  normalizePluginDefinition,
  removePluginStyles,
  type LiteideHostApi,
} from './plugin-host'

export type ExternalPluginStatus = 'loading' | 'running' | 'stopped' | 'error'

/** Installed plugin merged with runtime load state for the manager UI. */
export interface ExternalPluginState {
  manifest: InstalledPlugin['manifest']
  dirName: string
  installedMs: number
  enabled: boolean
  status: ExternalPluginStatus
  error: string | null
  /** Embedded built-ins ship with the app and cannot be uninstalled. */
  embedded: boolean
}

export interface PluginRegistryService {
  /** True when the registry manages at least one source (embedded or backend). */
  readonly supported: boolean
  readonly states: Accessor<readonly ExternalPluginState[]>
  readonly catalog: Accessor<readonly CatalogPlugin[]>
  /** Managed plugins root (desktop only); null on the browser demo backend. */
  readonly rootPath: Accessor<string | null>
  refresh(): Promise<void>
  installFromCatalog(catalogId: string): Promise<void>
  installFromPath(sourcePath: string): Promise<void>
  installFromGithub(url: string): Promise<void>
  uninstall(pluginId: string): Promise<void>
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  reload(pluginId: string): Promise<void>
}

export const PluginRegistryKey = createServiceKey<PluginRegistryService>(
  'workbench.pluginRegistry',
)

const DISABLED_STORAGE_KEY = 'lite-ide.plugins.disabled.v1'

/**
 * An embedded built-in plugin: dist bundle inlined into the app (via `?raw`
 * imports in apps/desktop) and loaded through the same evaluator as
 * user-installed plugins — the "built-in extension" distribution model.
 */
export interface EmbeddedPluginSource {
  manifest: PluginManifest
  source: string
  /** Bare filename → asset text (stylesheet / chunks), matching the manifest. */
  assets?: Record<string, string>
}

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

export interface EvaluateOptions {
  pluginId: string
  format: 'classic' | 'bundle'
  loadChunk(name: string): Promise<Record<string, unknown>>
}

/**
 * Evaluates an external plugin entry and normalizes the registered
 * definition. CSP 未启用（tauri.conf.json csp: null），`new Function` 可用。
 *
 * - `classic`: plain script under a swapped `globalThis.liteide` capture
 *   shim (restored afterwards); registers via `liteide.plugin({...})`.
 * - `bundle`: CommonJS source whose `require` resolves through the host
 *   module table; accepts `module.exports.activate`,
 *   `module.exports.default` or a `liteide.plugin()` capture.
 */
export function evaluateExternalPlugin(source: string, options: EvaluateOptions): Plugin {
  const { pluginId, format } = options

  if (format === 'bundle') {
    let captured: unknown
    const liteide: LiteideHostApi = {
      apiVersion: HOST_API_VERSION,
      plugin(def) {
        if (captured !== undefined) {
          throw new Error(`Plugin "${pluginId}" calls liteide.plugin() more than once`)
        }
        captured = def
      },
      loadChunk: options.loadChunk,
    }
    const hostRequire = buildHostRequire(liteide)
    const exports = evaluateCjsModule(source, hostRequire, liteide)
    const normalized = normalizePluginDefinition(pluginId, exports, captured)
    return { id: pluginId, name: normalized.name, activate: normalized.activate }
  }

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

export interface PluginRegistryOptions {
  /** Invoked once the initial plugin list & activation pass finishes. */
  onInitialRefreshDone?: () => void
}

export function createPluginRegistry(
  kernel: AppKernel,
  backend: WorkspaceBackend,
  embeddedPlugins: readonly EmbeddedPluginSource[] = [],
  options: PluginRegistryOptions = {},
): PluginRegistryService {
  const embeddedByManifest = new Map(embeddedPlugins.map((e) => [e.manifest.id, e]))
  const supported = embeddedPlugins.length > 0 || typeof backend.pluginList === 'function'
  const [installed, setInstalled] = createSignal<readonly InstalledPlugin[]>([])
  const [rootPath, setRootPath] = createSignal<string | null>(null)
  const [catalog, setCatalog] = createSignal<readonly CatalogPlugin[]>([])
  const [disabledIds, setDisabledIds] = createSignal<ReadonlySet<string>>(readDisabledIds())
  const [runtime, setRuntime] = createSignal<ReadonlyMap<string, { status: ExternalPluginStatus; error: string | null }>>(
    new Map(),
  )

  const running = new Map<string, Disposable>()
  const activating = new Set<string>()
  const chunkCache = new Map<string, Promise<Record<string, unknown>>>()
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
    removePluginStyles(id)
    setRuntimeEntry(id, 'stopped', null)
  }

  /** Reads a manifest-declared asset from the embedded sources or the backend. */
  async function readPluginAsset(
    id: string,
    manifest: PluginManifest,
    fileName: string,
  ): Promise<string> {
    const embedded = embeddedByManifest.get(id)
    if (embedded) {
      const asset = embedded.assets?.[fileName]
      if (typeof asset !== 'string') {
        throw new Error(`Plugin asset not found: ${id}/${fileName}`)
      }
      return asset
    }
    if (!backend.pluginReadAsset) {
      throw new Error('backend does not implement pluginReadAsset')
    }
    return backend.pluginReadAsset(id, fileName)
  }

  function loadChunk(id: string, manifest: PluginManifest, name: string): Promise<Record<string, unknown>> {
    const cacheKey = `${id}:${name}`
    const cached = chunkCache.get(cacheKey)
    if (cached) return cached
    const declared = manifest.chunks?.[name]
    if (!declared) {
      return Promise.reject(new Error(`Plugin "${id}" declares no chunk named "${name}"`))
    }
    const pending = readPluginAsset(id, manifest, declared)
      .then((source) => {
        const chunkLiteide: LiteideHostApi = {
          apiVersion: HOST_API_VERSION,
          plugin() {
            throw new Error(`Plugin "${id}" chunk evaluation must not call liteide.plugin()`)
          },
          loadChunk: (chunkName) => loadChunk(id, manifest, chunkName),
        }
        return evaluateCjsModule(source, buildHostRequire(chunkLiteide), chunkLiteide)
      })
      .catch((err) => {
        // 失败不进缓存：修好资产或重载后允许重新求值。
        chunkCache.delete(cacheKey)
        throw err
      })
    chunkCache.set(cacheKey, pending)
    return pending
  }

  function readEmbeddedSource(id: string): string | null {
    return embeddedByManifest.get(id)?.source ?? null
  }

  function readEmbeddedAssetSync(id: string, fileName: string): string {
    const asset = embeddedByManifest.get(id)?.assets?.[fileName]
    if (typeof asset !== 'string') {
      throw new Error(`Plugin asset not found: ${id}/${fileName}`)
    }
    return asset
  }

  function activateWithAssets(entry: InstalledPlugin, source: string, css: string | null): void {
    const id = entry.manifest.id
    const apiRequired = entry.manifest.api
    if (apiRequired !== undefined && apiRequired > HOST_API_VERSION) {
      throw new Error(
        `plugin requires LiteIDE plugin API v${apiRequired}, but this LiteIDE provides v${HOST_API_VERSION}. 请更新 LiteIDE。`,
      )
    }

    const format: 'classic' | 'bundle' = entry.manifest.format === 'bundle' ? 'bundle' : 'classic'
    const plugin = evaluateExternalPlugin(source, {
      pluginId: id,
      format,
      loadChunk: (name) => loadChunk(id, entry.manifest, name),
    })
    const disposable = kernel.registerPlugin(plugin)
    running.set(id, disposable)

    // Stylesheet asset: injected while running, removed on deactivate.
    if (css !== null) {
      injectPluginStyles(id, css)
    }

    setRuntimeEntry(id, 'running', null)
  }

  function recordActivationError(id: string, err: unknown): void {
    // 激活失败的可诊断性：设置页只展示 message，这里补一条带堆栈的日志。
    console.error(`[plugin-registry] failed to activate plugin "${id}"`, err)
    running.delete(id)
    setRuntimeEntry(id, 'error', err instanceof Error ? err.message : String(err))
  }

  function activateEmbeddedSync(emb: EmbeddedPluginSource): void {
    const id = emb.manifest.id
    if (running.has(id) || activating.has(id)) return
    if (disabledIds().has(id)) {
      setRuntimeEntry(id, 'stopped', null)
      return
    }
    activating.add(id)
    setRuntimeEntry(id, 'loading', null)
    try {
      const css = emb.manifest.css ? readEmbeddedAssetSync(id, emb.manifest.css) : null
      const entry: InstalledPlugin = {
        manifest: emb.manifest,
        dirName: id,
        installedMs: 0,
        error: null,
      }
      activateWithAssets(entry, emb.source, css)
    } catch (err) {
      recordActivationError(id, err)
    } finally {
      activating.delete(id)
    }
  }

  async function activate(entry: InstalledPlugin, isEmbedded: boolean): Promise<void> {
    const id = entry.manifest.id
    // 并发保护：构造期 refresh 与手动启用/重载可能同时触发同一插件。
    if (running.has(id) || activating.has(id)) return
    activating.add(id)
    setRuntimeEntry(id, 'loading', null)
    try {
      const source = isEmbedded
        ? readEmbeddedSource(id)
        : typeof backend.pluginReadEntry === 'function'
          ? await backend.pluginReadEntry(id)
          : null
      if (source === null) {
        throw new Error(
          isEmbedded
            ? 'embedded plugin source is missing'
            : 'backend does not implement pluginReadEntry',
        )
      }

      // 样式资产先读后注册：资产读取失败时插件未注册，不会留下半激活状态
      // （若注册后再读，失败路径需 dispose 补偿，且重激活会撞 duplicate id）。
      let css: string | null = null
      if (entry.manifest.css) {
        css = isEmbedded
          ? readEmbeddedAssetSync(id, entry.manifest.css)
          : await readPluginAsset(id, entry.manifest, entry.manifest.css)
      }

      activateWithAssets(entry, source, css)
    } catch (err) {
      recordActivationError(id, err)
    } finally {
      activating.delete(id)
    }
  }

  /** Merged view: embedded built-ins first, then backend-managed installs. */
  function mergedInstalled(): readonly InstalledPlugin[] {
    const backendEntries = installed()
    const embeddedEntries: InstalledPlugin[] = embeddedPlugins.map((e) => ({
      manifest: e.manifest,
      dirName: e.manifest.id,
      installedMs: 0,
      error: null,
    }))
    const embeddedIds = new Set(embeddedEntries.map((e) => e.manifest.id))
    return [...embeddedEntries, ...backendEntries.filter((e) => !embeddedIds.has(e.manifest.id))]
  }

  /** Re-reads the installed list and reconciles running plugins with it. */
  async function refresh(): Promise<void> {
    const seq = ++refreshSeq
    if (backend.pluginList) {
      try {
        const result: PluginListResult = await backend.pluginList()
        if (seq !== refreshSeq) return
        batch(() => {
          setRootPath(result.rootPath)
          setInstalled(result.plugins)
        })
      } catch {
        // 后端列表读取失败不阻断嵌入式内置插件激活（保持既有已装快照）。
      }
    }

    // 卸载残留（列表里已消失的）先下线，再补齐启用项。
    const known = new Set(mergedInstalled().map((p) => p.manifest.id))
    for (const id of [...running.keys()]) {
      if (!known.has(id)) deactivate(id)
    }

    for (const entry of mergedInstalled()) {
      const id = entry.manifest.id
      if (entry.error) {
        deactivate(id)
        setRuntimeEntry(id, 'error', entry.error)
        continue
      }
      const enabled = !disabledIds().has(id)
      if (enabled && !running.has(id)) {
        await activate(entry, embeddedByManifest.has(id))
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
    mergedInstalled().map((entry) => {
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
        embedded: embeddedByManifest.has(id),
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

    async installFromGithub(url: string): Promise<void> {
      if (!backend.pluginInstallFromGithub) {
        throw new Error('当前后端不支持从 GitHub 安装插件')
      }
      await backend.pluginInstallFromGithub(url)
      // 新装插件默认启用：不在 disabled 名单即自动激活。
      await refresh()
    },

    async uninstall(pluginId: string): Promise<void> {
      if (embeddedByManifest.has(pluginId)) {
        throw new Error('内置插件不可卸载，可在设置中停用')
      }
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
        const entry = mergedInstalled().find((p) => p.manifest.id === pluginId)
        if (entry && !entry.error) await activate(entry, embeddedByManifest.has(pluginId))
      } else {
        deactivate(pluginId)
        // 与 refresh() 的停用分支对齐：未激活插件的陈旧 error 一并清成 stopped，
        // 否则停用一个加载失败的插件仍显示 error（诊断信息已随行展示）。
        if (!running.has(pluginId)) setRuntimeEntry(pluginId, 'stopped', null)
      }
    },

    async reload(pluginId: string): Promise<void> {
      deactivate(pluginId)
      // 只清该插件的 chunk 缓存（key 前缀 `${id}:`），不动其他插件的。
      for (const key of [...chunkCache.keys()]) {
        if (key.startsWith(`${pluginId}:`)) chunkCache.delete(key)
      }
      const entry = mergedInstalled().find((p) => p.manifest.id === pluginId)
      if (entry && !entry.error) await activate(entry, embeddedByManifest.has(pluginId))
    },
  }

  // 嵌入式内置插件源码与样式已在内存中，构造期同步激活，避免首帧渲染后再跳变（如内置主题/侧栏）。
  for (const emb of embeddedPlugins) {
    activateEmbeddedSync(emb)
  }

  if (backend.pluginCatalog) {
    void backend.pluginCatalog().then(setCatalog, () => setCatalog([]))
  }
  if (supported) {
    void refresh()
      .catch(() => {
        // 列表读取失败：保持空列表，UI 由 supported/空态兜底。
      })
      .finally(() => {
        options.onInitialRefreshDone?.()
      })
  } else {
    options.onInitialRefreshDone?.()
  }

  return service
}
