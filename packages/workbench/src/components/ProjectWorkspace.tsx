import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { LayoutStateKey } from '../services'
import { PreviewHost } from './PreviewHost'

export interface ProjectWorkspaceProps {
  kernel: AppKernel
  scope: ProjectScope
  active: boolean
}

export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const layout = props.kernel.get(LayoutStateKey)
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
      {/* Left sidebar */}
      <Show when={layout.sidebarVisible() && sortedViews().length > 0}>
        <aside
          class="shrink-0 flex flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] min-h-0"
          style={{ width: `${layout.sidebarWidth()}px` }}
        >
          <Show
            when={sortedViews().length > 1}
            fallback={
              <Show when={currentView()}>
                {(view) => (
                  <div class="h-[34px] shrink-0 px-3 flex items-center justify-between border-b border-[var(--border-subtle)]">
                    <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                      {view().title}
                    </span>
                    <span class="text-[11px] text-[var(--text-muted)] truncate max-w-[120px]">
                      {props.scope.name}
                    </span>
                  </div>
                )}
              </Show>
            }
          >
            <div class="h-[34px] shrink-0 px-2 flex items-center gap-1 border-b border-[var(--border-subtle)] overflow-x-auto no-scrollbar">
              <For each={sortedViews()}>
                {(view) => (
                  <button
                    type="button"
                    class={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                      currentView()?.id === view.id
                        ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                    onClick={() => setActiveViewId(view.id)}
                  >
                    {view.title}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={currentView()}>
            {(view) => (
              <div class="flex-1 min-h-0 flex flex-col">
                <Dynamic component={view().component} scope={props.scope} />
              </div>
            )}
          </Show>
        </aside>

        {/* Draggable split handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize, double-click to reset"
          class={`w-[4px] -ml-[2px] z-10 shrink-0 cursor-col-resize transition-colors ${
            dragging() ? 'bg-[var(--accent)]' : 'hover:bg-[var(--accent)]/60'
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDblClick={() => layout.setSidebarWidth(260)}
        />
      </Show>

      {/* Right preview pane */}
      <PreviewHost kernel={props.kernel} scope={props.scope} />
    </section>
  )
}
