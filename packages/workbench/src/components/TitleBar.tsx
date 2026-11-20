import type { AppKernel } from '@lite-ide/kernel'
import { isTauriEnvironment } from '@lite-ide/protocol'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Copy from 'lucide-solid/icons/copy'
import FolderGit2 from 'lucide-solid/icons/folder-git-2'
import Minus from 'lucide-solid/icons/minus'
import Moon from 'lucide-solid/icons/moon'
import PanelLeft from 'lucide-solid/icons/panel-left'
import Plus from 'lucide-solid/icons/plus'
import Square from 'lucide-solid/icons/square'
import Sun from 'lucide-solid/icons/sun'
import X from 'lucide-solid/icons/x'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { requestCloseProject } from '../close-guards'
import { EditorBufferKey } from '../editor-buffers'
import { LayoutStateKey, ThemeStateKey } from '../services'

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
  const themeState = props.kernel.tryGet(ThemeStateKey)
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
      class={`h-[44px] shrink-0 flex items-center bg-[var(--bg-titlebar)] select-none ${
        isMac ? 'pl-[76px] pr-2.5' : 'pl-2.5 pr-2'
      }`}
    >
      {/* Brand + Sidebar toggle */}
      <div class="flex items-center gap-1.5 pr-2.5 shrink-0">
        <div
          class="flex items-center gap-2 px-1.5 py-1 text-[12.5px] font-semibold tracking-tight text-[var(--text-primary)]"
          data-tauri-drag-region
        >
          <span class="w-5 h-5 rounded-md bg-gradient-to-br from-[#7aa2ff] to-[#6366f1] flex items-center justify-center shadow-[0_2px_10px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.28)] pointer-events-none">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              class="w-3 h-3 text-white pointer-events-none"
              aria-hidden="true"
            >
              <path
                d="M8 2.2 13.4 5.3 8 8.4 2.6 5.3 8 2.2Z"
                fill="currentColor"
                fill-opacity="0.95"
              />
              <path
                d="M2.6 8.2 8 11.3l5.4-3.1M2.6 10.9 8 14l5.4-3.1"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <span class="pointer-events-none">LiteIDE</span>
        </div>

        <Show when={layout && props.kernel.projects().length > 0}>
          <button
            type="button"
            class={`w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-150 active:scale-95 ${
              layout?.sidebarVisible()
                ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-hover-strong)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
            title="Toggle Sidebar (Ctrl+B)"
            onClick={() => void props.kernel.executeCommand('workbench.toggleSidebar')}
          >
            <PanelLeft class="w-3.5 h-3.5" />
          </button>
        </Show>
      </div>

      {/* Project Tabs Strip (capsule tabs, one tab = one project) */}
      <div class="flex items-center gap-1.5 py-1.5 overflow-x-auto no-scrollbar min-w-0">
        <For each={props.kernel.projects()}>
          {(scope) => {
            const isActive = () => props.kernel.activeProjectId() === scope.id
            const hasDirty = () => scope.tryGet(EditorBufferKey)?.hasDirtyFiles() ?? false
            return (
              <div
                role="tab"
                aria-selected={isActive()}
                title={scope.rootPath}
                class={`group relative h-[30px] flex items-center gap-2 px-2.5 min-w-[112px] max-w-[216px] rounded-lg border text-xs transition-all duration-150 shrink-0 ${
                  isActive()
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border-[var(--border-panel)] shadow-[var(--shadow-tab)]'
                    : 'bg-transparent border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => props.kernel.activateProject(scope.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    void requestCloseProject(props.kernel, scope)
                  }
                }}
              >
                <FolderGit2
                  class={`w-3.5 h-3.5 shrink-0 transition-colors ${
                    isActive() ? 'text-[var(--accent)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]'
                  }`}
                />
                <span class="truncate flex-1 font-medium leading-normal">{scope.name}</span>
                <div class="w-4 h-4 flex items-center justify-center shrink-0">
                  <Show when={hasDirty()}>
                    <span
                      title="Unsaved files in project"
                      class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)] group-hover:hidden"
                    />
                  </Show>
                  <button
                    type="button"
                    title="Close Project (Ctrl+Shift+W)"
                    class={`p-0.5 rounded-md hover:bg-[var(--bg-hover-strong)] transition-all duration-150 ${
                      hasDirty()
                        ? 'hidden group-hover:flex items-center justify-center'
                        : isActive()
                          ? 'opacity-65 hover:opacity-100'
                          : 'opacity-0 group-hover:opacity-80 hover:opacity-100'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void requestCloseProject(props.kernel, scope)
                    }}
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              </div>
            )
          }}
        </For>

        <button
          type="button"
          class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95"
          title="Open Project Folder (Ctrl+O)"
          onClick={() => void props.kernel.executeCommand('workbench.openProject')}
        >
          <Plus class="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Draggable empty spacer */}
      <div class="flex-1 min-w-[32px] h-full" data-tauri-drag-region />

      {/* Right actions: Theme switcher */}
      <div class="flex items-center gap-1 pr-1 shrink-0">
        <Show when={themeState}>
          {(ts) => {
            const isDark = () => ts().theme() === 'dark'
            return (
              <button
                type="button"
                aria-label={isDark() ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
                title={isDark() ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
                class="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95"
                onClick={() => void props.kernel.executeCommand('workbench.toggleTheme')}
              >
                <Show when={isDark()} fallback={<Moon class="w-3.5 h-3.5" />}>
                  <Sun class="w-3.5 h-3.5" />
                </Show>
              </button>
            )
          }}
        </Show>
      </div>

      {/* Native-style window controls on Windows / Linux */}
      <Show when={isTauri && !isMac}>
        <div class="flex items-stretch self-stretch shrink-0 -mr-2">
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
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-red-500/85 hover:text-white transition-colors"
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
