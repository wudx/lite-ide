import { beforeEach, describe, expect, it } from 'vitest'
import { createThemeState, THEME_STORAGE_KEY } from '../src/services'

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

  it('toggles and persists theme changes', () => {
    const state = createThemeState()
    state.toggleTheme()
    expect(state.theme()).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    state.setTheme('dark')
    expect(state.theme()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('falls back to dark for invalid stored values', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    const state = createThemeState()
    expect(state.theme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
