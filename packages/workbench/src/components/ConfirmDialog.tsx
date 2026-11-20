import type { AppKernel } from '@lite-ide/kernel'
import AlertTriangle from 'lucide-solid/icons/triangle-exclamation-point'
import X from 'lucide-solid/icons/x'
import { createEffect, For, onCleanup, Show } from 'solid-js'
import { ConfirmDialogKey, type ConfirmAction } from '../dialogs'

export interface ConfirmDialogProps {
  kernel: AppKernel
}

function buttonClasses(variant: ConfirmAction['variant']): string {
  switch (variant) {
    case 'primary':
      return 'bg-[var(--accent)] text-slate-950 font-medium hover:brightness-110'
    case 'danger':
      return 'bg-red-500/90 text-white font-medium hover:bg-red-500'
    default:
      return 'bg-[var(--bg-app)] text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
  }
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const service = props.kernel.tryGet(ConfirmDialogKey)
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
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                service?.dismiss()
              }
            }}
          >
            <div class="w-full max-w-[440px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-2xl overflow-hidden">
              <div class="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 min-w-0">
                  <AlertTriangle class="w-4 h-4 shrink-0 text-amber-400" />
                  <h2
                    id="lite-ide-confirm-title"
                    class="text-sm font-semibold text-[var(--text-primary)] truncate leading-normal"
                  >
                    {req().title}
                  </h2>
                </div>
                <button
                  type="button"
                  title="Cancel"
                  class="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  onClick={() => service?.dismiss()}
                >
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>

              <div class="px-4 py-3.5 space-y-2.5 text-xs text-[var(--text-secondary)] leading-relaxed">
                <p>{req().message}</p>

                <Show when={req().details && req().details!.length > 0}>
                  <ul class="max-h-32 overflow-y-auto rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] px-2.5 py-2 space-y-1 font-mono text-[11px] text-[var(--text-primary)]">
                    <For each={req().details}>
                      {(line) => <li class="truncate leading-normal">{line}</li>}
                    </For>
                  </ul>
                </Show>
              </div>

              <div class="px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-titlebar)]/60 flex items-center justify-end gap-2">
                <For each={req().actions}>
                  {(action, idx) => (
                    <button
                      ref={(el) => {
                        if (idx() === preferredIndex()) {
                          primaryButtonEl = el
                        }
                      }}
                      type="button"
                      class={`px-3 py-1.5 rounded text-xs transition-colors ${buttonClasses(action.variant)}`}
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
