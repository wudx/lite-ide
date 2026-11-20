import { createSignal } from 'solid-js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSettingsDialogService } from '../src/dialogs'
import {
  createThemeState,
  THEME_DEFINITIONS,
  THEME_STORAGE_KEY,
  type ThemeContribution,
} from '../src/services'

/** createThemeState 接受的内核形态：仅依赖 theme 贡献点读取。 */
function createFakeThemeHost() {
  const [contributions, setContributions] = createSignal<readonly ThemeContribution[]>([])
  return {
    // 与 AppKernel.contributions 一致：返回 accessor 本身，由调用方取值。
    host: { contributions: () => contributions },
    register(item: ThemeContribution) {
      setContributions((prev) => [...prev, item])
    },
    unregister(id: string) {
      setContributions((prev) => prev.filter((item) => item.id !== id))
    },
  }
}

const NORD: ThemeContribution = {
  id: 'nord-dark',
  label: 'Nord 深色',
  appearance: 'dark',
  variables: { '--bg-app': '#2e3440', '--accent': '#88c0d0' },
}

/**
 * Solid 1.9 在 batch 外同步冲刷 effect，通常无需等待；保留一个 macrotask
 * 边界作为保险，以防 Solid 内部调度改为异步。
 */
function flushEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createThemeState', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.classList.remove('dark', 'light')
    document.documentElement.removeAttribute('style')
  })

  it('defaults to dark theme and syncs DOM attributes', () => {
    const state = createThemeState()
    expect(state.theme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })

  it('restores stored light theme on initialization', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const state = createThemeState()
    expect(state.theme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('restores solarized-light theme and marks it as a light theme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'solarized-light')
    const state = createThemeState()
    expect(state.theme()).toBe('solarized-light')
    expect(state.appearance()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('solarized-light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('cycles through all themes on toggle and persists', () => {
    const state = createThemeState()
    const ids = THEME_DEFINITIONS.map((t) => t.id)
    for (let i = 0; i < ids.length; i++) {
      expect(state.theme()).toBe(ids[i])
      state.toggleTheme()
      // Each toggle advances to the next theme and persists it.
      expect(state.theme()).toBe(ids[(i + 1) % ids.length])
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(state.theme())
      expect(document.documentElement.dataset.theme).toBe(state.theme())
    }
  })

  it('persists explicit setTheme changes', () => {
    const state = createThemeState()
    state.setTheme('solarized-light')
    expect(state.theme()).toBe('solarized-light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('solarized-light')
    expect(document.documentElement.dataset.theme).toBe('solarized-light')

    state.setTheme('dark')
    expect(state.theme()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('keeps unknown stored ids while the DOM falls back to dark, without persisting', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    const state = createThemeState()
    await flushEffects()
    // DOM 兜底为内置 dark（与 index.html FOUC 脚本一致）。
    expect(document.documentElement.dataset.theme).toBe('dark')
    // 未知 id 保留不落盘改写：同名主题若稍后注册仍有机会自动命中。
    expect(state.theme()).toBe('sepia')
    expect(state.appearance()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('sepia')
  })

  it('lists built-in themes via themes()', () => {
    const state = createThemeState()
    expect(state.themes().map((t) => t.id)).toEqual(THEME_DEFINITIONS.map((t) => t.id))
  })

  it('exposes plugin-contributed themes and cycles them on toggle', () => {
    const fake = createFakeThemeHost()
    const state = createThemeState(fake.host)
    expect(state.themes().map((t) => t.id)).not.toContain('nord-dark')

    fake.register(NORD)
    expect(state.themes().map((t) => t.id)).toEqual([
      ...THEME_DEFINITIONS.map((t) => t.id),
      'nord-dark',
    ])

    // toggle 从最后一个内置主题推进到插件主题，再回到内置 dark。
    state.setTheme('solarized-light')
    state.toggleTheme()
    expect(state.theme()).toBe('nord-dark')
    state.toggleTheme()
    expect(state.theme()).toBe('dark')
  })

  it('applies plugin theme variables as inline styles and clears them on switch', () => {
    const fake = createFakeThemeHost()
    fake.register(NORD)
    const state = createThemeState(fake.host)

    state.setTheme('nord-dark')
    expect(state.theme()).toBe('nord-dark')
    expect(state.appearance()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('nord-dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#2e3440')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#88c0d0')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nord-dark')

    state.setTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
  })

  it('restores a stored plugin theme once its plugin registers late', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'nord-dark')
    const fake = createFakeThemeHost()
    // 启动时插件尚未注册：DOM 先按内置 dark 兜底，主题 id 保留待校正。
    const state = createThemeState(fake.host)
    expect(state.theme()).toBe('nord-dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    fake.register(NORD)
    await flushEffects()
    expect(state.theme()).toBe('nord-dark')
    expect(document.documentElement.dataset.theme).toBe('nord-dark')
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#2e3440')
  })

  it('keeps the theme id when its plugin unregisters and reapplies it on re-register', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'nord-dark')
    const fake = createFakeThemeHost()
    fake.register(NORD)
    const state = createThemeState(fake.host)
    await flushEffects()
    expect(document.documentElement.dataset.theme).toBe('nord-dark')

    fake.unregister('nord-dark')
    await flushEffects()
    // id 保留、DOM 兜底 dark：插件可再注册（含动态 import 迟到加载）。
    expect(state.theme()).toBe('nord-dark')
    expect(state.appearance()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nord-dark')

    // 重新注册：effect 随注册表变化自动恢复该主题。
    fake.register(NORD)
    await flushEffects()
    expect(state.appearance()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('nord-dark')
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#2e3440')
  })
})

describe('createSettingsDialogService', () => {
  it('opens and closes the dialog', () => {
    const service = createSettingsDialogService()
    expect(service.isOpen()).toBe(false)

    service.open()
    expect(service.isOpen()).toBe(true)

    service.close()
    expect(service.isOpen()).toBe(false)
  })
})
