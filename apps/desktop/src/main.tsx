import './styles/app.css'
import { explorerPlugin } from '@lite-ide/plugin-explorer'
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

void restoreSession()
