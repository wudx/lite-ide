import { DisposableStore, toDisposable, type AppKernel } from '@lite-ide/kernel'
import { isTauriEnvironment } from '@lite-ide/protocol'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { For, onCleanup, onMount, Show } from 'solid-js'
import {
  requestCloseProject,
  requestCloseTab,
  requestCloseWindow,
  requestSaveFile,
} from '../close-guards'
import { EditorBufferKey } from '../editor-buffers'
import { LayoutStateKey, ProjectSelectionKey, ThemeStateKey } from '../services'
import { ConfirmDialog } from './ConfirmDialog'
import { ProjectWorkspace } from './ProjectWorkspace'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { WelcomeEmpty } from './WelcomeEmpty'

export interface WorkbenchShellProps {
  kernel: AppKernel
}

export function WorkbenchShell(props: WorkbenchShellProps) {
  const disposables = new DisposableStore()

  onMount(() => {
    const layout = props.kernel.get(LayoutStateKey)

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.openProject',
        title: 'Open Project Folder',
        shortcut: 'Mod+O',
        run: async ({ kernel }) => {
          await kernel.openProjectWithDialog()
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.saveFile',
        title: 'Save Active File',
        shortcut: 'Mod+S',
        run: async ({ kernel, activeProject }) => {
          if (!activeProject) return
          const selection = activeProject.tryGet(ProjectSelectionKey)
          const path = selection?.selectedPath()
          if (!path) return
          await requestSaveFile(kernel, activeProject, path)
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.saveAllFiles',
        title: 'Save All Dirty Files',
        shortcut: 'Mod+Shift+S',
        run: async ({ activeProject }) => {
          if (!activeProject) return
          const buffers = activeProject.tryGet(EditorBufferKey)
          await buffers?.saveAllDirty()
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.closeTab',
        title: 'Close Active Editor Tab',
        shortcut: 'Mod+W',
        run: async ({ kernel, activeProject }) => {
          if (!activeProject) return
          const selection = activeProject.tryGet(ProjectSelectionKey)
          const targetTab = selection?.selectedPath() ?? selection?.openTabs()[0]?.relPath
          if (targetTab) {
            await requestCloseTab(kernel, activeProject, targetTab)
            return
          }
          await requestCloseProject(kernel, activeProject)
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.closeProject',
        title: 'Close Active Project',
        shortcut: 'Mod+Shift+W',
        run: async ({ kernel, activeProject }) => {
          if (activeProject) {
            await requestCloseProject(kernel, activeProject)
          }
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.toggleSidebar',
        title: 'Toggle Sidebar',
        shortcut: 'Mod+B',
        run: () => {
          layout.toggleSidebar()
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.toggleTheme',
        title: 'Toggle Color Theme',
        run: ({ kernel }) => {
          kernel.tryGet(ThemeStateKey)?.toggleTheme()
        },
      }),
    )

    const cycleProject = (delta: 1 | -1) => {
      const list = props.kernel.projects()
      if (list.length <= 1) return
      const currentId = props.kernel.activeProjectId()
      const idx = list.findIndex((p) => p.id === currentId)
      const nextIdx = (idx + delta + list.length) % list.length
      props.kernel.activateProject(list[nextIdx].id)
    }

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.nextProject',
        title: 'Next Project Tab',
        shortcut: 'Ctrl+Tab',
        run: () => cycleProject(1),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.prevProject',
        title: 'Previous Project Tab',
        shortcut: 'Ctrl+Shift+Tab',
        run: () => cycleProject(-1),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.nextTab',
        title: 'Next File Tab',
        shortcut: 'Ctrl+PageDown',
        run: async ({ activeProject }) => {
          const selection = activeProject?.tryGet(ProjectSelectionKey)
          await selection?.activateAdjacentTab(1)
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.prevTab',
        title: 'Previous File Tab',
        shortcut: 'Ctrl+PageUp',
        run: async ({ activeProject }) => {
          const selection = activeProject?.tryGet(ProjectSelectionKey)
          await selection?.activateAdjacentTab(-1)
        },
      }),
    )

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 's') {
          e.preventDefault()
          void props.kernel.executeCommand(
            e.shiftKey ? 'workbench.saveAllFiles' : 'workbench.saveFile',
          )
          return
        }
        if (key === 'o' && !e.shiftKey) {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.openProject')
          return
        }
        if (key === 'w') {
          e.preventDefault()
          void props.kernel.executeCommand(
            e.shiftKey ? 'workbench.closeProject' : 'workbench.closeTab',
          )
          return
        }
        if (key === 'b' && !e.shiftKey) {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.toggleSidebar')
          return
        }
      }
      if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        void props.kernel.executeCommand(
          e.shiftKey ? 'workbench.prevProject' : 'workbench.nextProject',
        )
        return
      }
      if (e.ctrlKey && !e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault()
        void props.kernel.executeCommand(
          e.key === 'PageDown' ? 'workbench.nextTab' : 'workbench.prevTab',
        )
      }
    }

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasDirty = props.kernel
        .projects()
        .some((scope) => scope.tryGet(EditorBufferKey)?.hasDirtyFiles())
      if (hasDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }

    let allowWindowClose = false
    if (isTauriEnvironment()) {
      const win = getCurrentWindow()
      void win
        .onCloseRequested((event) => {
          if (allowWindowClose) return
          const hasDirty = props.kernel
            .projects()
            .some((scope) => scope.tryGet(EditorBufferKey)?.hasDirtyFiles())
          if (!hasDirty) return

          event.preventDefault()
          void requestCloseWindow(props.kernel).then((canClose) => {
            if (canClose) {
              allowWindowClose = true
              void win.close()
            }
          })
        })
        .then((unlisten) => {
          disposables.add(toDisposable(unlisten))
        })
        .catch(() => {})
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('beforeunload', handleBeforeUnload)
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      disposables.dispose()
    })
  })

  return (
    <div class="h-screen w-screen overflow-hidden flex flex-col workbench-shell-bg text-[var(--text-primary)] ring-1 ring-inset ring-[var(--window-ring)]">
      <TitleBar kernel={props.kernel} />

      <main class="flex-1 min-h-0 flex relative px-2 pb-1.5 pt-0.5">
        <Show
          when={props.kernel.projects().length > 0}
          fallback={<WelcomeEmpty kernel={props.kernel} />}
        >
          <For each={props.kernel.projects()}>
            {(scope) => (
              <Show when={props.kernel.isWarm(scope.id)}>
                <ProjectWorkspace
                  kernel={props.kernel}
                  scope={scope}
                  active={props.kernel.activeProjectId() === scope.id}
                />
              </Show>
            )}
          </For>
        </Show>
      </main>

      <StatusBar kernel={props.kernel} />
      <ConfirmDialog kernel={props.kernel} />
    </div>
  )
}
