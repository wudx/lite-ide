import type { AppKernel } from '@lite-ide/kernel'
import { getI18n } from '@lite-ide/workbench'
import { createSignal, Show } from 'solid-js'
import { ExplorerExcludeStateKey } from './exclude-patterns'

export interface ExcludeSettingsProps {
  kernel: AppKernel
}

/**
 * 设置对话框「资源管理器」分区：编辑文件树排除模式（每行一个 glob）。
 * 输入即生效并持久化；文本框保留原始输入，避免清洗（trim/去重）打断光标。
 */
export function ExcludeSettings(props: ExcludeSettingsProps) {
  const service = props.kernel.tryGet(ExplorerExcludeStateKey)
  const i18n = getI18n(props.kernel)
  const [text, setText] = createSignal(service?.patterns().join('\n') ?? '')
  const ruleCount = () => service?.patterns().length ?? 0

  function handleInput(e: { currentTarget: HTMLTextAreaElement }) {
    const value = e.currentTarget.value
    setText(value)
    service?.setPatterns(value.split('\n'))
  }

  return (
    <div class="space-y-4">
      <section>
        <h3 class="text-xs font-semibold text-[var(--text-primary)] leading-normal">
          {i18n.t('explorer.exclude.heading')}
        </h3>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">
          {i18n.t('explorer.exclude.description')}
        </p>
        <textarea
          aria-label={i18n.t('explorer.exclude.ariaLabel')}
          rows={7}
          spellcheck={false}
          value={text()}
          onInput={handleInput}
          placeholder={'*.meta\nnode_modules\nbuild/'}
          class="mt-3 w-full resize-y rounded-lg border border-[var(--border-panel)] bg-[var(--bg-inset)] px-2.5 py-2 font-mono text-xs text-[var(--text-primary)] leading-relaxed outline-none transition-all placeholder:text-[var(--text-muted)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] focus:shadow-[0_0_0_2px_var(--accent-soft)]"
        />
        <p class="text-[10.5px] text-[var(--text-muted)] mt-2 leading-relaxed">
          {i18n.t('explorer.exclude.syntaxLead')}
          <span class="font-mono">*.meta</span> {i18n.t('explorer.exclude.syntaxName')}
          <span class="font-mono">src/*.tmp</span> {i18n.t('explorer.exclude.syntaxPath')}
          <span class="font-mono">build/</span> {i18n.t('explorer.exclude.syntaxDir')}
          <span class="font-mono">/build</span> {i18n.t('explorer.exclude.syntaxRoot')}{' '}
          <span class="font-mono">**</span> / <span class="font-mono">*</span> /{' '}
          <span class="font-mono">?</span> {i18n.t('explorer.exclude.syntaxWildcards')}
        </p>
        <Show when={ruleCount() > 0}>
          <p class="text-[10.5px] text-[var(--accent)] mt-1.5 leading-normal">
            {ruleCount() === 1
              ? i18n.t('explorer.exclude.activeCountOne')
              : i18n.t('explorer.exclude.activeCountMany', { count: ruleCount() })}
          </p>
        </Show>
      </section>
    </div>
  )
}
