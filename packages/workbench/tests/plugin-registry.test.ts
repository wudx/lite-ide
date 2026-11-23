import { createAppKernel, type AppKernel, type Plugin } from '@lite-ide/kernel'
import type {
  CatalogPlugin,
  DirEntry,
  FileMeta,
  InstalledPlugin,
  PluginListResult,
  ProjectInfo,
  TextPayload,
  WorkspaceBackend,
  WriteTextResult,
} from '@lite-ide/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_API_VERSION } from '../src/plugin-host'
import {
  createPluginRegistry,
  evaluateExternalPlugin,
  type EmbeddedPluginSource,
} from '../src/plugin-registry'

const DISABLED_STORAGE_KEY = 'lite-ide.plugins.disabled.v1'

const THEME_SOURCE = `
liteide.plugin({
  activate(ctx) {
    return ctx.contribute('theme', {
      id: 'fake-theme',
      label: 'Fake Theme',
      appearance: 'dark',
      variables: { '--bg-app': '#111111' },
    })
  },
})
`

function makeManifest(id: string) {
  return { id, name: id, version: '1.0.0', main: 'main.js' }
}

/** In-memory plugin-capable backend; unrelated WorkspaceBackend methods throw. */
function createFakePluginBackend() {
  const store = new Map<
    string,
    { manifest: InstalledPlugin['manifest']; mainJs: string; installedMs: number; error?: string }
  >()

  const backend: WorkspaceBackend = {
    kind: 'mock',
    openProject(): Promise<ProjectInfo> {
      throw new Error('not used')
    },
    closeProject(): Promise<void> {
      throw new Error('not used')
    },
    listDir(): Promise<DirEntry[]> {
      throw new Error('not used')
    },
    statPreview(): Promise<FileMeta> {
      throw new Error('not used')
    },
    readText(): Promise<TextPayload> {
      throw new Error('not used')
    },
    writeText(): Promise<WriteTextResult> {
      throw new Error('not used')
    },
    createFile(): Promise<FileMeta> {
      throw new Error('not used')
    },
    createDir(): Promise<DirEntry> {
      throw new Error('not used')
    },
    renamePath(): Promise<DirEntry> {
      throw new Error('not used')
    },
    deletePath(): Promise<void> {
      throw new Error('not used')
    },
    pickFolder(): Promise<string | null> {
      throw new Error('not used')
    },
    pluginList(): Promise<PluginListResult> {
      const plugins: InstalledPlugin[] = [...store.values()]
        .sort((a, b) => a.installedMs - b.installedMs)
        .map((e) => ({
          manifest: e.manifest,
          dirName: e.manifest.id,
          installedMs: e.installedMs,
          error: e.error ?? null,
        }))
      return Promise.resolve({ rootPath: 'C:/fake/plugins', plugins })
    },
    pluginInstallFromCatalog(catalogId: string): Promise<InstalledPlugin> {
      const existing = store.get(catalogId)
      if (existing) {
        return Promise.reject(new Error(`Plugin "${catalogId}" is already installed`))
      }
      const entry = {
        manifest: makeManifest(catalogId),
        mainJs: THEME_SOURCE,
        installedMs: Date.now(),
      }
      store.set(catalogId, entry)
      return Promise.resolve({
        manifest: entry.manifest,
        dirName: catalogId,
        installedMs: entry.installedMs,
        error: null,
      })
    },
    pluginUninstall(pluginId: string): Promise<void> {
      if (!store.delete(pluginId)) {
        return Promise.reject(new Error(`Plugin not installed: ${pluginId}`))
      }
      return Promise.resolve()
    },
    pluginReadEntry(pluginId: string): Promise<string> {
      const entry = store.get(pluginId)
      if (!entry) return Promise.reject(new Error(`Plugin not installed: ${pluginId}`))
      return Promise.resolve(entry.mainJs)
    },
    pluginCatalog(): Promise<CatalogPlugin[]> {
      return Promise.resolve([
        { manifest: makeManifest('fake-plugin') },
        { manifest: makeManifest('another-plugin') },
      ])
    },
  }

  return {
    backend,
    store,
    installBroken(
      id: string,
      source: string,
      error?: string,
      manifest?: Partial<InstalledPlugin['manifest']>,
    ) {
      store.set(id, {
        manifest: { ...makeManifest(id), ...manifest },
        mainJs: source,
        installedMs: Date.now(),
        error,
      })
    },
  }
}

