import { createServiceKey } from '@lite-ide/kernel'
import { createSignal, type Accessor } from 'solid-js'

export interface ConfirmAction {
  id: string
  label: string
  variant?: 'primary' | 'danger' | 'secondary'
}

export interface ConfirmDialogRequest {
  title: string
  message: string
  details?: string[]
  actions: ConfirmAction[]
  cancelId?: string
}

export interface ActiveConfirmDialog {
  request: ConfirmDialogRequest
  resolve: (actionId: string) => void
}

export interface ConfirmDialogService {
  readonly current: Accessor<ActiveConfirmDialog | null>
  confirm(request: ConfirmDialogRequest): Promise<string>
  dismiss(actionId?: string): void
}

export const ConfirmDialogKey = createServiceKey<ConfirmDialogService>('workbench.confirmDialog')

export function createConfirmDialogService(): ConfirmDialogService {
  const [current, setCurrent] = createSignal<ActiveConfirmDialog | null>(null)
  const queue: ActiveConfirmDialog[] = []

  function showNext() {
    if (current() || queue.length === 0) return
    const next = queue.shift() ?? null
    setCurrent(next)
  }

  function resolveCurrent(actionId: string) {
    const active = current()
    if (!active) return
    setCurrent(null)
    active.resolve(actionId)
    showNext()
  }

  return {
    current,

    confirm(request: ConfirmDialogRequest): Promise<string> {
      return new Promise<string>((resolve) => {
        queue.push({ request, resolve })
        showNext()
      })
    },

    dismiss(actionId?: string) {
      const active = current()
      if (!active) return
      const fallbackId =
        actionId ??
        active.request.cancelId ??
        active.request.actions[active.request.actions.length - 1]?.id ??
        'cancel'
      resolveCurrent(fallbackId)
    },
  }
}
