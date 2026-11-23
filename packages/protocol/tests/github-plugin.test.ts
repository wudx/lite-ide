import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockBackend } from '../src/mock-backend'
import {
  fetchGithubPlugin,
  parseGithubPluginUrl,
  type GithubPluginSource,
} from '../src/github-plugin'

const STORE_KEY = 'lite-ide.mock-plugins.v1'

afterEach(() => {
  localStorage.removeItem(STORE_KEY)
  vi.unstubAllGlobals()
})

function src(
  owner: string,
  repo: string,
  ref?: string,
  subdir?: string,
): GithubPluginSource {
  return { owner, repo, ref, subdir }
}

describe('parseGithubPluginUrl', () => {
  it('accepts repository urls and shorthands', () => {
    expect(parseGithubPluginUrl('https://github.com/lite-ide/demo')).toEqual(
      src('lite-ide', 'demo'),
    )
    // 简写、http、www、.git 后缀、尾斜杠。
    expect(parseGithubPluginUrl('lite-ide/demo')).toEqual(src('lite-ide', 'demo'))
    expect(parseGithubPluginUrl('http://www.github.com/user/repo.git/')).toEqual(
      src('user', 'repo'),
    )
    // tree + ref + 子目录。
    expect(
      parseGithubPluginUrl('https://github.com/u/r/tree/v1.2/plugins/foo'),
    ).toEqual(src('u', 'r', 'v1.2', 'plugins/foo'))
    // 带百分号编码的分支名解码存储；请求 URL 由 fetch 层重新编码回原形。
    expect(parseGithubPluginUrl('https://github.com/u/r/tree/my%20branch')).toEqual(
      src('u', 'r', 'my branch'),
    )
  })

  it('rejects non repository links and bad segments', () => {
    expect(() => parseGithubPluginUrl('')).toThrow(/empty/)
    expect(() => parseGithubPluginUrl('https://gitlab.com/u/r')).toThrow(/github\.com/)
    expect(() => parseGithubPluginUrl('https://github.com/only-owner')).toThrow(
      /invalid GitHub repo/,
    )
    expect(() =>
      parseGithubPluginUrl('https://github.com/u/r/releases/tag/v1'),
    ).toThrow(/release and archive/)
    expect(() =>
      parseGithubPluginUrl('https://github.com/u/r/archive/refs/heads/main.zip'),
    ).toThrow(/release and archive/)
    expect(() =>
      parseGithubPluginUrl('https://github.com/u/r/blob/main/plugin.json'),
    ).toThrow(/unsupported GitHub URL path/)
    expect(() => parseGithubPluginUrl('https://github.com/../etc')).toThrow(
      /invalid GitHub/,
    )
    expect(() => parseGithubPluginUrl('https://github.com/u/r/tree/../x')).toThrow(
      /branch or tag/,
    )
    expect(() => parseGithubPluginUrl('https://github.com/u/r/tree/main/a b')).toThrow(
      /subdirectory segment/,
    )
    expect(() => parseGithubPluginUrl('https://github.com/u/r/tree/a%zz')).toThrow(
      /branch or tag/,
    )
    expect(() => parseGithubPluginUrl('https://github.com/a b/c')).toThrow(/owner/)
  })
})

