import type {
  DirEntry,
  FileMeta,
  FsDelta,
  ProjectInfo,
  TextPayload,
  WorkspaceBackend,
  WriteTextResult,
} from './types'

interface MockFile {
  content: string
  modifiedMs: number
  isBinary?: boolean
  mime?: string
  ignored?: boolean
  dataUrl?: string
}

interface MockRepoTemplate {
  id: string
  name: string
  rootPath: string
  files: Record<string, Omit<MockFile, 'modifiedMs'>>
}

interface MockRepo {
  id: string
  name: string
  rootPath: string
  files: Record<string, MockFile>
  dirs: Set<string>
}

const BASE_TIMESTAMP = 1700000000000
const SUPPORTED_ENCODINGS = new Set(['', 'utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'])

const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect width="360" height="220" rx="18" fill="url(#bg)"/>
  <rect x="24" y="24" width="312" height="26" rx="8" fill="#1e293b" stroke="#334155"/>
  <rect x="32" y="30" width="96" height="14" rx="5" fill="url(#accent)"/>
  <rect x="136" y="30" width="84" height="14" rx="5" fill="#334155"/>
  <rect x="24" y="62" width="94" height="134" rx="10" fill="#172033" stroke="#334155"/>
  <rect x="128" y="62" width="208" height="134" rx="10" fill="#111827" stroke="#334155"/>
  <text x="148" y="102" fill="#e2e8f0" font-family="monospace" font-size="15" font-weight="bold">LiteIDE Kernel</text>
  <text x="148" y="128" fill="#38bdf8" font-family="monospace" font-size="12">Tauri v2 + SolidJS</text>
  <text x="148" y="150" fill="#94a3b8" font-family="monospace" font-size="12">Scope / Service / Slot</text>
</svg>`

const MOCK_REPO_TEMPLATES: MockRepoTemplate[] = [
  {
    id: 'mock-lite-ide',
    name: 'lite-ide-demo',
    rootPath: '/workspace/lite-ide-demo',
    files: {
      'README.md': {
        mime: 'text/markdown',
        content: `# LiteIDE Micro-Kernel Preview

Welcome to **LiteIDE** — a lightweight, high-performance IDE powered by **Rust (Tauri v2)**, **SolidJS**, and a minimal **Micro-Kernel** plugin architecture.

## Architecture Highlights

- **Top Project Tabs**: One tab per project with isolated \`ProjectScope\` and LRU DOM keep-alive.
- **Virtual File Tree**: Lazy directory loading + \`@tanstack/solid-virtual\`.
- **Lazy Previewers**: CodeMirror 6, Markdown, Image/SVG, and Binary fallback loaded on demand.

![Architecture Diagram](assets/architecture.svg)

Check out [src/kernel.ts](src/kernel.ts) to explore how plugins attach to the kernel.
`,
      },
      'package.json': {
        mime: 'application/json',
        content: JSON.stringify(
          {
            name: 'lite-ide-demo',
            version: '0.1.0',
            type: 'module',
            dependencies: {
              'solid-js': '^1.9.19',
            },
          },
          null,
          2,
        ),
      },
      '.gitignore': {
        mime: 'text/plain',
        content: 'node_modules/\ndist/\n*.log\n',
      },
      // 引擎资产元数据（如 Cocos Creator *.meta），供文件树排除规则演示/验收。
      'scene.meta': {
        mime: 'application/json',
        content: JSON.stringify(
          {
            ver: '1.1.6',
            importer: 'scene',
            uuid: 'b7e2c4a8-9d01-4f3a-a6c5-8e9012f4d3b7',
          },
          null,
          2,
        ),
      },
      'assets/logo.psd.meta': {
        mime: 'application/json',
        content: JSON.stringify(
          {
            ver: '1.0.6',
            importer: 'image',
            uuid: 'c8f3d5b9-0e12-4a4b-b7d6-9f0123a5e4c8',
          },
          null,
          2,
        ),
      },
      'src/kernel.ts': {
        mime: 'text/typescript',
        content: `export interface Disposable {
  dispose(): void
}

export function createServiceKey<T>(name: string) {
  return { id: Symbol(name), name }
}

// Each top project tab owns an isolated ProjectScope backed by SolidJS createRoot.
export function activateDemo() {
  console.log('LiteIDE micro-kernel activated')
}
`,
      },
      'src/App.tsx': {
        mime: 'text/typescript',
        content: `import { createSignal } from 'solid-js'

export function Counter() {
  const [count, setCount] = createSignal(0)
  return (
    <button onClick={() => setCount((c) => c + 1)}>
      Active Count: {count()}
    </button>
  )
}
`,
      },
      'assets/architecture.svg': {
        mime: 'image/svg+xml',
        content: DEMO_SVG,
        dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(DEMO_SVG)}`,
      },
      'assets/runtime.wasm': {
        mime: 'application/wasm',
        isBinary: true,
        content: '\0asm\x01\x00\x00\x00',
      },
      'dist/bundle.log': {
        mime: 'text/plain',
        ignored: true,
        content: '[build] bundle generated in 42ms\n',
      },
    },
  },
  {
    id: 'mock-rust-core',
    name: 'rust-core-sample',
    rootPath: '/workspace/rust-core-sample',
    files: {
      'Cargo.toml': {
        mime: 'application/toml',
        content: `[package]