function createKernel(): AppKernel {
  return createAppKernel({
    host: {
      async open(): Promise<never> {
        throw new Error('projects are not used in this test')
      },
    },
  })
}

function themeIds(kernel: AppKernel): string[] {
  return kernel.contributions('theme')().map((t) => t.id)
}

afterEach(() => {
  localStorage.removeItem(DISABLED_STORAGE_KEY)
})

describe('evaluateExternalPlugin', () => {
  it('captures the liteide.plugin definition as a kernel Plugin', () => {
    const plugin = evaluateExternalPlugin(`liteide.plugin({ name: 'Custom', activate() {} })`, {
      pluginId: 'sample-id',
      format: 'classic',
      loadChunk: async () => ({}),
    })
    expect(plugin.id).toBe('sample-id')
    expect(plugin.name).toBe('Custom')
    expect(typeof plugin.activate).toBe('function')
  })

  it('falls back to the id for name and rejects invalid definitions', () => {
    const plugin = evaluateExternalPlugin(`liteide.plugin({ activate() {} })`, {
      pluginId: 'sample-id',
      format: 'classic',
      loadChunk: async () => ({}),
    })
    expect(plugin.name).toBe('sample-id')

    expect(() =>
      evaluateExternalPlugin(`window.alert('no registration')`, {
        pluginId: 'x',
        format: 'classic',
        loadChunk: async () => ({}),
      }),
    ).toThrow(/never calls liteide/)
    expect(() =>
      evaluateExternalPlugin(`liteide.plugin({})`, {
        pluginId: 'x',
        format: 'classic',
        loadChunk: async () => ({}),
      }),
    ).toThrow(/activate/)
  })

  it('restores a pre-existing liteide global afterwards', () => {
    const holder = globalThis as Record<string, unknown>
    const sentinel = { plugin() {} }
    holder.liteide = sentinel
    try {
      evaluateExternalPlugin(`liteide.plugin({ activate() {} })`, {
        pluginId: 'x',
        format: 'classic',
        loadChunk: async () => ({}),
      })
      expect(holder.liteide).toBe(sentinel)
    } finally {
      delete holder.liteide
    }
  })
})

describe('evaluateExternalPlugin (bundle format)', () => {
  const evalBundle = (source: string, pluginId = 'bundle-id') =>
    evaluateExternalPlugin(source, {
      pluginId,
      format: 'bundle',
      loadChunk: async () => ({}),
    })

  it('evaluates a CJS bundle against the host require table', () => {
    const plugin = evalBundle(`
      const liteide = require('liteide');
      const solid = require('solid-js');
      module.exports = {
        default: {
          name: 'Bundled',
          activate(ctx) {
            ctx.api = liteide.apiVersion;
            ctx.hasSignal = typeof solid.createSignal;
          },
        },
      };
    `)
    expect(plugin.id).toBe('bundle-id')
    expect(plugin.name).toBe('Bundled')

    const seen: Record<string, unknown> = {}
    plugin.activate(seen as never)
    expect(seen.api).toBe(HOST_API_VERSION)
    expect(seen.hasSignal).toBe('function')
  })

  it('prefers module.exports.activate over the liteide.plugin capture', () => {
    const plugin = evalBundle(`
      require('liteide').plugin({ name: 'Captured', activate() {} });
      module.exports = { activate(ctx) { ctx.via = 'exports' } };
    `)
    const seen: Record<string, unknown> = {}
    plugin.activate(seen as never)
    expect(seen.via).toBe('exports')
  })

  it('falls back to the captured definition when exports are empty', () => {
    const plugin = evalBundle(`
      require('liteide').plugin({ name: 'Captured', activate(ctx) { ctx.via = 'capture' } });
    `)
    expect(plugin.name).toBe('Captured')
    const seen: Record<string, unknown> = {}
    plugin.activate(seen as never)
    expect(seen.via).toBe('capture')
  })

  it('rejects bundles without an activate function and unknown requires', () => {
    expect(() => evalBundle(`module.exports = {};`)).toThrow(/exports no activate/)
    expect(() => evalBundle(`require('not-provided-by-host');`)).toThrow(/does not provide/)
  })
})

