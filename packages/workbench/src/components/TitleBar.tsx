import type { AppKernel } from '@lite-ide/kernel'
import { isTauriEnvironment } from '@lite-ide/protocol'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { FolderGit2, Minus, PanelLeft, Plus, Square, Copy, X } from 'lucide-solid'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { LayoutStateKey } from '../services'

export interface TitleBarProps {
  kernel: AppKernel
}

function isMacOsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac/i.test(navigator.platform || navigator.userAgent || '')
}

export function TitleBar(props: TitleBarProps) {
  const isMac = isMacOsPlatform()
  const isTauri = isTauriEnvironment()
  const layout = props.kernel.tryGet(LayoutStateKey)
  const [maximized, setMaximized] = createSignal(false)

  onMount(() => {
    if (!isTauri || isMac) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | undefined

    void win.isMaximized().then(setMaximized).catch(() => {})
    void win
      .onResized(async () => {
        try {
          setMaximized(await win.isMaximized())
        } catch {
          // ignore
        }
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})

    onCleanup(() => {
      unlisten?.()
    })
  })

  async function handleMinimize() {
    if (!isTauri) return
    await getCurrentWindow().minimize()
  }

  async function handleToggleMaximize() {
    if (!isTauri) return
    const win = getCurrentWindow()
    await win.toggleMaximize()
    setMaximized(await win.isMaximized())
  }

  async function handleCloseWindow() {
    if (!isTauri) return
    await getCurrentWindow().close()
  }

  return (
    <header
      class={`h-[38px] shrink-0 flex items-stretch bg-[var(--bg-titlebar)] border-b border-[var(--border-subtle)] select-none ${
        isMac ? 'pl-[72px]' : 'pl-2'
      }`}
    >
      {/* Brand + Sidebar toggle */}
      <div class="flex items-center gap-1 pr-2 shrink-0">
        <div
          class="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold tracking-tight text-[var(--text-secondary)]"
          data-tauri-drag-region
        >
          <span class="inline-block w-2 h-2 rounded-full bg-[var(--accent)]" />
          <span>LiteIDE</span>
        </div>

        <Show when={layout && props.kernel.projects().length > 0}>
          <button
            type="button"
            class={`p-1.5 rounded hover:bg-[var(--bg-hover)] transition-colors ${
              layout?.sidebarVisible()
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-muted)]'
            }`}
            title="Toggle Sidebar (Ctrl+B)"
            onClick={() => void props.kernel.executeCommand('workbench.toggleSidebar')}
          >
            <PanelLeft class="w-3.5 h-3.5" />
          </button>
        </Show>
      </div>

      {/* Project Tabs Strip (one tab = one project) */}
      <div class="flex items-stretch overflow-x-auto no-scrollbar max-w-[calc(100%-220px)]">
        <For each={props.kernel.projects()}>
          {(scope) => {
            const isActive = () => props.kernel.activeProjectId() === scope.id
            return (
              <div
                role="tab"
                aria-selected={isActive()}
                title={scope.rootPath}
                class={`group relative flex items-center gap-1.5 px-3 min-w-[110px] max-w-[210px] border-r border-[var(--border-subtle)] cursor-pointer text-xs transition-colors ${
                  isActive()
                    ? 'bg-[var(--bg-editor)] text-[var(--text-primary)]'
                    : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => props.kernel.activateProject(scope.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    void props.kernel.closeProject(scope.id)
                  }
                }}
              >
                <Show when={isActive()}>
                  <span class="absolute top-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
                </Show>

                <FolderGit2
                  class={`w-3.5 h-3.5 shrink-0 ${
                    isActive() ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'
                  }`}
                />
                <span class="truncate flex-1 font-medium">{scope.name}</span>
                <button
                  type="button"
                  title="Close Project (Ctrl+W)"
                  class={`p-0.5 rounded hover:bg-[var(--bg-active)] transition-opacity ${
                    isActive() ? 'opacity-75 hover:opacity-100' : 'opacity-0 group-hover:opacity-80'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void props.kernel.closeProject(scope.id)
                  }}
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            )
          }}
        </For>

        <button
          type="button"
          class="flex items-center justify-center w-8 shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          title="Open Project Folder (Ctrl+O)"
          onClick={() => void props.kernel.executeCommand('workbench.openProject')}
        >
          <Plus class="w-4 h-4" />
        </button>
      </div>

      {/* Draggable empty spacer */}
      <div class="flex-1 min-w-[24px]" data-tauri-drag-region />

      {/* Native-style window controls on Windows / Linux */}
      <Show when={isTauri && !isMac}>
        <div class="flex items-stretch shrink-0">
          <button
            type="button"
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title="Minimize"
            onClick={() => void handleMinimize()}
          >
            <Minus class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title={maximized() ? 'Restore' : 'Maximize'}
            onClick={() => void handleToggleMaximize()}
          >
            <Show when={maximized()} fallback={<Square class="w-3 h-3" />}>
              <Copy class="w-3 h-3" />
            </Show>
          </button>
          <button
            type="button"
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-red-600 hover:text-white transition-colors"
            title="Close"
            onClick={() => void handleCloseWindow()}
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </Show>
    </header>
  )
}
