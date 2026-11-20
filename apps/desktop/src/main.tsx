import './styles/app.css'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { explorerPlugin } from '@lite-ide/plugin-explorer'
import { previewAudioPlugin } from '@lite-ide/plugin-preview-audio'
import { previewCodePlugin } from '@lite-ide/plugin-preview-code'
import { previewFallbackPlugin } from '@lite-ide/plugin-preview-fallback'
import { previewImagePlugin } from '@lite-ide/plugin-preview-image'
import { previewMarkdownPlugin } from '@lite-ide/plugin-preview-markdown'
import { themeNordPlugin } from '@lite-ide/plugin-theme-nord'
import { createDefaultBackend, MOCK_DEMO_PATHS } from '@lite-ide/protocol'
import { createWorkbenchKernel, WorkbenchShell } from '@lite-ide/workbench'
import { render } from 'solid-js/web'

const OPEN_PROJECTS_STORAGE_KEY = 'lite-ide.openProjects.v1'
const ACTIVE_PROJECT_STORAGE_KEY = 'lite-ide.activeProject.v1'

const backend = createDefaultBackend()
const kernel = createWorkbenchKernel(backend, 5)

// Register all first-party built-in plugins through the micro-kernel API.
kernel.registerPlugin(explorerPlugin)
kernel.registerPlugin(previewCodePlugin)
kernel.registerPlugin(previewMarkdownPlugin)
kernel.registerPlugin(previewImagePlugin)
kernel.registerPlugin(previewAudioPlugin)
kernel.registerPlugin(previewFallbackPlugin)
kernel.registerPlugin(themeNordPlugin)

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
