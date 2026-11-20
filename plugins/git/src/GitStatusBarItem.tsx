import type { ProjectScope } from '@lite-ide/kernel'
import GitBranch from 'lucide-solid/icons/git-branch'
import { Show } from 'solid-js'
import { GitStoreKey } from './git-store'

export function GitStatusBarItem(props: { scope?: ProjectScope }) {
  const status = () => props.scope?.tryGet(GitStoreKey)?.status()

  return (
    <Show when={status()?.repo}>
      <div
        class="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] tabular-nums"
        data-testid="statusbar-git-branch"
      >
        <GitBranch class="w-3 h-3" />
        <span>{status()!.branch ?? 'HEAD (detached)'}</span>
        <Show when={status()!.ahead > 0 || status()!.behind > 0}>
          <span class="text-[var(--text-muted)]">
            <Show when={status()!.ahead > 0}>↑{status()!.ahead}</Show>
            <Show when={status()!.behind > 0}> ↓{status()!.behind}</Show>
          </span>
        </Show>
      </div>
    </Show>
  )
}
