import type { ProjectScope } from '@lite-ide/kernel'
import { getI18n, PanelStateKey } from '@lite-ide/workbench'
import TerminalIcon from 'lucide-solid/icons/terminal'
import { createMemo, Show } from 'solid-js'
import { TERMINAL_PANEL_ID, TerminalStoreKey, toggleTerminalPanel } from './terminal-store'

/** Status bar toggle for the bottom terminal panel (per active project). */
export function TerminalStatusBarItem(props: { scope?: ProjectScope }) {
  const i18n = createMemo(() => getI18n(props.scope))
  const panelState = () => props.scope?.tryGet(PanelStateKey)
  const manager = () => props.scope?.tryGet(TerminalStoreKey)
  const tabCount = () => manager()?.tabs().length ?? 0
  const active = () => {
    const state = panelState()
    return Boolean(state?.visible() && state?.activePanelId() === TERMINAL_PANEL_ID)
  }

  return (
    <Show when={panelState()}>
      {(state) => (
        <button
          type="button"
          data-testid="statusbar-terminal"
          title={i18n().t('terminal.statusbar.toggle')}
          aria-pressed={active()}
          class={`flex items-center gap-1 p-1 rounded-md transition-colors duration-150 ${
            active()
              ? 'text-[var(--accent)] bg-[var(--bg-hover)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
          onClick={() => toggleTerminalPanel(state(), TERMINAL_PANEL_ID, manager())}
        >
          <TerminalIcon class="w-3.5 h-3.5" />
          <Show when={tabCount() > 1}>
            <span
              data-testid="statusbar-terminal-count"
              class="text-[10px] font-medium leading-none tabular-nums"
            >
              {tabCount()}
            </span>
          </Show>
        </button>
      )}
    </Show>
  )
}
