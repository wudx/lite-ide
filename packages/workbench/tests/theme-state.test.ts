import { beforeEach, describe, expect, it } from 'vitest'
import { createSettingsDialogService } from '../src/dialogs'
import { createThemeState, THEME_DEFINITIONS, THEME_STORAGE_KEY } from '../src/services'

describe('createThemeState', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.classList.remove('dark', 'light')
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

  it('falls back to dark for invalid stored values', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    const state = createThemeState()
    expect(state.theme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
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
