import type { AppKernel } from '@lite-ide/kernel'
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '@lite-ide/protocol'
import {
  BUILTIN_LOCALES,
  createI18nState,
  LOCALE_STORAGE_KEY,
  resolveSystemLocale,
  SYSTEM_LOCALE_ID,
  type I18nContribution,
} from '../src/i18n'
import { WORKBENCH_EN_US, WORKBENCH_ZH_CN } from '../src/i18n-messages'
import { createWorkbenchKernel } from '../src/services'
import { explorerPlugin } from '../../../plugins/explorer/src/index'
import { gitPlugin } from '../../../plugins/git/src/index'
import { previewAudioPlugin } from '../../../plugins/preview-audio/src/index'
import { previewCodePlugin } from '../../../plugins/preview-code/src/index'
import { previewFallbackPlugin } from '../../../plugins/preview-fallback/src/index'
import { previewImagePlugin } from '../../../plugins/preview-image/src/index'
import { previewMarkdownPlugin } from '../../../plugins/preview-markdown/src/index'
import { searchPlugin } from '../../../plugins/search/src/index'
import { themeNordPlugin } from '../../../plugins/theme-nord/src/index'

function createFakeI18nHost() {
  const [contributions, setContributions] = createSignal<readonly I18nContribution[]>([])
  return {
    host: { contributions: () => contributions } as Pick<AppKernel, 'contributions'>,
    register(item: I18nContribution) {
      setContributions((prev) => [...prev, item])
    },
    unregister(locale: string) {
      setContributions((prev) => prev.filter((item) => item.locale !== locale))
    },
  }
}

function flushEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('resolveSystemLocale', () => {
  const ids = BUILTIN_LOCALES.map((l) => l.id)

  it('matches exact and primary-subtag system languages and falls back to en-US', () => {
    expect(resolveSystemLocale(ids, 'zh-CN')).toBe('zh-CN')
    expect(resolveSystemLocale(ids, 'zh-TW')).toBe('zh-CN')
    expect(resolveSystemLocale(ids, 'zh')).toBe('zh-CN')
    expect(resolveSystemLocale(ids, 'en-GB')).toBe('en-US')
    expect(resolveSystemLocale(ids, 'en')).toBe('en-US')
    expect(resolveSystemLocale(ids, 'fr-FR')).toBe('en-US')
    expect(resolveSystemLocale(ids, '')).toBe('en-US')
  })
})

describe('createI18nState', () => {
  const originalLangDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language')

  function mockNavigatorLanguage(lang: string) {
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      get: () => lang,
    })
  }

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('lang')
  })

  afterEach(() => {
    if (originalLangDesc) {
      Object.defineProperty(Navigator.prototype, 'language', originalLangDesc)
    }
  })

  it('defaults to system preference, detects navigator.language, and syncs <html lang>', () => {
    mockNavigatorLanguage('zh-CN')
    const state = createI18nState()
    try {
      expect(state.preference()).toBe(SYSTEM_LOCALE_ID)
      expect(state.systemLocale()).toBe('zh-CN')
      expect(state.locale()).toBe('zh-CN')
      expect(document.documentElement.lang).toBe('zh-CN')
      expect(state.t('settings.title')).toBe('设置')
    } finally {
      state.dispose()
    }
  })

  it('persists explicit locale changes, translates with interpolation, and reacts to languagechange', () => {
    mockNavigatorLanguage('zh-CN')
    const state = createI18nState()
    try {
      state.setLocale('en-US')
      expect(state.preference()).toBe('en-US')
      expect(state.locale()).toBe('en-US')
      expect(document.documentElement.lang).toBe('en-US')
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')
      expect(state.t('statusbar.projects', { count: 3 })).toBe('Projects: 3')

      state.setLocale(SYSTEM_LOCALE_ID)
      expect(state.locale()).toBe('zh-CN')
      expect(state.t('statusbar.projects', { count: 3 })).toBe('项目: 3')

      mockNavigatorLanguage('en-GB')
      window.dispatchEvent(new Event('languagechange'))
      expect(state.systemLocale()).toBe('en-US')
      expect(state.locale()).toBe('en-US')
    } finally {
      state.dispose()
    }
  })

  it('supports plugin i18n contributions, late locale registration, and resolveText fallback', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ja-JP')
    mockNavigatorLanguage('en-US')
    const fake = createFakeI18nHost()
    const state = createI18nState(fake.host)

    try {
      // Before plugin registers 'ja-JP', locale falls back without overwriting storage.
      expect(state.preference()).toBe('ja-JP')
      expect(state.locale()).toBe('en-US')
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ja-JP')

      fake.register({
        locale: 'ja-JP',
        label: '日本語',
        messages: {
          'settings.title': '設定',
          'theme.nord-dark': 'Nord ダーク',
        },
      })
      await flushEffects()

      expect(state.locales().map((l) => l.id)).toEqual(['zh-CN', 'en-US', 'ja-JP'])
      expect(state.locale()).toBe('ja-JP')
      expect(document.documentElement.lang).toBe('ja-JP')
      expect(state.t('settings.title')).toBe('設定')
      // Keys not translated by the plugin fall back to en-US.
      expect(state.t('common.close')).toBe('Close')
      expect(state.resolveText('theme.nord-dark', 'Nord Dark')).toBe('Nord ダーク')
      expect(state.resolveText(undefined, 'Custom Plugin')).toBe('Custom Plugin')

      fake.unregister('ja-JP')
      await flushEffects()
      expect(state.locale()).toBe('en-US')
      expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ja-JP')
    } finally {
      state.dispose()
    }
  })

  it('ignores reserved "system" locale contributions and normalizes underscore tags', () => {
    expect(resolveSystemLocale(BUILTIN_LOCALES.map((l) => l.id), 'zh_CN')).toBe('zh-CN')

    const fake = createFakeI18nHost()
    fake.register({
      locale: SYSTEM_LOCALE_ID,
      label: 'Hijack System',
      messages: { 'settings.title': 'BROKEN' },
    })
    const state = createI18nState(fake.host)
    try {
      expect(state.locales().map((l) => l.id)).toEqual(['zh-CN', 'en-US'])
      expect(state.t('settings.title')).not.toBe('BROKEN')
    } finally {
      state.dispose()
    }
  })

  it('keeps complete key parity between zh-CN and en-US across workbench and all built-in plugins', () => {
    expect(Object.keys(WORKBENCH_ZH_CN).sort()).toEqual(Object.keys(WORKBENCH_EN_US).sort())

    const kernel = createWorkbenchKernel(createMockBackend())
    try {
      for (const plugin of [
        explorerPlugin,
        searchPlugin,
        gitPlugin,
        previewCodePlugin,
        previewMarkdownPlugin,
        previewImagePlugin,
        previewAudioPlugin,
        previewFallbackPlugin,
        themeNordPlugin,
      ]) {
        kernel.registerPlugin(plugin)
      }

      const zhKeys = new Set<string>()
      const enKeys = new Set<string>()
      for (const item of kernel.contributions('i18n')()) {
        const target = item.locale === 'zh-CN' ? zhKeys : item.locale === 'en-US' ? enKeys : null
        if (!target) continue
        for (const k of Object.keys(item.messages)) {
          target.add(k)
        }
      }
      expect([...zhKeys].sort()).toEqual([...enKeys].sort())
      expect(zhKeys.size).toBeGreaterThan(30)
    } finally {
      kernel.dispose()
    }
  })
})
