import type { ProjectScope } from '@lite-ide/kernel'
import { formatBytes, getI18n, ProjectSelectionKey } from '@lite-ide/workbench'
import { createMemo, Show } from 'solid-js'
import { CodeStatsKey } from './stats'

export function CodeStatusBarItem(props: { scope?: ProjectScope }) {
  const i18n = createMemo(() => getI18n(props.scope))
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
                    {i18n().t('previewCode.status.modified')}
                  </span>
                </Show>
                <Show when={s().readOnly}>
                  <span
                    class="px-1.5 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning-text)] text-[10px] font-medium leading-none"
                    title={i18n().t('previewCode.status.readOnly')}
                  >
                    {i18n().t('previewCode.status.ro')}
                  </span>
                </Show>
                <span>
                  {i18n().t('previewCode.status.cursor', { line: s().line, column: s().column })}
                </span>
                <span class="text-[var(--divider)]">·</span>
                <span>{i18n().t('previewCode.status.lines', { count: s().lineCount })}</span>
                <span class="text-[var(--divider)]">·</span>
                <span>
                  {s().language === 'Plain Text' ? i18n().t('previewCode.plainText') : s().language}
                </span>
                <span class="text-[var(--divider)]">·</span>
              </>
            )}
          </Show>
          <span class="uppercase">{stats()?.encoding ?? file().encoding}</span>
          <span class="text-[var(--divider)]">·</span>
          <span>{formatBytes(stats()?.size ?? file().size)}</span>
        </div>
      )}
    </Show>
  )
}
