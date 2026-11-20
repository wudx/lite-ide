import type { AppKernel } from '@lite-ide/kernel'
import Check from 'lucide-solid/icons/check'
import Globe from 'lucide-solid/icons/globe'
import { createMemo, For, Show, type JSX } from 'solid-js'
import { getI18n, SYSTEM_LOCALE_ID } from '../i18n'

export interface GeneralSettingsProps {
  kernel: AppKernel
}

interface LocaleOptionCardProps {
  active: boolean
  badge: JSX.Element
  title: string
  subtitle: string
  subtitleMono?: boolean
  onSelect: () => void
}

function LocaleOptionCard(props: LocaleOptionCardProps) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      class={`w-full rounded-xl border px-3 py-2.5 text-left flex items-center justify-between gap-3 transition-all duration-150 active:scale-[0.99] ${
        props.active
          ? 'border-[var(--accent-border)] bg-[var(--accent-soft)]'
          : 'border-[var(--border-panel)] bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
      }`}
      onClick={() => props.onSelect()}
    >
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-7 h-7 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
          {props.badge}
        </div>
        <div class="min-w-0">
          <div
            class={`text-xs truncate leading-normal ${
              props.active
                ? 'text-[var(--text-primary)] font-medium'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            {props.title}
          </div>
          <div
            class={`text-[10.5px] text-[var(--text-muted)] truncate leading-normal ${
              props.subtitleMono ? 'font-mono' : ''
            }`}
          >
            {props.subtitle}
          </div>
        </div>
      </div>
      <Show when={props.active}>
        <Check class="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
      </Show>
    </button>
  )
}

export function GeneralSettings(props: GeneralSettingsProps) {
  const i18n = getI18n(props.kernel)

  const systemLabel = createMemo(() => {
    const sysId = i18n.systemLocale()
    return i18n.locales().find((l) => l.id === sysId)?.label ?? sysId
  })

  return (
    <div class="space-y-4">
      <section>
        <h3 class="text-xs font-semibold text-[var(--text-primary)] leading-normal">
          {i18n.t('settings.language.heading')}
        </h3>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 mb-3 leading-relaxed">
          {i18n.t('settings.language.description')}
        </p>

        <div class="space-y-2">
          <LocaleOptionCard
            active={i18n.preference() === SYSTEM_LOCALE_ID}
            badge={<Globe class="w-3.5 h-3.5 text-[var(--accent)]" />}
            title={i18n.t('settings.language.system')}
            subtitle={i18n.t('settings.language.systemCurrent', { label: systemLabel() })}
            onSelect={() => i18n.setLocale(SYSTEM_LOCALE_ID)}
          />

          <For each={i18n.locales()}>
            {(loc) => (
              <LocaleOptionCard
                active={i18n.preference() === loc.id}
                badge={
                  <span class="font-mono text-[10px] font-medium text-[var(--text-secondary)]">
                    {loc.id.split('-')[0].toUpperCase()}
                  </span>
                }
                title={loc.label}
                subtitle={loc.id}
                subtitleMono
                onSelect={() => i18n.setLocale(loc.id)}
              />
            )}
          </For>
        </div>
      </section>
    </div>
  )
}
