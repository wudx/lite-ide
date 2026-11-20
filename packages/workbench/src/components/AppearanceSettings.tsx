import type { AppKernel } from '@lite-ide/kernel'
import Check from 'lucide-solid/icons/check'
import { For, Show } from 'solid-js'
import { THEME_DEFINITIONS, ThemeStateKey, type ThemeMode } from '../services'

export interface AppearanceSettingsProps {
  kernel: AppKernel
}

/**
 * Miniature palette preview per theme. Mirrors the headline values in
 * apps/desktop/src/styles/app.css (kept small and static on purpose — the
 * actual rendering always comes from the CSS variables).
 */
const THEME_SWATCHES: Record<ThemeMode, { app: string; editor: string; accent: string; text: string }> = {
  dark: { app: '#12141a', editor: '#16181f', accent: '#7aa2ff', text: '#eceef2' },
  light: { app: '#eaedf2', editor: '#ffffff', accent: '#3b6ff6', text: '#181c25' },
  'solarized-light': { app: '#ede7d6', editor: '#fdf6e3', accent: '#268bd2', text: '#073642' },
}

export function AppearanceSettings(props: AppearanceSettingsProps) {
  const themeState = props.kernel.tryGet(ThemeStateKey)

  return (
    <div class="space-y-4">
      <section>
        <h3 class="text-xs font-semibold text-[var(--text-primary)] leading-normal">颜色主题</h3>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 mb-3 leading-relaxed">
          选择工作台的配色方案，更改立即生效并自动保存。
        </p>
        <div class="grid grid-cols-3 gap-2.5">
          <For each={THEME_DEFINITIONS}>
            {(theme) => {
              const swatch = THEME_SWATCHES[theme.id]
              const isActive = () => themeState?.theme() === theme.id
              return (
                <button
                  type="button"
                  class={`relative rounded-xl border p-2.5 text-left transition-all duration-150 active:scale-[0.98] ${
                    isActive()
                      ? 'border-[var(--accent-border)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-panel)] bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
                  }`}
                  onClick={() => themeState?.setTheme(theme.id)}
                >
                  <div class="h-11 rounded-lg border border-[var(--border-subtle)] overflow-hidden flex mb-2 pointer-events-none">
                    <div class="w-1/3 h-full" style={{ background: swatch.app }} />
                    <div class="flex-1 h-full p-1.5 flex flex-col justify-center gap-1" style={{ background: swatch.editor }}>
                      <span class="block h-1.5 w-3/4 rounded-full" style={{ background: swatch.text, opacity: 0.85 }} />
                      <span class="block h-1.5 w-1/2 rounded-full" style={{ background: swatch.accent, opacity: 0.9 }} />
                      <span class="block h-1.5 w-2/3 rounded-full" style={{ background: swatch.text, opacity: 0.35 }} />
                    </div>
                  </div>
                  <div class="flex items-center justify-between gap-1">
                    <span
                      class={`text-xs truncate leading-normal ${
                        isActive() ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      {theme.label}
                    </span>
                    <Show when={isActive()}>
                      <Check class="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                    </Show>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </section>
    </div>
  )
}
