import type { PreviewProps } from '@lite-ide/kernel'
import { WorkspaceBackendKey, getI18n } from '@lite-ide/workbench'
import { For, createEffect, createMemo, createSignal, Show } from 'solid-js'

/**
 * Standalone lazy chunk: a read-only line-numbered previewer for `.log`
 * files, evaluated on first use via `liteide.loadChunk('logView')`.
 * Keep imports disjoint from the entry so the CJS lib build emits no shared
 * chunk between the two entries.
 */
export default function LogPreview(props: PreviewProps) {
  const backend = props.scope.get(WorkspaceBackendKey)
  const i18n = getI18n(props.scope)
  const [lines, setLines] = createSignal<string[] | null>(null)
  const [failed, setFailed] = createSignal<string | null>(null)
  let readSeq = 0

  createEffect(() => {
    const relPath = props.file.relPath
    const seq = ++readSeq
    setLines(null)
    setFailed(null)
    backend
      .readText(props.scope.id, relPath)
      .then((res) => {
        if (seq !== readSeq) return
        setLines(res.content.split(/\r?\n/))
      })
      .catch((err) => {
        if (seq !== readSeq) return
        setFailed(err instanceof Error ? err.message : String(err))
      })
  })

  const numbered = createMemo(() => (lines() ?? []).map((line, i) => `${i + 1}  ${line}`))

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <Show when={failed()}>
        {(msg) => (
          <p class="mb-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-xs text-[var(--danger-text)]">
            {i18n.t('bundleNotes.log.failed', { message: msg() })}
          </p>
        )}
      </Show>
      <Show when={numbered()}>
        {(rows) => (
          <pre class="font-mono text-xs leading-normal text-[var(--text-primary)]">
            <For each={rows()}>{(line) => <div class="whitespace-pre">{line || ' '}</div>}</For>
          </pre>
        )}
      </Show>
    </div>
  )
}
