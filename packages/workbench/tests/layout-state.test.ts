import { describe, expect, it } from 'vitest'
import { createLayoutState } from '../src/services'

describe('createLayoutState', () => {
  it('tracks sidebar visibility, width clamping, and active view switching', () => {
    const layout = createLayoutState()

    expect(layout.sidebarVisible()).toBe(true)
    expect(layout.sidebarWidth()).toBe(260)
    expect(layout.sidebarViewId('proj-1')).toBeNull()

    layout.toggleSidebar()
    expect(layout.sidebarVisible()).toBe(false)

    layout.showSidebarView('proj-1', 'search')
    expect(layout.sidebarVisible()).toBe(true)
    expect(layout.sidebarViewId('proj-1')).toBe('search')
    expect(layout.sidebarViewId('proj-2')).toBeNull()

    layout.setSidebarVisible(false)
    expect(layout.sidebarVisible()).toBe(false)

    layout.setSidebarViewId('proj-1', 'git')
    expect(layout.sidebarViewId('proj-1')).toBe('git')

    layout.setSidebarWidth(50)
    expect(layout.sidebarWidth()).toBe(180)
    layout.setSidebarWidth(900)
    expect(layout.sidebarWidth()).toBe(520)
  })
})
