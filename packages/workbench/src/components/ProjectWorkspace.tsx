import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import Folder from 'lucide-solid/icons/folder'
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { getI18n } from '../i18n'
import { LayoutStateKey } from '../services'
import { PreviewHost } from './PreviewHost'

export interface ProjectWorkspaceProps {
  kernel: AppKernel
  scope: ProjectScope
  active: boolean
}

export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const layout = props.kernel.get(LayoutStateKey)
  const i18n = getI18n(props.kernel)
  const sidebarViews = props.kernel.contributions('sidebar.view')

  const sortedViews = createMemo(() =>
    [...sidebarViews()].sort((a, b) => a.order - b.order),
  )

  const [activeViewId, setActiveViewId] = createSignal<string | null>(null)
  const [dragging, setDragging] = createSignal(false)

  createEffect(() => {
    const views = sortedViews()
    if (views.length === 0) {
      setActiveViewId(null)
      return
    }
    const current = activeViewId()
    if (!current || !views.some((v) => v.id === current)) {
      setActiveViewId(views[0].id)
    }
  })

  const currentView = createMemo(() => {
    const views = sortedViews()
    const id = activeViewId()
    return views.find((v) => v.id === id) ?? views[0]
  })

  let startX = 0
  let startWidth = 260

  function onPointerDown(e: PointerEvent) {
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    startX = e.clientX
    startWidth = layout.sidebarWidth()
    setDragging(true)
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return
    const delta = e.clientX - startX
    layout.setSidebarWidth(startWidth + delta)
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
    <section
      class="flex-1 min-h-0 min-w-0 flex"
      style={{ display: props.active ? 'flex' : 'none' }}
    >
      {/* Left sidebar floating card */}
      <Show when={layout.sidebarVisible() && sortedViews().length > 0}>
        <aside
          class="shrink-0 flex flex-col rounded-xl bg-[var(--bg-sidebar)] panel-card min-h-0 overflow-hidden"
          style={{ width: `${layout.sidebarWidth()}px` }}
        >
          <Show
            when={sortedViews().length > 1}
            fallback={
              <Show when={currentView()}>
                {(view) => (
                  <div class="h-[38px] shrink-0 px-3 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)]">
                    <div class="flex items-center gap-2 min-w-0">
                      <Folder class="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
                      <span class="text-[12px] font-semibold text-[var(--text-primary)] truncate leading-normal">
                        {props.scope.name}
                      </span>
                    </div>
                    <span class="shrink-0 px-1.5 py-0.5 rounded-md bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                      {i18n.resolveText(view().titleKey, view().title)}
                    </span>
                  </div>
                )}
              </Show>
            }
          >
            <div class="h-[38px] shrink-0 px-2 flex items-center border-b border-[var(--border-subtle)] overflow-x-auto no-scrollbar">
              <div class="flex items-center gap-0.5 bg-[var(--bg-inset)] p-0.5 rounded-lg border border-[var(--border-subtle)]">
                <For each={sortedViews()}>
                  {(view) => (
                    <button
                      type="button"
                      class={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-150 ${
                        currentView()?.id === view.id
                          ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-panel)] shadow-sm'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
                      }`}
                      onClick={() => setActiveViewId(view.id)}
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
                      {i18n.t('workspace.sidebarError', {
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

        {/* Breathing gap + subtle drag indicator */}
        <div
          role="separator"
          aria-orientation="vertical"
          title={i18n.t('workspace.resizeSidebar')}
          class="w-[8px] shrink-0 cursor-col-resize flex items-center justify-center group/split select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDblClick={() => layout.setSidebarWidth(260)}
        >
          <span
            class={`w-[3px] rounded-full transition-all duration-150 ${
              dragging()
                ? 'h-20 bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]'
                : 'h-8 bg-transparent group-hover/split:h-14 group-hover/split:bg-[var(--border-strong)]'
            }`}
          />
        </div>
      </Show>

      {/* Right preview / editor floating card */}
      <PreviewHost kernel={props.kernel} scope={props.scope} />
    </section>
  )
}
