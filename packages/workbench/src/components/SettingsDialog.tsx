import type { AppKernel } from '@lite-ide/kernel'
import X from 'lucide-solid/icons/x'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { SettingsDialogKey } from '../dialogs'
import { getI18n } from '../i18n'

export interface SettingsDialogProps {
  kernel: AppKernel
}

export function SettingsDialog(props: SettingsDialogProps) {
  const service = props.kernel.tryGet(SettingsDialogKey)
  const i18n = getI18n(props.kernel)
  const [activeId, setActiveId] = createSignal<string | null>(null)

  const sections = createMemo(() =>
    [...props.kernel.contributions('settings.section')()].sort((a, b) => a.order - b.order),
  )
  const activeSection = createMemo(
    () => sections().find((s) => s.id === activeId()) ?? sections()[0],
  )

  // Keep the selected section valid as contributions appear/disappear.
  createEffect(() => {
    if (!service?.isOpen()) return
    const current = activeId()
    if (!current || !sections().some((s) => s.id === current)) {
      setActiveId(sections()[0]?.id ?? null)
    }
  })

  createEffect(() => {
    if (!service?.isOpen()) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        service?.close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown, true)
    })
  })

  return (
    <Show when={service?.isOpen()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lite-ide-settings-title"
        class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-backdrop)] backdrop-blur-sm p-4 animate-backdrop-in"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            service?.close()
          }
        }}
      >
        <div class="w-full max-w-2xl h-[460px] flex rounded-2xl glass-surface overflow-hidden animate-dialog-in">
          {/* Left navigation: contributed sections */}
          <aside class="w-44 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-dialog-footer)] flex flex-col">
            <div class="px-4 py-3.5 border-b border-[var(--border-subtle)]">
              <h2
                id="lite-ide-settings-title"
                class="text-[13.5px] font-semibold text-[var(--text-primary)] leading-normal"
              >
                {i18n.t('settings.title')}
              </h2>
            </div>
            <nav class="flex-1 overflow-y-auto p-2 space-y-0.5">
              <For each={sections()}>
                {(section) => (
                  <button
                    type="button"
                    class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors leading-normal ${
                      activeSection()?.id === section.id
                        ? 'bg-[var(--bg-active)] text-[var(--text-primary)] font-medium'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                    }`}
                    onClick={() => setActiveId(section.id)}
                  >
                    {i18n.resolveText(section.titleKey, section.title)}
                  </button>
                )}
              </For>
            </nav>
          </aside>

          {/* Right content: active section */}
          <div class="flex-1 min-w-0 flex flex-col">
            <div class="px-4 py-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
              <span class="text-[13px] font-semibold text-[var(--text-primary)] truncate leading-normal">
                {activeSection()
                  ? i18n.resolveText(activeSection()!.titleKey, activeSection()!.title)
                  : ''}
              </span>
              <button
                type="button"
                title={i18n.t('common.close')}
                class="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                onClick={() => service?.close()}
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
            <div class="flex-1 overflow-y-auto p-4">
              <Show when={activeSection()}>
                {(section) => <Dynamic component={section().component} kernel={props.kernel} />}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