name = "rust-core-sample"
version = "0.1.0"
edition = "2021"

[dependencies]
ignore = "0.4"
notify = "8"
`,
      },
      'src/main.rs': {
        mime: 'text/x-rust',
        content: `use std::path::Path;

fn main() {
    let root = Path::new(".");
    println!("Scanning workspace at {}", root.display());
}
`,
      },
      'NOTES.md': {
        mime: 'text/markdown',
        content: `# Rust Core Sample

Switch between top project tabs to verify **instant 0ms switching** and preserved file tree expansion state!
`,
      },
    },
  },
]

export const MOCK_DEMO_PATHS = MOCK_REPO_TEMPLATES.map((r) => r.rootPath)

function cloneRepoFromTemplate(tpl: MockRepoTemplate): MockRepo {
  const files: Record<string, MockFile> = {}
  const dirs = new Set<string>()
  let offset = 1

  for (const [relPath, file] of Object.entries(tpl.files)) {
    files[relPath] = {
      ...file,
      modifiedMs: BASE_TIMESTAMP + offset++,
    }
    const parts = relPath.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }

  return {
    id: tpl.id,
    name: tpl.name,
    rootPath: tpl.rootPath,
    files,
    dirs,
  }
}

function nextTimestamp(prev = 0): number {
  return Math.max(Date.now(), prev + 1)
}

function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

function baseNameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? relPath : relPath.slice(idx + 1)
}

function normalizeRelPath(raw: string, allowEmpty = false): string {
  if (raw.includes('\0')) {
    throw new Error(`Invalid path: ${raw}`)
  }
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized.replace(/^\/+/, ''))) {
    throw new Error(`Path traversal rejected: ${raw}`)
  }
  const trimmed = normalized.replace(/^\/+|\/+$/g, '')
  if (!trimmed) {
    if (allowEmpty) return ''
    throw new Error('Target path cannot be empty')
  }
  const parts = trimmed.split('/')
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Path traversal rejected: ${raw}`)
    }
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      throw new Error(`Invalid file or folder name: ${seg}`)
    }
  }
  return parts.join('/')
}

function inferMime(relPath: string): string {
  const name = baseNameOf(relPath)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'text/typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'text/javascript'
    case 'rs':
      return 'text/x-rust'
    case 'go':
      return 'text/x-go'
    case 'py':
    case 'pyw':
    case 'pyi':
      return 'text/x-python'
    case 'toml':
      return 'application/toml'
    case 'yaml':
    case 'yml':
      return 'text/yaml'
    case 'json':
    case 'jsonc':
    case 'json5':
      return 'application/json'
    case 'md':
    case 'markdown':
    case 'mdx':
      return 'text/markdown'
    case 'svg':
      return 'image/svg+xml'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'css':
    case 'scss':
      return 'text/css'
    default:
      return 'text/plain'
  }
}

