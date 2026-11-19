import type { AppKernel } from '@lite-ide/kernel'
import { createMemo, For } from 'solid-js'
import { Dynamic } from 'solid-js/web'

export interface StatusBarProps {
  kernel: AppKernel
}

export function StatusBar(props: StatusBarProps) {
  const items = props.kernel.contributions('statusbar.item')

  const leftItems = createMemo(() =>
    items()
      .filter((i) => i.align === 'left')
      .sort((a, b) => a.order - b.order),
  )

  const rightItems = createMemo(() =>
    items()
      .filter((i) => i.align === 'right')
      .sort((a, b) => a.order - b.order),
  )

  return (
    <footer class="h-[24px] shrink-0 px-3 flex items-center justify-between bg-[var(--bg-titlebar)] border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] select-none">
      <div class="flex items-center gap-3 min-w-0">
        <span class="text-[var(--text-muted)]">
          Projects: {props.kernel.projects().length}
        </span>
        <For each={leftItems()}>
          {(item) => (
            <Dynamic component={item.component} scope={props.kernel.activeProject()} />
          )}
        </For>
      </div>

      <div class="flex items-center gap-3 min-w-0">
        <For each={rightItems()}>
          {(item) => (
            <Dynamic component={item.component} scope={props.kernel.activeProject()} />
          )}
        </For>
      </div>
    </footer>
  )
}
