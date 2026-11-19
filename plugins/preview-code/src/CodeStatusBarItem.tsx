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
                <span>{s().language}</span>
                <span>{s().lineCount} lines</span>
              </>
            )}
          </Show>
          <span class="uppercase">{file().encoding}</span>
          <span>{formatBytes(file().size)}</span>
        </div>
      )}
    </Show>
  )
}
