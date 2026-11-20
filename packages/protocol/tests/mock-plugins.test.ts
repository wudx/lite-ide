import { afterEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '../src/mock-backend'
import { BUILTIN_PLUGIN_SAMPLES } from '../src/plugin-samples'

const STORE_KEY = 'lite-ide.mock-plugins.v1'

afterEach(() => {
  localStorage.removeItem(STORE_KEY)
})

describe('mock backend plugin management', () => {
  it('serves the built-in sample catalog', async () => {
    const backend = createMockBackend()
    const catalog = await backend.pluginCatalog!()
    expect(catalog.map((c) => c.manifest.id)).toEqual(
      BUILTIN_PLUGIN_SAMPLES.map((s) => s.manifest.id),
    )
    // 全新存储下已安装列表为空。
    expect((await backend.pluginList!()).plugins).toEqual([])
  })

  it('installs, lists, reads and uninstalls a catalog plugin', async () => {
    const backend = createMockBackend()
    const installed = await backend.pluginInstallFromCatalog!('hello-status')
    expect(installed.manifest.id).toBe('hello-status')
    expect(installed.dirName).toBe('hello-status')
    expect(installed.error).toBeNull()

    const list = await backend.pluginList!()
    expect(list.rootPath).toBeNull()
    expect(list.plugins).toHaveLength(1)
    expect(list.plugins[0].manifest.name).toBe('Hello Status')

    const entry = await backend.pluginReadEntry!('hello-status')
    expect(entry).toContain('liteide.plugin')

    await backend.pluginUninstall!('hello-status')
    expect((await backend.pluginList!()).plugins).toEqual([])
    await expect(backend.pluginReadEntry!('hello-status')).rejects.toThrow(/not installed/)
  })

  it('rejects unknown catalog ids and duplicate installs', async () => {
    const backend = createMockBackend()
    await expect(backend.pluginInstallFromCatalog!('does-not-exist')).rejects.toThrow(
      /not found/,
    )

    await backend.pluginInstallFromCatalog!('hello-status')
    await expect(backend.pluginInstallFromCatalog!('hello-status')).rejects.toThrow(
      /already installed/,
    )
  })

  it('persists installed plugins across backend instances via localStorage', async () => {
    const first = createMockBackend()
    await first.pluginInstallFromCatalog!('theme-gruvbox')

    const second = createMockBackend()
    const list = await second.pluginList!()
    expect(list.plugins).toHaveLength(1)
    expect(list.plugins[0].manifest.id).toBe('theme-gruvbox')

    const entry = await second.pluginReadEntry!('theme-gruvbox')
    expect(entry).toContain("id: 'gruvbox-dark'")
  })

  it('ignores corrupted localStorage content instead of throwing', async () => {
    localStorage.setItem(STORE_KEY, '{not json')
    const backend = createMockBackend()
    expect((await backend.pluginList!()).plugins).toEqual([])
  })
})
