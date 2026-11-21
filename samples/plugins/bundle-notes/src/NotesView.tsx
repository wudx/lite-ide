import type { ProjectScope } from '@lite-ide/kernel'
import { getI18n } from '@lite-ide/workbench'
import Trash from 'lucide-solid/icons/trash'
import { For, Show, createEffect, createSignal } from 'solid-js'
import { NotesStateKey } from './notes-state'

/**
 * Sidebar view demonstrating a Solid component contributed by an external
 * bundle plugin: consumes the plugin's own per-scope service, i18n and
 * host theme variables.
 */
export function NotesView(props: { scope: ProjectScope }) {
  const state = props.scope.get(NotesStateKey)
  const i18n = getI18n(props.scope)
  const [notes, setNotes] = createSignal<readonly string[]>(state.notes())
  const [draft, setDraft] = createSignal('')

  createEffect(() => state.subscribe(() => setNotes(state.notes())))

  function add(): void {
    const text = draft().trim()
    if (!text) return
    state.addNote(text)
    setDraft('')
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
        <input
          class="h-7 min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--ring-focus)]"
          placeholder={i18n.t('bundleNotes.view.placeholder')}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button
          type="button"
          class="flex h-7 shrink-0 items-center rounded-lg bg-[var(--accent)] px-2.5 text-xs font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          onClick={add}
        >
          {i18n.t('bundleNotes.view.add')}
        </button>
      </div>

      <Show
        when={notes().length > 0}
        fallback={
          <p class="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
            {i18n.t('bundleNotes.view.empty')}
          </p>
        }
      >
        <ul class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2.5">
          <For each={notes()}>
            {(note, index) => (
              <li class="group flex items-start gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-2.5 py-2">
                <span class="min-w-0 flex-1 break-words text-xs leading-normal text-[var(--text-primary)]">
                  {note}
                </span>
                <button
                  type="button"
                  class="rounded-md p-0.5 text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--danger-text)]"
                  title={i18n.t('bundleNotes.view.remove')}
                  onClick={() => state.removeNote(index())}
                >
                  <Trash class="h-3.5 w-3.5" />
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
