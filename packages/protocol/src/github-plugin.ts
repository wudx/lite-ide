import type { PluginManifest } from './types'

/**
 * GitHub 插件安装的前端实现（浏览器演示后端使用；桌面端由 Rust 侧
 * `plugins_github.rs` 承担同一条链路，两端的解析规则保持一致）。
 *
 * 流程：解析仓库 URL → 无 ref 时查仓库默认分支 → git trees API 列文件 →
 * 定位 plugin.json（仓库根 / 指定子目录 / 唯一子目录）→ 仅下载 manifest
 * 声明的文本文件（入口 / css / chunks）。
 */

/** Cap per downloaded file (aligned with the backend asset limits). */
const MAX_FILE_BYTES = 6 * 1024 * 1024

/** A validated GitHub repository reference for plugin installation. */
export interface GithubPluginSource {
  owner: string
  repo: string
  /** Branch, tag or commit sha; undefined = repository default branch. */
  ref?: string
  /** Repository-relative folder that hosts the plugin; undefined = root. */
  subdir?: string
}

const SEGMENT_ALLOWED = /^[A-Za-z0-9\-_.~+@(),$!*'%;:]+$/

/** Windows 保留设备名（与 Rust is_windows_reserved_stem 对齐）。 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

function isWindowsReservedStem(name: string): boolean {
  return WINDOWS_RESERVED.has(name.split('.')[0].toLowerCase())
}

/** 解码 %XX 转义（坏转义原样保留）；与 Rust percent_decode 行为对齐。 */
function percentDecode(segment: string): string {
  const bytes: number[] = []
  for (let i = 0; i < segment.length; i++) {
    if (
      segment[i] === '%' &&
      /^[0-9A-Fa-f]{2}$/.test(segment.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(segment.charCodeAt(i))
    }
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes))
}

function isValidUrlSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 200 &&
    segment !== '.' &&
    segment !== '..' &&
    SEGMENT_ALLOWED.test(segment) &&
    // 百分号转义必须形如 %XX，拒绝 a%zz 这类坏转义。
    segment
      .split('%')
      .slice(1)
      .every((tail) => /^[0-9A-Fa-f]{2}/.test(tail))
  )
}

function validateRepoName(kind: 'owner' | 'repo', value: string): void {
  if (!isValidUrlSegment(value) || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`invalid GitHub ${kind}: ${value}`)
  }
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/**
 * Parses user input into a repository reference. Accepted shapes:
 * `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo[.git][/`,
 * and `…/tree/<ref>[/<subdir…>]`. Release/archive/blob links are rejected
 * with a hint. Branch names containing `/` cannot be told apart from
 * subdirectories in the URL and are not supported by the browser backend.
 */
export function parseGithubPluginUrl(input: string): GithubPluginSource {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new Error('GitHub repository URL is empty')
  }

  let rest = trimmed
  for (const scheme of ['https://', 'http://']) {
    if (rest.toLowerCase().startsWith(scheme)) {
      rest = rest.slice(scheme.length)
      break
    }
  }

  const segments = rest.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new Error(`GitHub URL is missing owner/repository: ${input}`)
  }
  // 首段为 github.com（或 www.）主机名则丢弃；其余含点号的首段视为
  // 不支持的主机名报错，无点号即 owner/repo 简写。
  const first = segments[0].toLowerCase()
  let start = 0
  if (first === 'github.com' || first === 'www.github.com') {
    start = 1
  } else if (first.includes('.')) {
    throw new Error(
      `only github.com repository URLs are supported, got host "${segments[0]}"`,
    )
  }
  const pathSegments = segments.slice(start)
  if (pathSegments.length === 0) {
    throw new Error(`GitHub URL is missing owner/repository: ${input}`)
  }

  const owner = pathSegments[0].replace(/\.+$/, '')
  const repo = (pathSegments[1] ?? '').replace(/\.git$/i, '')
  validateRepoName('owner', owner)
  validateRepoName('repo', repo)

  const source: GithubPluginSource = { owner, repo }
  const remaining = pathSegments.slice(2)
  if (remaining.length === 0) return source

  if (remaining[0] === 'tree') {
    const parts = remaining.slice(1)
    if (parts.length === 0) {
      throw new Error('GitHub tree URL is missing the branch or tag')
    }
    if (!isValidUrlSegment(parts[0])) {
      throw new Error(`invalid GitHub branch or tag: ${parts[0]}`)
    }
    // 校验编码形式、存储解码形式：请求 URL 由 encodeURIComponent 重新编码，
    // 与 trees API 返回的解码路径直接可比。
    source.ref = percentDecode(parts[0])
    if (parts.length > 1) {
      for (const segment of parts.slice(1)) {
        if (!isValidUrlSegment(segment)) {
          throw new Error(`invalid subdirectory segment: ${segment}`)
        }
      }
      source.subdir = parts.slice(1).map(percentDecode).join('/')
    }
    return source
  }
  if (remaining[0] === 'releases' || remaining[0] === 'archive') {
    throw new Error(
      'release and archive links are not supported; paste the repository URL (optionally /tree/<ref>/<subdir>)',
    )
  }
  throw new Error(
    `unsupported GitHub URL path segment "${remaining[0]}"; paste the repository URL (optionally /tree/<ref>/<subdir>)`,
  )
}

