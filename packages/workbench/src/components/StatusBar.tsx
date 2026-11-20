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
    <footer class="h-[26px] shrink-0 px-3.5 flex items-center justify-between bg-transparent text-[11px] text-[var(--text-muted)] tabular-nums select-none">
      <div class="flex items-center gap-3 min-w-0">
        <span class="flex items-center gap-1.5 text-[var(--text-secondary)]">
          <span class="w-1.5 h-1.5 rounded-full bg-[var(--success-text)]" />
          <span>Projects: {props.kernel.projects().length}</span>
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