describe('createPluginRegistry', () => {
  it('installs a catalog plugin, activates it and surfaces its contributions', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()

    await registry.installFromCatalog('fake-plugin')
    const states = registry.states()
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      manifest: { id: 'fake-plugin' },
      enabled: true,
      status: 'running',
      error: null,
    })
    expect(themeIds(kernel)).toContain('fake-theme')
    expect(registry.rootPath()).toBe('C:/fake/plugins')
    expect(registry.catalog().map((c) => c.manifest.id)).toEqual([
      'fake-plugin',
      'another-plugin',
    ])
    kernel.dispose()
  })

  it('uninstall removes contributions and state', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()
    await registry.installFromCatalog('fake-plugin')
    expect(themeIds(kernel)).toContain('fake-theme')

    await registry.uninstall('fake-plugin')
    expect(registry.states()).toHaveLength(0)
    expect(themeIds(kernel)).not.toContain('fake-theme')
    kernel.dispose()
  })

  it('installs from a GitHub url through the backend and refreshes', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const githubInstalls: string[] = []
    fake.backend.pluginInstallFromGithub = (url: string) => {
      githubInstalls.push(url)
      fake.store.set('github-plugin', {
        manifest: makeManifest('github-plugin'),
        mainJs: `liteide.plugin({ activate() {} })`,
        installedMs: Date.now(),
      })
      return Promise.resolve({
        manifest: makeManifest('github-plugin'),
        dirName: 'github-plugin',
        installedMs: Date.now(),
        error: null,
      })
    }
    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()

    await registry.installFromGithub('https://github.com/u/r')
    expect(githubInstalls).toEqual(['https://github.com/u/r'])
    const state = registry.states().find((s) => s.manifest.id === 'github-plugin')
    expect(state).toMatchObject({ enabled: true, status: 'running', error: null })
    kernel.dispose()
  })

  it('installFromGithub rejects backends without the capability', async () => {
    const registry = createPluginRegistry(createKernel(), createFakePluginBackend().backend)
    await registry.refresh()
    await expect(registry.installFromGithub('u/r')).rejects.toThrow(/GitHub/)
  })

  it('disabling deactivates the plugin and persists; a fresh registry stays stopped', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()
    await registry.installFromCatalog('fake-plugin')

    await registry.setEnabled('fake-plugin', false)
    expect(registry.states()[0]).toMatchObject({ enabled: false, status: 'stopped' })
    expect(themeIds(kernel)).not.toContain('fake-theme')
    expect(JSON.parse(localStorage.getItem(DISABLED_STORAGE_KEY)!)).toEqual(['fake-plugin'])

    // 模拟重启：同一存储上新建 kernel + registry，插件保持停用。
    const kernel2 = createKernel()
    const registry2 = createPluginRegistry(kernel2, fake.backend)
    await registry2.refresh()
    expect(registry2.states()[0]).toMatchObject({ enabled: false, status: 'stopped' })
    expect(themeIds(kernel2)).not.toContain('fake-theme')

    // 重新启用：贡献恢复。
    await registry2.setEnabled('fake-plugin', true)
    expect(registry2.states()[0]).toMatchObject({ enabled: true, status: 'running' })
    expect(themeIds(kernel2)).toContain('fake-theme')
    kernel.dispose()
    kernel2.dispose()
  })

  it('records load failures for broken entry scripts and backend errors', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    fake.installBroken('broken-js', `void 0 // never registers anything`)
    fake.installBroken('bad-manifest', THEME_SOURCE, 'invalid plugin.json: bad json')

    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()

    const byId = Object.fromEntries(registry.states().map((s) => [s.manifest.id, s]))
    expect(byId['broken-js'].status).toBe('error')
    expect(byId['broken-js'].error).toMatch(/never calls liteide/)
    expect(byId['bad-manifest'].status).toBe('error')
    expect(byId['bad-manifest'].error).toBe('invalid plugin.json: bad json')
    expect(themeIds(kernel)).not.toContain('fake-theme')
    kernel.dispose()
  })

  it('surfaces id conflicts with already-registered plugins as load errors', async () => {
    const kernel = createKernel()
    kernel.registerPlugin({
      id: 'taken-id',
      name: 'taken',
      activate: () => undefined,
    } satisfies Plugin)

    const fake = createFakePluginBackend()
    fake.installBroken('taken-id', THEME_SOURCE)
    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()

    const state = registry.states().find((s) => s.manifest.id === 'taken-id')
    expect(state?.status).toBe('error')
    expect(state?.error).toMatch(/already registered/)
    kernel.dispose()
  })

  it('reload picks up a repaired entry script without reinstall', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    fake.installBroken('flaky-plugin', `void 0`)
    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()
    expect(registry.states()[0].status).toBe('error')

    // 修复脚本后 reload：无需重装即恢复运行并重新贡献。
    fake.installBroken('flaky-plugin', THEME_SOURCE)
    await registry.reload('flaky-plugin')
    expect(registry.states()[0]).toMatchObject({ status: 'running', error: null })
    expect(themeIds(kernel)).toContain('fake-theme')
    kernel.dispose()
  })

  it('exposes supported=false and stays inert on plugin-less backends', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const { pluginList, ...rest } = fake.backend
    void pluginList
    const bare = rest as WorkspaceBackend

    const registry = createPluginRegistry(kernel, bare)
    await registry.refresh()
    expect(registry.supported).toBe(false)
    expect(registry.states()).toHaveLength(0)
    kernel.dispose()
  })

  it('activates embedded built-ins, flags them embedded and refuses uninstalling them', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const embedded: EmbeddedPluginSource[] = [
      { manifest: makeManifest('embedded-theme'), source: THEME_SOURCE },
    ]
    const registry = createPluginRegistry(kernel, fake.backend, embedded)
    await registry.refresh()

    expect(registry.states()).toHaveLength(1)
    expect(registry.states()[0]).toMatchObject({
      manifest: { id: 'embedded-theme' },
      embedded: true,
      enabled: true,
      status: 'running',
      error: null,
    })
    expect(themeIds(kernel)).toContain('fake-theme')

    await expect(registry.uninstall('embedded-theme')).rejects.toThrow(/内置插件不可卸载/)
    expect(themeIds(kernel)).toContain('fake-theme')
    kernel.dispose()
  })

  it('disabling an embedded built-in deactivates it; enabling restores it', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const registry = createPluginRegistry(kernel, fake.backend, [
      { manifest: makeManifest('embedded-theme'), source: THEME_SOURCE },
    ])
    await registry.refresh()

    await registry.setEnabled('embedded-theme', false)
    expect(registry.states()[0]).toMatchObject({ embedded: true, enabled: false, status: 'stopped' })
    expect(themeIds(kernel)).not.toContain('fake-theme')

    await registry.setEnabled('embedded-theme', true)
    expect(registry.states()[0]).toMatchObject({ enabled: true, status: 'running' })
    expect(themeIds(kernel)).toContain('fake-theme')
    kernel.dispose()
  })

  it('injects the embedded stylesheet while running and removes it on disable', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    const registry = createPluginRegistry(kernel, fake.backend, [
      {
        manifest: { ...makeManifest('emb-css'), format: 'bundle', css: 'plugin.css' },
        source: `module.exports = { activate() {} };`,
        assets: { 'plugin.css': '.emb-marker { color: red; }' },
      },
    ])
    await registry.refresh()

    const selector = 'style[data-liteide-plugin="emb-css"]'
    expect(document.querySelector(selector)?.textContent).toContain('.emb-marker')

    await registry.setEnabled('emb-css', false)
    expect(document.querySelector(selector)).toBeNull()

    await registry.setEnabled('emb-css', true)
    expect(document.querySelector(selector)).not.toBeNull()
    kernel.dispose()
  })

  it('refuses plugins demanding a newer host api version', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    fake.installBroken('future-api', THEME_SOURCE, undefined, { api: HOST_API_VERSION + 1 })

    const registry = createPluginRegistry(kernel, fake.backend)
    await registry.refresh()
    const state = registry.states().find((s) => s.manifest.id === 'future-api')
    expect(state?.status).toBe('error')
    expect(state?.error).toMatch(/plugin API v/)
    expect(themeIds(kernel)).not.toContain('fake-theme')
    kernel.dispose()
  })

  it('loads manifest-declared chunks through the backend asset reader', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    let chunkLoads = 0
    const store = fake.store
    store.set('chunky', {
      manifest: {
        ...makeManifest('chunky'),
        format: 'bundle',
        chunks: { lazy: 'lazy.js' },
      },
      // 同一 chunk 连续请求两次：验证 (plugin, name) 缓存只读一次资产。
      // activate 不返回 Promise（kernel 会把返回值当 Disposable 收进 store）。
      mainJs: `
        module.exports = {
          activate(ctx) {
            const liteide = require('liteide');
            liteide.loadChunk('lazy').then((mod) => { ctx.first = mod.value; });
            liteide.loadChunk('lazy').then((mod) => { ctx.second = mod.value; });
          },
        };
      `,
      installedMs: Date.now(),
    })
    const backendWithAssets = {
      ...fake.backend,
      pluginReadAsset(pluginId: string, fileName: string) {
        void pluginId
        void fileName
        chunkLoads++
        return Promise.resolve(`module.exports = { value: ${chunkLoads} };`)
      },
    } as WorkspaceBackend

    const registry = createPluginRegistry(kernel, backendWithAssets)
    await registry.refresh()
    const state = registry.states().find((s) => s.manifest.id === 'chunky')
    expect(state?.status).toBe('running')

    // 等 activate 里两次 fire-and-forget 的 loadChunk 落地。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(chunkLoads).toBe(1)
    kernel.dispose()
  })

  it('a failing css asset fails activation without leaking contributions and stays retryable', async () => {
    const kernel = createKernel()
    const fake = createFakePluginBackend()
    let assetMissing = true
    const backendWithCss = {
      ...fake.backend,
      pluginReadAsset() {
        return assetMissing
          ? Promise.reject(new Error('plugin asset file "plugin.css" not found'))
          : Promise.resolve('.x { color: red; }')
      },
    } as WorkspaceBackend
    fake.installBroken('css-missing', THEME_SOURCE, undefined, {
      format: 'classic',
      css: 'plugin.css',
    })

    const registry = createPluginRegistry(kernel, backendWithCss)
    await registry.refresh()

    // 资产读取失败 → error 状态；注册发生在读取之后，贡献不残留。
    const state = registry.states().find((s) => s.manifest.id === 'css-missing')
    expect(state?.status).toBe('error')
    expect(state?.error).toContain('plugin.css')
    expect(themeIds(kernel)).not.toContain('fake-theme')
    expect(document.querySelector('style[data-liteide-plugin="css-missing"]')).toBeNull()

    // 停用/启用路径不卡死（不会撞 duplicate id），资产修复后可重试成功。
    await registry.setEnabled('css-missing', false)
    expect(registry.states().find((s) => s.manifest.id === 'css-missing')?.status).toBe('stopped')
    await registry.setEnabled('css-missing', true)
    expect(registry.states().find((s) => s.manifest.id === 'css-missing')?.status).toBe('error')

    assetMissing = false
    await registry.reload('css-missing')
    expect(registry.states().find((s) => s.manifest.id === 'css-missing')?.status).toBe('running')
    expect(themeIds(kernel)).toContain('fake-theme')
    expect(
      document.querySelector('style[data-liteide-plugin="css-missing"]')?.textContent,
    ).toContain('.x')
    kernel.dispose()
  })
})
