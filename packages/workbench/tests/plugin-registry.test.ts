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
import {
  createPluginRegistry,
  evaluateExternalPlugin,
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
    installBroken(id: string, source: string, error?: string) {
      store.set(id, {
        manifest: makeManifest(id),
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
    const plugin = evaluateExternalPlugin(
      `liteide.plugin({ name: 'Custom', activate() {} })`,
      'sample-id',
    )
    expect(plugin.id).toBe('sample-id')
    expect(plugin.name).toBe('Custom')
    expect(typeof plugin.activate).toBe('function')
  })

  it('falls back to the id for name and rejects invalid definitions', () => {
    const plugin = evaluateExternalPlugin(`liteide.plugin({ activate() {} })`, 'sample-id')
    expect(plugin.name).toBe('sample-id')

    expect(() => evaluateExternalPlugin(`window.alert('no registration')`, 'x')).toThrow(
      /never calls liteide/,
    )
    expect(() => evaluateExternalPlugin(`liteide.plugin({})`, 'x')).toThrow(/activate/)
  })

  it('restores a pre-existing liteide global afterwards', () => {
    const holder = globalThis as Record<string, unknown>
    const sentinel = { plugin() {} }
    holder.liteide = sentinel
    try {
      evaluateExternalPlugin(`liteide.plugin({ activate() {} })`, 'x')
      expect(holder.liteide).toBe(sentinel)
    } finally {
      delete holder.liteide
    }
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
})