/** Minimal fake GitHub transport: routes keyed by URL substring. */
function fakeFetch(routes: Array<{ match: RegExp; status?: number; body: string | object }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = routes.find((r) => r.match.test(url))
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const DEMO_MANIFEST = {
  id: 'github-demo',
  name: 'GitHub Demo',
  version: '1.0.0',
  main: 'main.js',
}
const repoMeta = { default_branch: 'main' }
const tree = {
  tree: [
    { path: 'README.md', type: 'blob', size: 30 },
    { path: 'plugin.json', type: 'blob', size: 80 },
    { path: 'main.js', type: 'blob', size: 100 },
  ],
  truncated: false,
}

describe('fetchGithubPlugin', () => {
  const happyRoutes = [
    { match: /repos\/u\/demo$/, body: repoMeta },
    { match: /git\/trees\/main/, body: tree },
    { match: /plugin\.json$/, body: JSON.stringify(DEMO_MANIFEST) },
    { match: /main\.js$/, body: 'liteide.plugin({ activate() {} })' },
  ]

  it('resolves default branch, locates root manifest and fetches declared files', async () => {
    const fetchImpl = fakeFetch(happyRoutes)
    const payload = await fetchGithubPlugin(src('u', 'demo'), {
      fetchImpl,
      apiBase: 'https://api.github.test',
      rawBase: 'https://raw.github.test',
    })
    expect(payload.manifest.id).toBe('github-demo')
    expect(payload.mainJs).toContain('liteide.plugin')
    expect(payload.assets).toEqual({})
  })

  it('honors explicit ref and subdir prefixes', async () => {
    const subTree = {
      tree: [
        { path: 'docs/x.md', type: 'blob', size: 5 },
        { path: 'plugins/demo/plugin.json', type: 'blob', size: 80 },
        { path: 'plugins/demo/main.js', type: 'blob', size: 100 },
      ],
      truncated: false,
    }
    const fetchImpl = fakeFetch([
      { match: /git\/trees\/v1/, body: subTree },
      { match: /plugin\.json$/, body: JSON.stringify(DEMO_MANIFEST) },
      { match: /main\.js$/, body: 'liteide.plugin({})' },
    ])
    const payload = await fetchGithubPlugin(src('u', 'demo', 'v1', 'plugins/demo'), {
      fetchImpl,
    })
    expect(payload.manifest.id).toBe('github-demo')
  })

  it('re-encodes percent-decoded refs exactly once when building request urls', async () => {
    // 回归：解析层解码 %20 后，请求 URL 必须还原为单个 %20，而非 %2520。
    const requestedUrls: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      requestedUrls.push(url)
      if (url.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'plugin.json', type: 'blob', size: 80 },
              { path: 'main.js', type: 'blob', size: 100 },
            ],
            truncated: false,
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/plugin.json')) {
        return new Response(JSON.stringify(DEMO_MANIFEST), { status: 200 })
      }
      if (url.endsWith('/main.js')) {
        return new Response('liteide.plugin({})', { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    await fetchGithubPlugin(parseGithubPluginUrl('https://github.com/u/r/tree/my%20branch'), {
      fetchImpl,
    })
    const treesUrl = requestedUrls.find((u) => u.includes('/git/trees/'))!
    expect(treesUrl).toContain('git/trees/my%20branch?')
    expect(treesUrl).not.toContain('%2520')
  })

  it('accepts a unique child folder hosting plugin.json', async () => {
    const childTree = {
      tree: [
        { path: 'demo-plugin/plugin.json', type: 'blob', size: 80 },
        { path: 'demo-plugin/main.js', type: 'blob', size: 100 },
      ],
      truncated: false,
    }
    const fetchImpl = fakeFetch([
      { match: /repos\/u\/demo$/, body: repoMeta },
      { match: /git\/trees\/main/, body: childTree },
      { match: /plugin\.json$/, body: JSON.stringify(DEMO_MANIFEST) },
      { match: /main\.js$/, body: 'liteide.plugin({})' },
    ])
    const payload = await fetchGithubPlugin(src('u', 'demo'), { fetchImpl })
    expect(payload.manifest.id).toBe('github-demo')
  })

  it('reports ambiguity, missing manifest, truncation and rate limits', async () => {
    const twoPlugins = {
      tree: [
        { path: 'a/plugin.json', type: 'blob', size: 10 },
        { path: 'b/plugin.json', type: 'blob', size: 10 },
      ],
      truncated: false,
    }
    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees/, body: twoPlugins },
      ]) }),
    ).rejects.toThrow(/multiple plugin folders/)

    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees/, body: { tree: [{ path: 'main.js', type: 'blob', size: 1 }], truncated: false } },
      ]) }),
    ).rejects.toThrow(/no plugin\.json/)

    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees/, body: { tree: [], truncated: true } },
      ]) }),
    ).rejects.toThrow(/too large/)

    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, status: 403, body: {} },
      ]) }),
    ).rejects.toThrow(/rate limit/)

    await expect(
      fetchGithubPlugin(src('u', 'demo', 'nope'), { fetchImpl: fakeFetch([
        { match: /git\/trees\/nope/, status: 404, body: {} },
      ]) }),
    ).rejects.toThrow(/not found/)
  })

  it('validates manifest fields and rejects missing entry files', async () => {
    const badIdTree = {
      tree: [
        { path: 'plugin.json', type: 'blob', size: 80 },
        { path: 'main.js', type: 'blob', size: 100 },
      ],
      truncated: false,
    }
    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees/, body: badIdTree },
        { match: /plugin\.json$/, body: JSON.stringify({ ...DEMO_MANIFEST, id: 'a b' }) },
      ]) }),
    ).rejects.toThrow(/invalid plugin id/)

    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees/, body: badIdTree },
        { match: /plugin\.json$/, body: JSON.stringify({ ...DEMO_MANIFEST, main: 'src/main.js' }) },
      ]) }),
    ).rejects.toThrow(/invalid plugin entry file/)

    await expect(
      fetchGithubPlugin(src('u', 'demo'), { fetchImpl: fakeFetch([
        { match: /repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees/, body: badIdTree },
        { match: /plugin\.json$/, body: JSON.stringify(DEMO_MANIFEST) },
        { match: /main\.js$/, status: 404, body: {} },
      ]) }),
    ).rejects.toThrow(/not found/)
  })
})

describe('mock backend pluginInstallFromGithub', () => {
  function stubGlobalGithub() {
    vi.stubGlobal(
      'fetch',
      fakeFetch([
        { match: /api\.github\.com\/repos\/u\/demo$/, body: repoMeta },
        { match: /git\/trees\/main/, body: tree },
        { match: /plugin\.json$/, body: JSON.stringify(DEMO_MANIFEST) },
        { match: /main\.js$/, body: 'liteide.plugin({ activate() {} })' },
      ]),
    )
  }

  it('installs a github plugin into the persisted store', async () => {
    stubGlobalGithub()
    const backend = createMockBackend()
    const installed = await backend.pluginInstallFromGithub!(
      'https://github.com/u/demo',
    )
    expect(installed.manifest.id).toBe('github-demo')
    expect(installed.error).toBeNull()

    const list = await backend.pluginList!()
    expect(list.plugins).toHaveLength(1)
    expect(await backend.pluginReadEntry!('github-demo')).toContain('liteide.plugin')

    await backend.pluginUninstall!('github-demo')
    expect((await backend.pluginList!()).plugins).toEqual([])
  })

  it('rejects duplicate installs and bad urls', async () => {
    stubGlobalGithub()
    const backend = createMockBackend()
    await backend.pluginInstallFromGithub!('u/demo')

    // 插件 id 在下载 manifest 后才可知，重复安装于落盘前被拒（与 Rust 端一致）。
    await expect(backend.pluginInstallFromGithub!('u/demo')).rejects.toThrow(
      /already installed/,
    )
    // 非法 URL 在任何网络请求前被解析层拒绝。
    await expect(backend.pluginInstallFromGithub!('https://gitlab.com/x/y')).rejects.toThrow(
      /github\.com/,
    )
  })
})