export function createMockBackend(): WorkspaceBackend {
  const repoPool = new Map<string, MockRepo>()
  const openSessions = new Map<string, MockRepo>()
  const fsListeners = new Map<string, (delta: FsDelta) => void>()
  let pickCursor = 0

  for (const tpl of MOCK_REPO_TEMPLATES) {
    repoPool.set(tpl.rootPath, cloneRepoFromTemplate(tpl))
  }

  function findRepoByPath(path: string): MockRepo {
    const existing = repoPool.get(path)
    if (existing) return existing
    const name = path.split(/[/\\]/).filter(Boolean).pop() || 'project'
    const created: MockRepo = {
      id: `mock-${name}`,
      name,
      rootPath: path,
      files: {
        'README.md': {
          mime: 'text/markdown',
          modifiedMs: nextTimestamp(),
          content: `# ${name}\n\nOpened in browser preview mode.\n`,
        },
      },
      dirs: new Set<string>(),
    }
    repoPool.set(path, created)
    return created
  }

  function getRepo(projectId: string): MockRepo {
    const repo = openSessions.get(projectId)
    if (!repo) throw new Error(`Project not found: ${projectId}`)
    return repo
  }

  function dirExists(repo: MockRepo, dirPath: string): boolean {
    if (dirPath === '') return true
    if (repo.dirs.has(dirPath)) return true
    const prefix = `${dirPath}/`
    return Object.keys(repo.files).some((filePath) => filePath.startsWith(prefix))
  }

  function entryExists(repo: MockRepo, relPath: string): boolean {
    return relPath in repo.files || dirExists(repo, relPath)
  }

  function buildFileMeta(projectId: string, relPath: string, file: MockFile): FileMeta {
    const name = baseNameOf(relPath)
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

    return {
      projectId,
      relPath,
      name,
      ext,
      size: new TextEncoder().encode(file.content).length,
      modifiedMs: file.modifiedMs,
      mime: file.mime || inferMime(relPath),
      isBinary: Boolean(file.isBinary),
      encoding: file.isBinary ? 'binary' : 'utf-8',
    }
  }

  function buildDirEntry(repo: MockRepo, relPath: string, isDir: boolean): DirEntry {
    const name = baseNameOf(relPath)
    if (isDir) {
      return {
        name,
        relPath,
        isDir: true,
        size: 0,
        modifiedMs: BASE_TIMESTAMP,
        ignored: name === 'dist' || name === 'node_modules' || name === '.git',
        hidden: name.startsWith('.'),
      }
    }
    const file = repo.files[relPath]
    return {
      name,
      relPath,
      isDir: false,
      size: new TextEncoder().encode(file?.content ?? '').length,
      modifiedMs: file?.modifiedMs ?? BASE_TIMESTAMP,
      ignored: Boolean(file?.ignored),
      hidden: name.startsWith('.'),
    }
  }

  function emitDelta(projectId: string, affectedDirs: string[], affectedPaths: string[]) {
    const listener = fsListeners.get(projectId)
    if (!listener) return
    const delta: FsDelta = {
      projectId,
      affectedDirs: [...new Set(affectedDirs)],
      affectedPaths: [...new Set(affectedPaths)],
      overflow: false,
    }
    queueMicrotask(() => {
      fsListeners.get(projectId)?.(delta)
    })
  }

  return {
    kind: 'mock',

    async openProject(path: string, onFsEvent: (delta: FsDelta) => void): Promise<ProjectInfo> {
      const repo = findRepoByPath(path)
      openSessions.set(repo.id, repo)
      fsListeners.set(repo.id, onFsEvent)
      return {
        id: repo.id,
        name: repo.name,
        rootPath: repo.rootPath,
      }
    },

    async closeProject(projectId: string): Promise<void> {
      openSessions.delete(projectId)
      fsListeners.delete(projectId)
    },

    async listDir(projectId: string, relPath: string): Promise<DirEntry[]> {
      const repo = getRepo(projectId)
      const prefix = normalizeRelPath(relPath, true)
      if (prefix && !dirExists(repo, prefix)) {
        throw new Error(`Not a directory: ${relPath}`)
      }

      const seenDirs = new Set<string>()
      const dirs: DirEntry[] = []
      const files: DirEntry[] = []

      for (const dir of repo.dirs) {
        if (prefix && !dir.startsWith(`${prefix}/`)) continue
        const remainder = prefix ? dir.slice(prefix.length + 1) : dir
        if (!remainder) continue
        const firstSeg = remainder.split('/')[0]
        const dirRel = prefix ? `${prefix}/${firstSeg}` : firstSeg
        if (!seenDirs.has(dirRel)) {
          seenDirs.add(dirRel)
          dirs.push(buildDirEntry(repo, dirRel, true))
        }
      }

      for (const [filePath] of Object.entries(repo.files)) {
        if (prefix && !filePath.startsWith(`${prefix}/`)) continue
        const remainder = prefix ? filePath.slice(prefix.length + 1) : filePath
        const parts = remainder.split('/')

        if (parts.length > 1) {
          const dirName = parts[0]
          const dirRel = prefix ? `${prefix}/${dirName}` : dirName
          if (!seenDirs.has(dirRel)) {
            seenDirs.add(dirRel)
            dirs.push(buildDirEntry(repo, dirRel, true))
          }
        } else if (parts[0]) {
          files.push(buildDirEntry(repo, filePath, false))
        }
      }

      dirs.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
      files.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
      return [...dirs, ...files]
    },

    async statPreview(projectId: string, relPath: string): Promise<FileMeta> {
      const repo = getRepo(projectId)
      const normalized = normalizeRelPath(relPath)
      const file = repo.files[normalized]
      if (!file) throw new Error(`File not found: ${relPath}`)
      return buildFileMeta(projectId, normalized, file)
    },

    async readText(
      projectId: string,
      relPath: string,
      maxBytes = 2 * 1024 * 1024,
    ): Promise<TextPayload> {
      const repo = getRepo(projectId)
      const normalized = normalizeRelPath(relPath)
      const file = repo.files[normalized]
      if (!file) throw new Error(`File not found: ${relPath}`)

      const fullBytes = new TextEncoder().encode(file.content)
      const truncated = fullBytes.length > maxBytes
      const content = truncated
        ? new TextDecoder().decode(fullBytes.slice(0, maxBytes))
        : file.content

      return {
        content,
        totalBytes: fullBytes.length,
        loadedBytes: Math.min(fullBytes.length, maxBytes),
        truncated,
        lineCount: content ? content.split('\n').length : 0,
        encoding: 'utf-8',
      }
    },

    async writeText(
      projectId: string,
      relPath: string,
      content: string,
      encoding = 'utf-8',
    ): Promise<WriteTextResult> {
      const repo = getRepo(projectId)
      const normalized = normalizeRelPath(relPath)
      const file = repo.files[normalized]
      if (!file) throw new Error(`File not found: ${relPath}`)
      if (file.isBinary) throw new Error(`Cannot write binary file: ${relPath}`)

      const enc = encoding.trim().toLowerCase()
      if (!SUPPORTED_ENCODINGS.has(enc)) {
        throw new Error(`Unsupported text encoding for writing: ${encoding}`)
      }

      file.content = content
      file.modifiedMs = nextTimestamp(file.modifiedMs)
      if ((file.mime || inferMime(normalized)) === 'image/svg+xml') {
        file.dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(content)}`
      }

      const writtenBytes = new TextEncoder().encode(content).length
      const lineCount = content ? content.split('\n').length : 0
      emitDelta(projectId, [parentDirOf(normalized)], [normalized])

      return {
        meta: buildFileMeta(projectId, normalized, file),
        lineCount,
        writtenBytes,
      }
    },

    async createFile(projectId: string, relPath: string): Promise<FileMeta> {
      const repo = getRepo(projectId)
      const normalized = normalizeRelPath(relPath)
      const parent = parentDirOf(normalized)
      if (!dirExists(repo, parent)) {
        throw new Error(`Parent directory does not exist: ${parent}`)
      }
      if (entryExists(repo, normalized)) {
        throw new Error(`Path already exists: ${normalized}`)
      }

      const file: MockFile = {
        content: '',
        modifiedMs: nextTimestamp(),
        mime: inferMime(normalized),
      }
      repo.files[normalized] = file
      emitDelta(projectId, [parent], [normalized])
      return buildFileMeta(projectId, normalized, file)
    },

    async createDir(projectId: string, relPath: string): Promise<DirEntry> {
      const repo = getRepo(projectId)
      const normalized = normalizeRelPath(relPath)
      const parent = parentDirOf(normalized)
      if (!dirExists(repo, parent)) {
        throw new Error(`Parent directory does not exist: ${parent}`)
      }
      if (entryExists(repo, normalized)) {
        throw new Error(`Path already exists: ${normalized}`)
      }

      repo.dirs.add(normalized)
      emitDelta(projectId, [parent], [normalized])
      return buildDirEntry(repo, normalized, true)
    },

    async renamePath(
      projectId: string,
      oldRelPath: string,
      newRelPath: string,
    ): Promise<DirEntry> {
      const repo = getRepo(projectId)
      const src = normalizeRelPath(oldRelPath)
      const dst = normalizeRelPath(newRelPath)

      const srcIsFile = src in repo.files
      const srcIsDir = !srcIsFile && dirExists(repo, src)
      if (!srcIsFile && !srcIsDir) {
        throw new Error(`Path not found: ${src}`)
      }

      const dstParent = parentDirOf(dst)
      if (!dirExists(repo, dstParent)) {
        throw new Error(`Parent directory does not exist: ${dstParent}`)
      }

      if (src === dst) {
        return buildDirEntry(repo, dst, srcIsDir)
      }

      const isCaseOnlyRename =
        parentDirOf(src) === dstParent &&
        baseNameOf(src).toLowerCase() === baseNameOf(dst).toLowerCase()

      if (entryExists(repo, dst) && !isCaseOnlyRename) {
        throw new Error(`Path already exists: ${dst}`)
      }

      const affectedPaths = [src, dst]
      if (srcIsFile) {
        const file = repo.files[src]
        delete repo.files[src]
        file.mime = inferMime(dst)
        file.modifiedMs = nextTimestamp(file.modifiedMs)
        repo.files[dst] = file
      } else {
        const prefix = `${src}/`
        const updatedDirs = new Set<string>()
        for (const dir of repo.dirs) {
          if (dir === src) {
            updatedDirs.add(dst)
          } else if (dir.startsWith(prefix)) {
            updatedDirs.add(`${dst}/${dir.slice(prefix.length)}`)
          } else {
            updatedDirs.add(dir)
          }
        }
        updatedDirs.add(dst)
        repo.dirs = updatedDirs

        for (const [filePath, file] of Object.entries(repo.files)) {
          if (filePath.startsWith(prefix)) {
            const nextFilePath = `${dst}/${filePath.slice(prefix.length)}`
            delete repo.files[filePath]
            repo.files[nextFilePath] = file
            affectedPaths.push(filePath, nextFilePath)
          }
        }
      }

      emitDelta(projectId, [parentDirOf(src), dstParent], affectedPaths)
      return buildDirEntry(repo, dst, srcIsDir)
    },

    async deletePath(projectId: string, relPath: string): Promise<void> {
      const repo = getRepo(projectId)
      const target = normalizeRelPath(relPath)

      const isFile = target in repo.files
      const isDir = !isFile && dirExists(repo, target)
      if (!isFile && !isDir) {
        throw new Error(`Path not found: ${target}`)
      }

      const affectedPaths = [target]
      if (isFile) {
        delete repo.files[target]
      } else {
        const prefix = `${target}/`
        for (const dir of [...repo.dirs]) {
          if (dir === target || dir.startsWith(prefix)) {
            repo.dirs.delete(dir)
          }
        }
        for (const filePath of Object.keys(repo.files)) {
          if (filePath.startsWith(prefix)) {
            delete repo.files[filePath]
            affectedPaths.push(filePath)
          }
        }
      }

      emitDelta(projectId, [parentDirOf(target)], affectedPaths)
    },

    async pickFolder(): Promise<string | null> {
      const candidate = MOCK_REPO_TEMPLATES[pickCursor % MOCK_REPO_TEMPLATES.length]
      pickCursor++
      return candidate.rootPath
    },

    resolveFileUrl(projectId: string, relPath: string): string {
      const repo = openSessions.get(projectId)
      const file = repo?.files[relPath]
      if (file?.dataUrl) return file.dataUrl
      if (file?.mime === 'image/svg+xml') {
        return `data:image/svg+xml;utf8,${encodeURIComponent(file.content)}`
      }
      return `data:text/plain;utf8,${encodeURIComponent(file?.content ?? '')}`
    },
  }
}
