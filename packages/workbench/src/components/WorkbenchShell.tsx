import { DisposableStore, type AppKernel } from '@lite-ide/kernel'
import { For, onCleanup, onMount, Show } from 'solid-js'
import { LayoutStateKey } from '../services'
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
        id: 'workbench.closeProject',
        title: 'Close Active Project',
        shortcut: 'Mod+W',
        run: async ({ kernel, activeProject }) => {
          if (activeProject) {
            await kernel.closeProject(activeProject.id)
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

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'o') {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.openProject')
          return
        }
        if (key === 'w') {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.closeProject')
          return
        }
        if (key === 'b') {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.toggleSidebar')
          return
        }
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        void props.kernel.executeCommand(
          e.shiftKey ? 'workbench.prevProject' : 'workbench.nextProject',
        )
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown)
      disposables.dispose()
    })
  })

  return (
    <div class="h-screen w-screen overflow-hidden flex flex-col bg-[var(--bg-app)] text-[var(--text-primary)]">
      <TitleBar kernel={props.kernel} />

      <main class="flex-1 min-h-0 flex relative">
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
    </div>
  )
}
