import { createServiceKey, type AppKernel, type ContributionMap } from '@lite-ide/kernel'
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'
import { WORKBENCH_EN_US, WORKBENCH_ZH_CN } from './i18n-messages'

export type LocaleId = string
export type LocalePreference = 'system' | LocaleId

export interface LocaleDefinition {
  id: LocaleId
  /** Native display name of the language (e.g. '简体中文', 'English'). */
  label: string
}

export type I18nContribution = ContributionMap['i18n']
export type TranslateFn = (
  key: string,
  params?: Record<string, string | number>,
  fallback?: string,
) => string

export const LOCALE_STORAGE_KEY = 'lite-ide.locale.v1'
export const SYSTEM_LOCALE_ID = 'system'
export const DEFAULT_LOCALE_ID: LocaleId = 'en-US'

export const BUILTIN_LOCALES: readonly LocaleDefinition[] = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en-US', label: 'English' },
]

const BUILTIN_MESSAGES: Record<string, Record<string, string>> = {
  'zh-CN': WORKBENCH_ZH_CN,
  'en-US': WORKBENCH_EN_US,
}

const LOCALE_ID_PATTERN = /^[\w-]+$/

export interface I18nService {
  /** All available concrete locales (built-in + plugin-contributed). */
  readonly locales: Accessor<readonly LocaleDefinition[]>
  /** User preference ('system' or a concrete locale id). */
  readonly preference: Accessor<LocalePreference>
  /** Currently detected system locale resolved to an available locale id. */
  readonly systemLocale: Accessor<LocaleId>
  /** Active resolved concrete locale id used for rendering. */
  readonly locale: Accessor<LocaleId>
  setLocale(preference: LocalePreference): void
  t: TranslateFn
  /** Resolve an optional i18n key from a contribution item, falling back to its static label. */
  resolveText(key: string | undefined, fallback: string): string
  dispose(): void
}

export const I18nStateKey = createServiceKey<I18nService>('workbench.i18nState')

export function resolveSystemLocale(
  availableIds: readonly string[],
  navigatorLang?: string,
): LocaleId {
  const raw =
    navigatorLang ??
    (typeof navigator !== 'undefined' ? navigator.language || navigator.languages?.[0] || '' : '')
  const normalized = raw.trim().toLowerCase().replace(/_/g, '-')
  if (!normalized) return availableIds.includes(DEFAULT_LOCALE_ID) ? DEFAULT_LOCALE_ID : (availableIds[0] ?? DEFAULT_LOCALE_ID)

  const exact = availableIds.find((id) => id.toLowerCase() === normalized)
  if (exact) return exact

  const primary = normalized.split('-')[0]
  if (primary) {
    const byPrefix = availableIds.find(
      (id) => id.toLowerCase() === primary || id.toLowerCase().startsWith(`${primary}-`),
    )
    if (byPrefix) return byPrefix
  }

  return availableIds.includes(DEFAULT_LOCALE_ID)
    ? DEFAULT_LOCALE_ID
    : (availableIds[0] ?? DEFAULT_LOCALE_ID)
}

function readStoredPreference(): LocalePreference {
  if (typeof localStorage === 'undefined') return SYSTEM_LOCALE_ID
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (!stored) return SYSTEM_LOCALE_ID
    return LOCALE_ID_PATTERN.test(stored) ? stored : SYSTEM_LOCALE_ID
  } catch {
    return SYSTEM_LOCALE_ID
  }
}

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const val = params[name]
    return val === undefined ? match : String(val)
  })
}

function applyLocaleToDom(localeId: LocaleId) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = localeId
}

