import type { Plugin } from '@lite-ide/kernel'
import { PanelStateKey, WorkspaceBackendKey } from '@lite-ide/workbench'
import TerminalIcon from 'lucide-solid/icons/terminal'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_EN_US, TERMINAL_ZH_CN } from './i18n'
import './plugin.css'
import { TerminalStatusBarItem } from './TerminalStatusBarItem'
import { TerminalView } from './TerminalView'
import {
  createTerminalManager,
  createTerminalStore,
  TERMINAL_PANEL_ID,
  TerminalStoreKey,
  toggleTerminalPanel,
} from './terminal-store'

export {
  createTerminalManager,
  createTerminalStore,
  TERMINAL_PANEL_ID,
  TerminalStoreKey,
  toggleTerminalPanel,
  type TerminalManagerStore,
  type TerminalStatus,
  type TerminalStore,
  type TerminalTabSession,
} from './terminal-store'
export { TerminalView } from './TerminalView'
export { TerminalStatusBarItem } from './TerminalStatusBarItem'
export { TERMINAL_EN_US, TERMINAL_ZH_CN } from './i18n'

export const terminalPlugin: Plugin = {
  id: 'builtin.terminal',
  name: 'Terminal',
  activate(ctx) {
    ctx.contribute('i18n', { locale: 'zh-CN', messages: TERMINAL_ZH_CN })
    ctx.contribute('i18n', { locale: 'en-US', messages: TERMINAL_EN_US })

    // One store per project scope: the shell session starts lazily when the
    // panel view first becomes visible, and dies with the project. Returning
    // the disposable ties store disposal to THIS plugin's lifecycle too —
    // disabling the plugin kills running sessions instead of leaking them
    // until project close (kernel replays the hook and disposes the result).
    ctx.onProjectOpen((scope) => {
      const backend = ctx.get(WorkspaceBackendKey)
      const manager = createTerminalManager(scope.id, backend)
      scope.provide(TerminalStoreKey, manager)
      return scope.onDispose(() => manager.dispose())
    })

    ctx.contribute('panel.view', {
      id: TERMINAL_PANEL_ID,
      title: 'Terminal',
      titleKey: 'terminal.panel.title',
      order: 10,
      icon: TerminalIcon,
      customHeader: true,
      component: TerminalView,
    })

    ctx.contribute('statusbar.item', {
      id: 'terminal.statusbar',
      align: 'right',
      order: 40,
      component: TerminalStatusBarItem,
    })

    ctx.contribute('command', {
      id: 'terminal.toggle',
      title: 'Toggle Terminal Panel',
      titleKey: 'terminal.command.toggle',
      shortcut: 'Mod+`',
      run: ({ kernel, activeProject }) => {
        toggleTerminalPanel(
          kernel.get(PanelStateKey),
          TERMINAL_PANEL_ID,
          activeProject?.tryGet(TerminalStoreKey),
        )
      },
    })

    ctx.contribute('command', {
      id: 'terminal.new',
      title: 'New Terminal',
      titleKey: 'terminal.command.new',
      shortcut: 'Mod+Shift+`',
      run: ({ kernel, activeProject }) => {
        if (!activeProject) return
        const panelState = kernel.get(PanelStateKey)
        const manager = activeProject.tryGet(TerminalStoreKey)
        if (manager) {
          const tabs = manager.tabs()
          const reuseFreshDefault =
            !panelState.visible() && tabs.length === 1 && tabs[0].store.status() === 'idle'
          if (!reuseFreshDefault) {
            manager.createTab()
          }
        }
        panelState.setVisible(true)
        panelState.setActivePanelId(TERMINAL_PANEL_ID)
      },
    })

    // Ctrl+` / Ctrl+Shift+`（VS Code 惯例）：workbench 只登记自己的键位，终端快捷键由插件自带；
    // capture 阶段监听并在停用/卸载时随插件上下文移除。
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key !== '`' && e.key !== '~' && e.code !== 'Backquote') return
      e.preventDefault()
      if (e.shiftKey) {
        void ctx.kernel.executeCommand('terminal.new')
      } else {
        void ctx.kernel.executeCommand('terminal.toggle')
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    ctx.onDispose(() => window.removeEventListener('keydown', handleKeyDown, true))
  },
}

export default terminalPlugin
