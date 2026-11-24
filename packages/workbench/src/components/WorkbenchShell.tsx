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
import { getI18n } from '../i18n'
import { SettingsDialogKey } from '../dialogs'
import { CodeNavigationKey } from '../navigation'
import { LayoutStateKey, ProjectSelectionKey, ThemeStateKey } from '../services'
import { QuickOpenKey } from '../quick-open'
import { AppearanceSettings } from './AppearanceSettings'
import { ConfirmDialog } from './ConfirmDialog'
import { GeneralSettings } from './GeneralSettings'
import { ModelSettings } from './ModelSettings'
import { NavigationPanel } from './NavigationPanel'
import { ProjectWorkspace } from './ProjectWorkspace'
import { QuickOpenDialog } from './QuickOpenDialog'
import { PluginSettings } from './PluginSettings'
import { SettingsDialog } from './SettingsDialog'
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
        titleKey: 'command.openProject',
        shortcut: 'Mod+O',
        run: async ({ kernel }) => {
          const i18n = getI18n(kernel)
          await kernel.openProjectWithDialog({ title: i18n.t('command.openProject') })
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.saveFile',
        title: 'Save Active File',
        titleKey: 'command.saveFile',
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
        titleKey: 'command.saveAllFiles',
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
        titleKey: 'command.closeTab',
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
        titleKey: 'command.closeProject',
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
        id: 'workbench.quickOpen',
        title: 'Quick Open File by Name',
        titleKey: 'command.quickOpen',
        shortcut: 'Mod+P',
        run: ({ kernel }) => {
          kernel.tryGet(QuickOpenKey)?.open()
        },
      }),
    )

    // Code navigation: definition / references / implementations of the word
    // under the editor cursor (F12 family). The actions run against the
    // active project's symbol index.
    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.gotoDefinition',
        title: 'Go to Definition',
        titleKey: 'command.gotoDefinition',
        shortcut: 'F12',
        run: ({ activeProject }) => activeProject?.tryGet(CodeNavigationKey)?.gotoDefinition(),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.findReferences',
        title: 'Find References',
        titleKey: 'command.findReferences',
        shortcut: 'Shift+F12',
        run: ({ activeProject }) => activeProject?.tryGet(CodeNavigationKey)?.findReferences(),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.gotoImplementation',
        title: 'Go to Implementation',
        titleKey: 'command.gotoImplementation',
        shortcut: 'Ctrl+F12',
        run: ({ activeProject }) => activeProject?.tryGet(CodeNavigationKey)?.gotoImplementation(),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.toggleSidebar',
        title: 'Toggle Sidebar',
        titleKey: 'command.toggleSidebar',
        shortcut: 'Mod+B',
        run: () => {
          layout.toggleSidebar()
        },
      }),
    )

    // No built-in entry point (the settings dialog covers theme picking);
    // kept as public command surface for plugins and automation.
    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.toggleTheme',
        title: 'Cycle Color Theme',
        titleKey: 'command.toggleTheme',
        run: ({ kernel }) => {
          kernel.tryGet(ThemeStateKey)?.toggleTheme()
        },
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.openSettings',
        title: 'Open Settings',
        titleKey: 'command.openSettings',
        shortcut: 'Mod+,',
        run: ({ kernel }) => {
          kernel.tryGet(SettingsDialogKey)?.open()
        },
      }),
    )

    // Built-in appearance section: the workbench ships its own theme picker.
    disposables.add(
      props.kernel.contribute('settings.section', {
        id: 'workbench.appearance',
        title: '外观',
        titleKey: 'settings.section.appearance',
        order: 0,
        component: AppearanceSettings,
      }),
    )

    // Built-in general section: display language selector.
    disposables.add(
      props.kernel.contribute('settings.section', {
        id: 'workbench.general',
        title: '通用',
        titleKey: 'settings.section.general',
        order: 5,
        component: GeneralSettings,
      }),
    )

    // Built-in models section: AI provider configuration (built-in presets
    // plus user-added custom providers).
    disposables.add(
      props.kernel.contribute('settings.section', {
        id: 'workbench.models',
        title: '模型',
        titleKey: 'settings.section.models',
        order: 10,
        component: ModelSettings,
      }),
    )

    // Built-in plugins section: external plugin install / uninstall manager.
    disposables.add(
      props.kernel.contribute('settings.section', {
        id: 'workbench.plugins',
        title: '插件',
        titleKey: 'settings.section.plugins',
        order: 15,
        component: PluginSettings,
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
        titleKey: 'command.nextProject',
        shortcut: 'Ctrl+Tab',
        run: () => cycleProject(1),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.prevProject',
        title: 'Previous Project Tab',
        titleKey: 'command.prevProject',
        shortcut: 'Ctrl+Shift+Tab',
        run: () => cycleProject(-1),
      }),
    )

    disposables.add(
      props.kernel.contribute('command', {
        id: 'workbench.nextTab',
        title: 'Next File Tab',
        titleKey: 'command.nextTab',
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
        titleKey: 'command.prevTab',
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
        if (key === 'p' && !e.shiftKey) {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.quickOpen')
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
        if (key === ',' && !e.shiftKey) {
          e.preventDefault()
          void props.kernel.executeCommand('workbench.openSettings')
          return
        }
      }
      if (e.key === 'F12' && !e.altKey) {
        e.preventDefault()
        void props.kernel.executeCommand(
          e.ctrlKey || e.metaKey
            ? 'workbench.gotoImplementation'
            : e.shiftKey
              ? 'workbench.findReferences'
              : 'workbench.gotoDefinition',
        )
        return
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

    const handleContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      e.preventDefault()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    // 在冒泡阶段全局屏蔽浏览器/WebView 原生右键菜单，让组件和插件的自定义
    // onContextMenu 优先执行，其余未处理区域冒泡到此处后统一兜底拦截。
    window.addEventListener('contextmenu', handleContextMenu)
    // beforeunload 拦截仅用于浏览器 mock 模式的刷新保护；Tauri 下 preventDefault
    // 会阻塞 webview 卸载，使已确认的 close()/destroy()（如"不保存退出"路径，此时
    // 脏缓冲仍在）静默失败，窗口无法关闭。
    if (!isTauriEnvironment()) {
      window.addEventListener('beforeunload', handleBeforeUnload)
    }
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('contextmenu', handleContextMenu)
      if (!isTauriEnvironment()) {
        window.removeEventListener('beforeunload', handleBeforeUnload)
      }
      disposables.dispose()
    })
  })

  return (
    <div class="h-screen w-screen overflow-hidden flex flex-col workbench-shell-bg text-[var(--text-primary)]">
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
      <SettingsDialog kernel={props.kernel} />
      <QuickOpenDialog kernel={props.kernel} />
      <NavigationPanel kernel={props.kernel} />
    </div>
  )
}
