import type { AppKernel } from '@lite-ide/kernel'
import AlertTriangle from 'lucide-solid/icons/triangle-exclamation-point'
import X from 'lucide-solid/icons/x'
import { createEffect, For, onCleanup, Show } from 'solid-js'
import { ConfirmDialogKey, type ConfirmAction } from '../dialogs'
import { getI18n } from '../i18n'

export interface ConfirmDialogProps {
  kernel: AppKernel
}

function buttonClasses(variant: ConfirmAction['variant']): string {
  switch (variant) {
    case 'primary':
      return 'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-foreground)] font-semibold shadow-[0_2px_10px_var(--accent-glow)]'
    case 'danger':
      return 'bg-red-500/90 hover:bg-red-500 text-white font-semibold shadow-[0_2px_10px_rgba(239,68,68,0.25)]'
    default:
      return 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
  }
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const service = props.kernel.tryGet(ConfirmDialogKey)
  const i18n = getI18n(props.kernel)
  let primaryButtonEl: HTMLButtonElement | undefined

  createEffect(() => {
    const active = service?.current()
    if (!active) return

    requestAnimationFrame(() => {
      primaryButtonEl?.focus()
    })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        service?.dismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDown, true)
    })
  })

  return (
    <Show when={service?.current()}>
      {(active) => {
        const req = () => active().request
        const preferredIndex = () => {
          const idx = req().actions.findIndex(
            (a) => a.variant === 'primary' || a.variant === 'danger',
          )
          return idx >= 0 ? idx : 0
        }

        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="lite-ide-confirm-title"
            class="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-backdrop)] backdrop-blur-sm p-4 animate-backdrop-in"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                service?.dismiss()
              }
            }}
          >
            <div class="w-full max-w-[430px] rounded-2xl glass-surface overflow-hidden animate-dialog-in">
              <div class="px-5 py-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="w-7 h-7 rounded-lg bg-[var(--warning-bg)] border border-[var(--warning-border)] flex items-center justify-center shrink-0">
                    <AlertTriangle class="w-3.5 h-3.5 text-[var(--warning-icon)]" />
                  </div>
                  <h2
                    id="lite-ide-confirm-title"
                    class="text-[13.5px] font-semibold text-[var(--text-primary)] truncate leading-normal"
                  >
                    {req().title}
                  </h2>
                </div>
                <button
                  type="button"
                  title={i18n.t('common.cancel')}
                  class="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  onClick={() => service?.dismiss()}
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>

              <div class="px-5 py-4 space-y-3 text-xs text-[var(--text-secondary)] leading-relaxed">
                <p>{req().message}</p>

                <Show when={req().details && req().details!.length > 0}>
                  <ul class="max-h-32 overflow-y-auto rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] px-3 py-2.5 space-y-1 font-mono text-[11px] text-[var(--text-primary)]">
                    <For each={req().details}>
                      {(line) => <li class="truncate leading-normal">{line}</li>}
                    </For>
                  </ul>
                </Show>
              </div>

              <div class="px-5 py-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-dialog-footer)] flex items-center justify-end gap-2">
                <For each={req().actions}>
                  {(action, idx) => (
                    <button
                      ref={(el) => {
                        if (idx() === preferredIndex()) {
                          primaryButtonEl = el
                        }
                      }}
                      type="button"
                      class={`px-3.5 py-1.5 rounded-lg text-xs transition-all duration-150 active:scale-[0.98] ${buttonClasses(action.variant)}`}
                      onClick={() => service?.dismiss(action.id)}
                    >
                      {action.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </div>
        )
      }}
    </Show>
  )
}