export function createI18nState(kernel?: Pick<AppKernel, 'contributions'>): I18nService {
  const contributed = () => kernel?.contributions('i18n')() ?? []

  const locales = createMemo<readonly LocaleDefinition[]>(() => {
    const map = new Map<string, LocaleDefinition>()
    for (const def of BUILTIN_LOCALES) {
      map.set(def.id, def)
    }
    for (const item of contributed()) {
      if (
        !item.label ||
        item.locale === SYSTEM_LOCALE_ID ||
        !LOCALE_ID_PATTERN.test(item.locale)
      ) {
        continue
      }
      const existing = map.get(item.locale)
      if (!existing) {
        map.set(item.locale, { id: item.locale, label: item.label })
      }
    }
    return [...map.values()]
  })

  const [preference, setPreferenceSignal] = createSignal<LocalePreference>(readStoredPreference())
  const [navLang, setNavLang] = createSignal<string | undefined>(undefined)

  const systemLocale = createMemo<LocaleId>(() =>
    resolveSystemLocale(
      locales().map((l) => l.id),
      navLang(),
    ),
  )

  const locale = createMemo<LocaleId>(() => {
    const pref = preference()
    if (pref === SYSTEM_LOCALE_ID) {
      return systemLocale()
    }
    const available = locales()
    if (available.some((l) => l.id === pref)) {
      return pref
    }
    return systemLocale()
  })

  const activeMessages = createMemo<Record<string, string>>(() => {
    const current = locale()
    const merged: Record<string, string> = { ...(BUILTIN_MESSAGES[current] ?? {}) }
    for (const item of contributed()) {
      if (item.locale !== SYSTEM_LOCALE_ID && item.locale === current) {
        Object.assign(merged, item.messages)
      }
    }
    return merged
  })

  const fallbackMessages = createMemo<Record<string, string>>(() => {
    const merged: Record<string, string> = { ...WORKBENCH_EN_US }
    for (const item of contributed()) {
      if (item.locale === DEFAULT_LOCALE_ID) {
        Object.assign(merged, item.messages)
      }
    }
    return merged
  })

  function setLocale(nextPref: LocalePreference) {
    const normalized =
      nextPref && LOCALE_ID_PATTERN.test(nextPref) ? nextPref : SYSTEM_LOCALE_ID
    setPreferenceSignal(normalized)
    applyLocaleToDom(locale())
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, normalized)
      } catch {
        // Ignore storage quota / privacy errors.
      }
    }
  }

  let disposeRoot: (() => void) | undefined
  createRoot((dispose) => {
    disposeRoot = dispose
    createEffect(() => {
      applyLocaleToDom(locale())
    })
    if (typeof window !== 'undefined') {
      const onLanguageChange = () => {
        setNavLang(
          typeof navigator !== 'undefined'
            ? navigator.language || navigator.languages?.[0] || ''
            : '',
        )
      }
      window.addEventListener('languagechange', onLanguageChange)
      onCleanup(() => {
        window.removeEventListener('languagechange', onLanguageChange)
      })
    }
  })

  return {
    locales,
    preference,
    systemLocale,
    locale,
    setLocale,
    t(key, params, fallback) {
      const dict = activeMessages()
      const template = dict[key] ?? fallbackMessages()[key] ?? fallback ?? key
      return interpolate(template, params)
    },
    resolveText(key, fallback) {
      if (!key) return fallback
      const dict = activeMessages()
      return dict[key] ?? fallbackMessages()[key] ?? fallback
    },
    dispose() {
      disposeRoot?.()
      disposeRoot = undefined
    },
  }
}

const fallbackStaticI18n: I18nService = {
  locales: () => BUILTIN_LOCALES,
  preference: () => DEFAULT_LOCALE_ID,
  systemLocale: () => DEFAULT_LOCALE_ID,
  locale: () => DEFAULT_LOCALE_ID,
  setLocale: () => {},
  t(key, params, fallback) {
    const template = WORKBENCH_EN_US[key] ?? fallback ?? key
    return interpolate(template, params)
  },
  resolveText(key, fallback) {
    if (!key) return fallback
    return WORKBENCH_EN_US[key] ?? fallback
  },
  dispose: () => {},
}

export function getI18n(source?: Pick<AppKernel, 'tryGet'>): I18nService {
  return source?.tryGet(I18nStateKey) ?? fallbackStaticI18n
}
