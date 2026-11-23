import './styles/app.css'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createDefaultBackend, MOCK_DEMO_PATHS, type PluginManifest } from '@lite-ide/protocol'
import {
  createWorkbenchKernel,
  WorkbenchShell,
  type EmbeddedPluginSource,
} from '@lite-ide/workbench'
import { render } from 'solid-js/web'
// 嵌入式内置插件（"一切皆插件"）：按外部插件格式构建的 dist 内联进应用包，
// 与用户安装的外部插件走同一加载器。dist 由根脚本 `build:plugins` 产出，
// dev 时可运行 `watch:plugins` 让改动即时生效。
import explorerManifest from '../../../plugins/explorer/plugin.json'
import explorerSource from '../../../plugins/explorer/dist/plugin.js?raw'
import explorerCss from '../../../plugins/explorer/dist/plugin.css?raw'
import gitManifest from '../../../plugins/git/plugin.json'
import gitSource from '../../../plugins/git/dist/plugin.js?raw'
import gitCss from '../../../plugins/git/dist/plugin.css?raw'
import gitXlsxChunk from '../../../plugins/git/dist/xlsx.js?raw'
import previewAudioManifest from '../../../plugins/preview-audio/plugin.json'
import previewAudioSource from '../../../plugins/preview-audio/dist/plugin.js?raw'
import previewAudioCss from '../../../plugins/preview-audio/dist/plugin.css?raw'
import previewFallbackManifest from '../../../plugins/preview-fallback/plugin.json'
import previewFallbackSource from '../../../plugins/preview-fallback/dist/plugin.js?raw'
import previewFallbackCss from '../../../plugins/preview-fallback/dist/plugin.css?raw'
import previewImageManifest from '../../../plugins/preview-image/plugin.json'
import previewImageSource from '../../../plugins/preview-image/dist/plugin.js?raw'
import previewImageCss from '../../../plugins/preview-image/dist/plugin.css?raw'
import previewMarkdownManifest from '../../../plugins/preview-markdown/plugin.json'
import previewMarkdownSource from '../../../plugins/preview-markdown/dist/plugin.js?raw'
import previewMarkdownCss from '../../../plugins/preview-markdown/dist/plugin.css?raw'
import previewCodeManifest from '../../../plugins/preview-code/plugin.json'
import previewCodeSource from '../../../plugins/preview-code/dist/plugin.js?raw'
import previewCodeCss from '../../../plugins/preview-code/dist/plugin.css?raw'
import terminalManifest from '../../../plugins/terminal/plugin.json'
import terminalSource from '../../../plugins/terminal/dist/plugin.js?raw'
import terminalCss from '../../../plugins/terminal/dist/plugin.css?raw'
import themeNordManifest from '../../../plugins/theme-nord/plugin.json'
import themeNordSource from '../../../plugins/theme-nord/dist/plugin.js?raw'

const OPEN_PROJECTS_STORAGE_KEY = 'lite-ide.openProjects.v1'
const ACTIVE_PROJECT_STORAGE_KEY = 'lite-ide.activeProject.v1'

// resolveJsonModule 把可选联合字段宽化为 string，这里收窄回契约类型。
const asManifest = (m: unknown) => m as PluginManifest

const EMBEDDED_PLUGINS: EmbeddedPluginSource[] = [
  {
    manifest: asManifest(explorerManifest),
    source: explorerSource,
    assets: { 'plugin.css': explorerCss },
  },
  {
    manifest: asManifest(gitManifest),
    source: gitSource,
    assets: { 'plugin.css': gitCss, 'xlsx.js': gitXlsxChunk },
  },
  {
    manifest: asManifest(themeNordManifest),
    source: themeNordSource,
  },
  {
    manifest: asManifest(previewMarkdownManifest),
    source: previewMarkdownSource,
    assets: { 'plugin.css': previewMarkdownCss },
  },
  {
    manifest: asManifest(previewImageManifest),
    source: previewImageSource,
    assets: { 'plugin.css': previewImageCss },
  },
  {
    manifest: asManifest(previewAudioManifest),
    source: previewAudioSource,
    assets: { 'plugin.css': previewAudioCss },
  },
  {
    manifest: asManifest(previewFallbackManifest),
    source: previewFallbackSource,
    assets: { 'plugin.css': previewFallbackCss },
  },
  {
    manifest: asManifest(previewCodeManifest),
    source: previewCodeSource,
    assets: { 'plugin.css': previewCodeCss },
  },
  {
    manifest: asManifest(terminalManifest),
    source: terminalSource,
    assets: { 'plugin.css': terminalCss },
  },
]

