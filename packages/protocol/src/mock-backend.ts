import type { DirEntry, FileMeta, FsDelta, ProjectInfo, TextPayload, WorkspaceBackend } from './types'

interface MockFile {
  content: string
  isBinary?: boolean
  mime?: string
  ignored?: boolean
  dataUrl?: string
}

interface MockRepo {
  id: string
  name: string
  rootPath: string
  files: Record<string, MockFile>
}

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

const MOCK_REPOS: MockRepo[] = [
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

export const MOCK_DEMO_PATHS = MOCK_REPOS.map((r) => r.rootPath)

export function createMockBackend(): WorkspaceBackend {
  const openSessions = new Map<string, MockRepo>()
  let pickCursor = 0

  function findRepoByPath(path: string): MockRepo {
    const found = MOCK_REPOS.find((r) => r.rootPath === path)
    if (found) return found
    const name = path.split(/[/\\]/).filter(Boolean).pop() || 'project'
    return {
      id: `mock-${name}`,
      name,
      rootPath: path,
      files: {
        'README.md': {
          mime: 'text/markdown',
          content: `# ${name}\n\nOpened in browser preview mode.\n`,
        },
      },
    }
  }

  return {
    kind: 'mock',

    async openProject(path: string, _onFsEvent: (delta: FsDelta) => void): Promise<ProjectInfo> {
      const repo = findRepoByPath(path)
      openSessions.set(repo.id, repo)
      return {
        id: repo.id,
        name: repo.name,
        rootPath: repo.rootPath,
      }
    },

    async closeProject(projectId: string): Promise<void> {
      openSessions.delete(projectId)
    },

    async listDir(projectId: string, relPath: string): Promise<DirEntry[]> {
      const repo = openSessions.get(projectId)
      if (!repo) throw new Error(`Project not found: ${projectId}`)

      const prefix = relPath.replace(/^\/+|\/+$/g, '')
      const seenDirs = new Set<string>()
      const dirs: DirEntry[] = []
      const files: DirEntry[] = []

      for (const [filePath, meta] of Object.entries(repo.files)) {
        if (prefix && !filePath.startsWith(`${prefix}/`)) continue
        const remainder = prefix ? filePath.slice(prefix.length + 1) : filePath
        const parts = remainder.split('/')

        if (parts.length > 1) {
          const dirName = parts[0]
          const dirRel = prefix ? `${prefix}/${dirName}` : dirName
          if (!seenDirs.has(dirRel)) {
            seenDirs.add(dirRel)
            dirs.push({
              name: dirName,
              relPath: dirRel,
              isDir: true,
              size: 0,
              modifiedMs: Date.now(),
              ignored: dirName === 'dist' || dirName === 'node_modules',
              hidden: dirName.startsWith('.'),
            })
          }
        } else if (parts[0]) {
          files.push({
            name: parts[0],
            relPath: filePath,
            isDir: false,
            size: new TextEncoder().encode(meta.content).length,
            modifiedMs: Date.now(),
            ignored: Boolean(meta.ignored),
            hidden: parts[0].startsWith('.'),
          })
        }
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      return [...dirs, ...files]
    },

    async statPreview(projectId: string, relPath: string): Promise<FileMeta> {
      const repo = openSessions.get(projectId)
      if (!repo) throw new Error(`Project not found: ${projectId}`)
      const file = repo.files[relPath]
      if (!file) throw new Error(`File not found: ${relPath}`)
      const name = relPath.split('/').pop() || relPath
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

      return {
        projectId,
        relPath,
        name,
        ext,
        size: new TextEncoder().encode(file.content).length,
        modifiedMs: Date.now(),
        mime: file.mime || 'text/plain',
        isBinary: Boolean(file.isBinary),
        encoding: file.isBinary ? 'binary' : 'utf-8',
      }
    },

    async readText(projectId: string, relPath: string, maxBytes = 2 * 1024 * 1024): Promise<TextPayload> {
      const repo = openSessions.get(projectId)
      if (!repo) throw new Error(`Project not found: ${projectId}`)
      const file = repo.files[relPath]
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

    async pickFolder(): Promise<string | null> {
      const candidate = MOCK_REPOS[pickCursor % MOCK_REPOS.length]
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
