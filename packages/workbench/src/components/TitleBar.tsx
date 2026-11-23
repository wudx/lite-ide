import type { AppKernel } from '@lite-ide/kernel'
import { isTauriEnvironment } from '@lite-ide/protocol'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Copy from 'lucide-solid/icons/copy'
import FolderGit2 from 'lucide-solid/icons/folder-git-2'
import Minus from 'lucide-solid/icons/minus'
import PanelLeft from 'lucide-solid/icons/panel-left'
import Plus from 'lucide-solid/icons/plus'
import Settings from 'lucide-solid/icons/settings'
import Square from 'lucide-solid/icons/square'
import X from 'lucide-solid/icons/x'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { requestCloseProject } from '../close-guards'
import { EditorBufferKey } from '../editor-buffers'
import { getI18n } from '../i18n'
import { LayoutStateKey } from '../services'
import { createTabDragReorder } from '../tab-drag'

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
  const i18n = getI18n(props.kernel)
  const [maximized, setMaximized] = createSignal(false)
  let projectStrip: HTMLDivElement | undefined

  const tabDrag = createTabDragReorder({
    getStrip: () => projectStrip,
    reorder: (fromIndex, toIndex) => props.kernel.reorderProjects(fromIndex, toIndex),
  })

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
          <img
            src="/icon.png"
            alt=""
            draggable={false}
            class="w-5 h-5 pointer-events-none drop-shadow-[0_2px_10px_var(--accent-glow)]"
          />
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
            title={i18n.t('titlebar.toggleSidebar')}
            onClick={() => void props.kernel.executeCommand('workbench.toggleSidebar')}
          >
            <PanelLeft class="w-3.5 h-3.5" />
          </button>
        </Show>
      </div>

      {/* Project Tabs Strip (capsule tabs, one tab = one project) */}
      <div
        ref={(el) => (projectStrip = el)}
        class="flex items-center gap-1.5 py-1.5 overflow-x-auto no-scrollbar min-w-0"
      >
        <For each={props.kernel.projects()}>
          {(scope) => {
            const isActive = () => props.kernel.activeProjectId() === scope.id
            const hasDirty = () => scope.tryGet(EditorBufferKey)?.hasDirtyFiles() ?? false
            const isDragging = () => tabDrag.draggingId() === scope.id
            return (
              <div
                role="tab"
                aria-selected={isActive()}
                title={scope.rootPath}
                data-tab-drag-id={scope.id}
                {...tabDrag.tabHandlers(scope.id)}
                class={`group relative h-[30px] flex items-center gap-2 px-2.5 min-w-[112px] max-w-[216px] rounded-lg border text-xs transition-all duration-150 shrink-0 ${
                  isDragging() ? 'opacity-70 scale-[0.97] z-20' : ''
                } ${
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
                      title={i18n.t('titlebar.unsavedInProject')}
                      class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)] group-hover:hidden"
                    />
                  </Show>
                  <button
                    type="button"
                    title={i18n.t('titlebar.closeProject')}
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
          title={i18n.t('titlebar.openProject')}
          onClick={() => void props.kernel.executeCommand('workbench.openProject')}
        >
          <Plus class="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Draggable empty spacer */}
      <div class="flex-1 min-w-[32px] h-full" data-tauri-drag-region />

      {/* Right actions: Settings */}
      <div class="flex items-center gap-1 pr-1 shrink-0">
        <button
          type="button"
          aria-label={i18n.t('titlebar.openSettingsAria')}
          title={i18n.t('titlebar.openSettings')}
          class="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-95"
          onClick={() => void props.kernel.executeCommand('workbench.openSettings')}
        >
          <Settings class="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Native-style window controls on Windows / Linux */}
      <Show when={isTauri && !isMac}>
        <div class="flex items-stretch self-stretch shrink-0 -mr-2">
          <button
            type="button"
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title={i18n.t('titlebar.minimize')}
            onClick={() => void handleMinimize()}
          >
            <Minus class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title={maximized() ? i18n.t('titlebar.restore') : i18n.t('titlebar.maximize')}
            onClick={() => void handleToggleMaximize()}
          >
            <Show when={maximized()} fallback={<Square class="w-3 h-3" />}>
              <Copy class="w-3 h-3" />
            </Show>
          </button>
          <button
            type="button"
            class="w-11 flex items-center justify-center text-[var(--text-secondary)] hover:bg-red-500/85 hover:text-white transition-colors"
            title={i18n.t('titlebar.close')}
            onClick={() => void handleCloseWindow()}
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </Show>
    </header>
  )
}