const backend = createDefaultBackend()
const kernel = createWorkbenchKernel(backend, 5, { embeddedPlugins: EMBEDDED_PLUGINS })

let restoringSession = true

function persistSession() {
  if (restoringSession || typeof localStorage === 'undefined') return
  try {
    const paths = kernel.projects().map((p) => p.rootPath)
    localStorage.setItem(OPEN_PROJECTS_STORAGE_KEY, JSON.stringify(paths))
    const active = kernel.activeProject()
    if (active) {
      localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, active.rootPath)
    } else {
      localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY)
    }
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

kernel.onEvent('project.opened', persistSession)
kernel.onEvent('project.closed', persistSession)
kernel.onEvent('project.activated', persistSession)
// 拖拽排序过程中每次实时换位都会触发一次重排事件，尾随去抖合并为一次写盘。
let reorderPersistTimer: ReturnType<typeof setTimeout> | undefined
kernel.onEvent('project.reordered', () => {
  if (reorderPersistTimer !== undefined) clearTimeout(reorderPersistTimer)
  reorderPersistTimer = setTimeout(() => {
    reorderPersistTimer = undefined
    persistSession()
  }, 120)
})

async function restoreSession() {
  try {
    let savedPaths: string[] = []
    let savedActive: string | null = null

    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(OPEN_PROJECTS_STORAGE_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          savedPaths = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
        }
      }
      savedActive = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)
    }

    if (savedPaths.length === 0 && backend.kind === 'mock') {
      savedPaths = [...MOCK_DEMO_PATHS]
      savedActive = MOCK_DEMO_PATHS[0] ?? null
    }

    for (const projectPath of savedPaths) {
      try {
        await kernel.openProject(projectPath)
      } catch {
        // Silently ignore deleted or unreachable folders during restore.
      }
    }

    if (savedActive) {
      const target = kernel.projects().find((p) => p.rootPath === savedActive)
      if (target) {
        kernel.activateProject(target.id)
      }
    }
  } finally {
    restoringSession = false
    persistSession()
  }
}

const rootEl = document.getElementById('root')
if (rootEl) {
  render(() => <WorkbenchShell kernel={kernel} />, rootEl)
}

// 桌面端：接住来自任务栏跳转列表 / 二次启动转发的「打开该项目文件夹」请求。
// 冷启动参数在监听器就绪后、会话恢复完成前暂存，恢复完再打开以获得焦点。
let launchProjectPath: string | null = null

function openExternalProject(path: string): Promise<void> {
  return kernel.openProject(path).then(
    () => undefined,
    () => undefined,
  )
}

async function wireExternalProjectRequests(): Promise<void> {
  if (backend.kind !== 'tauri') return
  try {
    await listen<string>('open-project-request', (event) => {
      if (typeof event.payload === 'string' && event.payload.length > 0) {
        void openExternalProject(event.payload)
      }
    })
  } catch {
    // Event wiring failed — jump list / second-launch opens stay inert,
    // but normal usage and session restore must keep working.
  }
  try {
    const launch = await invoke<string | null>('app_get_launch_project')
    if (typeof launch === 'string' && launch.length > 0) {
      launchProjectPath = launch
    }
  } catch {
    // Command missing (older backend) — nothing to do.
  }
}

async function start() {
  await wireExternalProjectRequests()
  await restoreSession()
  if (launchProjectPath) {
    await openExternalProject(launchProjectPath)
    launchProjectPath = null
  }
}

void start()
