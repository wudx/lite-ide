import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import { createMemo, createSignal, ErrorBoundary, For, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { getI18n } from '../i18n'
import { PANEL_DEFAULT_HEIGHT, PanelStateKey } from '../services'

export interface PanelHostProps {
  kernel: AppKernel
  scope: ProjectScope
}

/**
 * Bottom panel area of one project: hosts `panel.view` contributions (e.g.
 * the terminal) below the editor card. Visibility/height/active tab live in
 * the kernel-level PanelState service; content is per project and stays
 * mounted (display:none) while the project is warm so running panels — a
 * live PTY, for instance — keep receiving output while hidden.
 */
export function PanelHost(props: PanelHostProps) {
  const panelState = props.kernel.get(PanelStateKey)
  const i18n = getI18n(props.kernel)
  const panelViews = props.kernel.contributions('panel.view')

  const sortedViews = createMemo(() =>
    [...panelViews()].sort((a, b) => a.order - b.order),
  )

  // Panels may come and go (plugin enable/disable); fall back to the first
  // view without writing back so unknown ids don't fight the toggling command.
  const currentView = createMemo(() => {
    const views = sortedViews()
    const id = panelState.activePanelId()
    return views.find((v) => v.id === id) ?? views[0]
  })

  const visible = createMemo(() => panelState.visible())
  const hasPanels = createMemo(() => sortedViews().length > 0)

  const [dragging, setDragging] = createSignal(false)

  let startY = 0
  let startHeight = PANEL_DEFAULT_HEIGHT

  function onPointerDown(e: PointerEvent) {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    startY = e.clientY
    startHeight = panelState.height()
    setDragging(true)
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return
    // Dragging upward grows the panel.
    const delta = startY - e.clientY
    panelState.setHeight(startHeight + delta)
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging()) return
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId)
    }
    setDragging(false)
  }

  return (
    <Show when={hasPanels()}>
      {/* Kept mounted while warm; hidden through display so a live terminal
          session keeps buffering output even when the panel is collapsed. */}
      <div
        class="shrink-0 min-h-0 flex flex-col"
        style={{ display: visible() ? 'flex' : 'none' }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          title={i18n.t('workspace.resizePanel')}
          class="h-[8px] shrink-0 cursor-row-resize flex items-center justify-center group/split select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDblClick={() => panelState.setHeight(PANEL_DEFAULT_HEIGHT)}
        >
          <span
            class={`w-8 h-[3px] rounded-full transition-all duration-150 ${
              dragging()
                ? 'bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]'
                : 'bg-transparent group-hover/split:bg-[var(--border-strong)]'
            }`}
          />
        </div>

        <aside
          data-testid="panel-area"
          class="flex-1 min-h-0 flex flex-col rounded-xl bg-[var(--bg-sidebar)] panel-card overflow-hidden"
        >
          <Show
            when={sortedViews().length > 1}
            fallback={
              <Show when={currentView()}>
                {(view) => (
                  <div
                    data-testid="panel-header"
                    class="h-[34px] shrink-0 px-3 flex items-center gap-2 border-b border-[var(--border-subtle)]"
                  >
                    <span class="text-[12px] font-semibold text-[var(--text-primary)] truncate leading-normal">
                      {i18n.resolveText(view().titleKey, view().title)}
                    </span>
                  </div>
                )}
              </Show>
            }
          >
            <div class="h-[34px] shrink-0 px-2 flex items-center border-b border-[var(--border-subtle)] overflow-x-auto no-scrollbar">
              <div class="flex items-center gap-0.5 bg-[var(--bg-inset)] p-0.5 rounded-lg border border-[var(--border-subtle)]">
                <For each={sortedViews()}>
                  {(view) => (
                    <button
                      type="button"
                      data-testid={`panel-tab-${view.id}`}
                      class={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-150 ${
                        currentView()?.id === view.id
                          ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-panel)] shadow-sm'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
                      }`}
                      onClick={() => panelState.setActivePanelId(view.id)}
                    >
                      {i18n.resolveText(view.titleKey, view.title)}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={currentView()}>
            {(view) => (
              <div class="flex-1 min-h-0 flex flex-col">
                <ErrorBoundary
                  fallback={(err) => (
                    <div class="m-3 p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs">
                      {i18n.t('workspace.panelError', {
                        message: err instanceof Error ? err.message : String(err),
                      })}
                    </div>
                  )}
                >
                  <Dynamic component={view().component} scope={props.scope} />
                </ErrorBoundary>
              </div>
            )}
          </Show>
        </aside>
      </div>
    </Show>
  )
}
