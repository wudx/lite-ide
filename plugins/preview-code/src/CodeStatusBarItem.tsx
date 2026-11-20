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
        <div class="flex items-center gap-3">
          <Show when={stats()}>
            {(s) => (
              <>
                <Show when={s().dirty}>
                  <span class="text-[var(--accent)] font-medium">Modified</span>
                </Show>
                <Show when={s().readOnly}>
                  <span class="text-amber-300 font-medium" title="Read-Only">
                    RO
                  </span>
                </Show>
                <span>
                  Ln {s().line}, Col {s().column}
                </span>
                <span>{s().lineCount} lines</span>
                <span>{s().language}</span>
              </>
            )}
          </Show>
          <span class="uppercase">{stats()?.encoding ?? file().encoding}</span>
          <span>{formatBytes(stats()?.size ?? file().size)}</span>
        </div>
      )}
    </Show>
  )
}