/** Result payload shaped like the mock backend's stored plugin. */
export interface GithubPluginPayload {
  manifest: PluginManifest
  mainJs: string
  /** Bare filename → text, covering manifest css/chunks entries. */
  assets: Record<string, string>
}

interface GithubTreeEntry {
  path: string
  type: string
  size?: number
}

/** Injectable transport so tests can stub the GitHub endpoints. */
export interface GithubFetchDeps {
  fetchImpl?: typeof fetch
  apiBase?: string
  rawBase?: string
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  maxSize: number,
  notFoundHint: string,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(url)
  } catch (err) {
    throw new Error(
      `cannot reach github.com (network or CORS): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (response.status === 404) {
    throw new Error(notFoundHint)
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      'GitHub API rate limit exceeded (60 requests/hour without authentication); retry later',
    )
  }
  if (!response.ok) {
    throw new Error(`request failed: HTTP ${response.status} for ${url}`)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxSize) {
    throw new Error(
      `file exceeds the ${Math.round(maxSize / (1024 * 1024))} MB limit: ${url}`,
    )
  }
  return new TextDecoder('utf-8').decode(buffer)
}

function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  notFoundHint: string,
): Promise<T> {
  return fetchText(fetchImpl, url, MAX_FILE_BYTES, notFoundHint).then(
    (text) => JSON.parse(text) as T,
  )
}

/**
 * Light manifest validation mirroring the backend `parse_manifest` rules;
 * plugin-host activation re-validates contribution-level details later.
 */
function validateManifest(raw: unknown, sourceLabel: string): PluginManifest {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`invalid plugin.json in ${sourceLabel}`)
  }
  const manifest = raw as Record<string, unknown>
  const { id, name, version } = manifest
  if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`plugin.json requires string id/name/version in ${sourceLabel}`)
  }
  if (
    id.length === 0 ||
    id.length > 64 ||
    !/^[A-Za-z0-9._-]+$/.test(id) ||
    id.startsWith('.') ||
    id.endsWith('.') ||
    WINDOWS_RESERVED.has(id.toLowerCase())
  ) {
    throw new Error(`invalid plugin id: ${id}`)
  }
  if (name.trim().length === 0 || version.trim().length === 0) {
    throw new Error('plugin name and version must not be empty')
  }
  const isBareFileName = (value: unknown, exts: string[]) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[/\\:]/.test(value) &&
    !isWindowsReservedStem(value) &&
    exts.some((ext) => value.toLowerCase().endsWith(`.${ext}`))
  if (manifest.main !== undefined && !isBareFileName(manifest.main, ['js'])) {
    throw new Error(`invalid plugin entry file: ${String(manifest.main)}`)
  }
  if (
    manifest.format !== undefined &&
    manifest.format !== 'classic' &&
    manifest.format !== 'bundle'
  ) {
    throw new Error(`invalid plugin format: ${String(manifest.format)}`)
  }
  if (manifest.css !== undefined && !isBareFileName(manifest.css, ['css'])) {
    throw new Error(`invalid plugin css asset file: ${String(manifest.css)}`)
  }
  if (manifest.chunks !== undefined) {
    if (manifest.chunks === null || typeof manifest.chunks !== 'object') {
      throw new Error('plugin chunks must be an object')
    }
    for (const [chunkName, file] of Object.entries(manifest.chunks)) {
      if (chunkName.length === 0 || chunkName.length > 64 || !isBareFileName(file, ['js', 'css'])) {
        throw new Error(`invalid plugin chunk for "${chunkName}": ${String(file)}`)
      }
    }
  }
  return manifest as unknown as PluginManifest
}

/**
 * Downloads a GitHub-hosted plugin: resolves the ref, lists the repository
 * tree, locates plugin.json and fetches only the manifest-declared files.
 */
export async function fetchGithubPlugin(
  source: GithubPluginSource,
  deps: GithubFetchDeps = {},
): Promise<GithubPluginPayload> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const apiBase = deps.apiBase ?? 'https://api.github.com'
  const rawBase = deps.rawBase ?? 'https://raw.githubusercontent.com'
  const repoPath = `${source.owner}/${source.repo}`
  const encode = (value: string) => encodeURIComponent(value)

  let ref = source.ref
  if (ref === undefined) {
    const meta = await fetchJson<{ default_branch?: string }>(
      fetchImpl,
      `${apiBase}/repos/${encode(source.owner)}/${encode(source.repo)}`,
      `repository ${repoPath} not found (check owner/repo)`,
    )
    if (typeof meta.default_branch !== 'string' || meta.default_branch.length === 0) {
      throw new Error(`repository ${repoPath} has no default branch`)
    }
    ref = meta.default_branch
  }
  const encodedRef = encode(ref)

  const tree = await fetchJson<{ tree?: GithubTreeEntry[]; truncated?: boolean }>(
    fetchImpl,
    `${apiBase}/repos/${encode(source.owner)}/${encode(source.repo)}/git/trees/${encodedRef}?recursive=1`,
    `repository tree not found for ${repoPath} ref "${ref}" (check the branch or tag; branch names containing "/" need the desktop backend)`,
  )
  if (tree.truncated === true) {
    throw new Error(`repository ${repoPath} tree is too large to enumerate`)
  }
  const entries = Array.isArray(tree.tree) ? tree.tree : []

  const blobAt = (path: string): GithubTreeEntry | undefined =>
    entries.find((e) => e.path === path && e.type === 'blob')
  const rawUrl = (path: string) =>
    `${rawBase}/${encode(source.owner)}/${encode(source.repo)}/${encodedRef}/${encodePathSegments(path)}`

  // 定位插件根：显式子目录 → 仓库根 → 唯一含 plugin.json 的子目录。
  let prefix = ''
  if (source.subdir !== undefined) {
    prefix = `${source.subdir}/`
    if (!blobAt(`${prefix}plugin.json`)) {
      throw new Error(`plugin.json not found under "${source.subdir}" in ${repoPath}`)
    }
  } else if (!blobAt('plugin.json')) {
    const topLevelDirs = new Set(
      entries
        .filter((e) => e.type === 'blob' && e.path.includes('/'))
        .map((e) => e.path.slice(0, e.path.indexOf('/'))),
    )
    const candidates = [...topLevelDirs].filter((dir) => blobAt(`${dir}/plugin.json`))
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? `no plugin.json found in the repository root of ${repoPath}`
          : `multiple plugin folders found (${candidates.length}) in ${repoPath}; install one via /tree/<ref>/<subdirectory>: ${candidates.join(', ')}`,
      )
    }
    prefix = `${candidates[0]}/`
  }

  const manifestRaw = await fetchText(
    fetchImpl,
    rawUrl(`${prefix}plugin.json`),
    MAX_FILE_BYTES,
    `plugin.json not found in ${repoPath}`,
  )
  const manifest = validateManifest(
    JSON.parse(manifestRaw),
    `${repoPath}${prefix ? `/${prefix}` : ''}`,
  )

  const files = [manifest.main ?? 'main.js']
  if (manifest.css) files.push(manifest.css)
  if (manifest.chunks) files.push(...Object.values(manifest.chunks))

  const contents = new Map<string, string>()
  for (const file of files) {
    const path = `${prefix}${file}`
    const entry = blobAt(path)
    if (!entry) {
      throw new Error(`plugin file "${file}" not found in ${repoPath}`)
    }
    if (typeof entry.size === 'number' && entry.size > MAX_FILE_BYTES) {
      throw new Error(
        `plugin file "${file}" exceeds the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB limit`,
      )
    }
    contents.set(file, await fetchText(fetchImpl, rawUrl(path), MAX_FILE_BYTES, `plugin file "${file}" not found in ${repoPath}`))
  }

  const assets: Record<string, string> = {}
  for (const file of files.slice(1)) {
    assets[file] = contents.get(file)!
  }
  return { manifest, mainJs: contents.get(manifest.main ?? 'main.js')!, assets }
}
