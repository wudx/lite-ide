import type { AppKernel } from '@lite-ide/kernel'
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
          排除的文件与目录
        </h3>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 leading-relaxed">
          资源管理器将隐藏匹配以下模式的条目，每行一个；更改立即生效并自动保存。
        </p>
        <textarea
          aria-label="排除模式"
          rows={7}
          spellcheck={false}
          value={text()}
          onInput={handleInput}
          placeholder={'*.meta\nnode_modules\nbuild/'}
          class="mt-3 w-full resize-y rounded-lg border border-[var(--border-panel)] bg-[var(--bg-inset)] px-2.5 py-2 font-mono text-xs text-[var(--text-primary)] leading-relaxed outline-none transition-all placeholder:text-[var(--text-muted)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] focus:shadow-[0_0_0_2px_var(--accent-soft)]"
        />
        <p class="text-[10.5px] text-[var(--text-muted)] mt-2 leading-relaxed">
          语法：<span class="font-mono">*.meta</span> 按文件名匹配任意层级；{' '}
          <span class="font-mono">src/*.tmp</span> 按相对路径匹配；{' '}
          <span class="font-mono">build/</span> 仅匹配目录；{' '}
          <span class="font-mono">/build</span> 仅匹配根目录；支持{' '}
          <span class="font-mono">**</span>、<span class="font-mono">*</span>、
          <span class="font-mono">?</span> 通配符。
        </p>
        <Show when={ruleCount() > 0}>
          <p class="text-[10.5px] text-[var(--accent)] mt-1.5 leading-normal">
            已启用 {ruleCount()} 条排除规则
          </p>
        </Show>
      </section>
    </div>
  )
}
