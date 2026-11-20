import type { ProjectScope } from '@lite-ide/kernel'
import { formatBytes, ProjectSelectionKey } from '@lite-ide/workbench'
import { Show } from 'solid-js'
import { CodeStatsKey } from './stats'

export function CodeStatusBarItem(props: { scope?: ProjectScope }) {
  const stats = () => props.scope?.tryGet(CodeStatsKey)?.stats() ?? null
  const meta = () => props.scope?.tryGet(ProjectSelectionKey)?.fileMeta() ?? null

  return (
    <Show when={meta()}>
      {(file) => (
        <div class="flex items-center gap-2.5 text-[11px] text-[var(--text-secondary)] tabular-nums">
          <Show when={stats()}>
            {(s) => (
              <>
                <Show when={s().dirty}>
                  <span class="px-1.5 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] text-[10px] font-medium leading-none">
                    Modified
                  </span>
                </Show>
                <Show when={s().readOnly}>
                  <span
                    class="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 text-[10px] font-medium leading-none"
                    title="Read-Only"
                  >
                    RO
                  </span>
                </Show>
                <span>
                  Ln {s().line}, Col {s().column}
                </span>
                <span class="text-white/15">·</span>
                <span>{s().lineCount} lines</span>
                <span class="text-white/15">·</span>
                <span>{s().language}</span>
                <span class="text-white/15">·</span>
              </>
            )}
          </Show>
          <span class="uppercase">{stats()?.encoding ?? file().encoding}</span>
          <span class="text-white/15">·</span>
          <span>{formatBytes(stats()?.size ?? file().size)}</span>
        </div>
      )}
    </Show>
  )
}
