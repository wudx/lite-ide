import { createEffect, createSignal, onCleanup } from 'solid-js'
import { describe, expect, it } from 'vitest'
import {
  createAppKernel,
  createServiceKey,
  toDisposable,
  type KernelProjectHost,
  type Plugin,
} from '../src'

function createMemoryHost(onClose?: (id: string) => void): KernelProjectHost {
  let seq = 0
  return {
    async open(rootPath: string) {
      seq += 1
      const id = `proj-${seq}`
      const name = rootPath.split(/[/\\]/).filter(Boolean).pop() ?? id
      return {
        info: { id, name, rootPath },
        close: () => onClose?.(id),
      }
    },
  }
}

describe('AppKernel & ProjectScope', () => {
  it('supports typed DI with project scope fallback to AppKernel', async () => {
    const ThemeKey = createServiceKey<string>('theme')
    const LocalKey = createServiceKey<number>('local-counter')
    const kernel = createAppKernel({ host: createMemoryHost() })
    kernel.provide(ThemeKey, 'dark')

    const scope = await kernel.openProject('/repos/alpha')
    expect(scope.get(ThemeKey)).toBe('dark')

    scope.provide(ThemeKey, 'high-contrast')
    scope.provide(LocalKey, 42)
    expect(scope.get(ThemeKey)).toBe('high-contrast')
    expect(scope.get(LocalKey)).toBe(42)
    expect(kernel.tryGet(LocalKey)).toBeUndefined()

    kernel.dispose()
  })

  it('reactively updates contributions and rolls back on failed plugin activation', () => {
    const kernel = createAppKernel({ host: createMemoryHost() })
    const observedCounts: number[] = []

    const stopEffect = kernel.contributions('command')
    expect(stopEffect().length).toBe(0)

    const goodPlugin: Plugin = {
      id: 'good',
      name: 'Good Plugin',
      activate(ctx) {
        ctx.contribute('command', {
          id: 'demo.ping',
          title: 'Ping',
          run: () => {},
        })
      },
    }
    const disposeGood = kernel.registerPlugin(goodPlugin)
    observedCounts.push(stopEffect().length)
    expect(stopEffect().length).toBe(1)

    const faultyPlugin: Plugin = {
      id: 'faulty',
      name: 'Faulty Plugin',
      activate(ctx) {
        ctx.contribute('command', {
          id: 'faulty.temp',
          title: 'Should rollback',
          run: () => {},
        })
        throw new Error('boom during activation')
      },
    }

    expect(() => kernel.registerPlugin(faultyPlugin)).toThrow('boom during activation')
    expect(stopEffect().map((c) => c.id)).toEqual(['demo.ping'])

    disposeGood.dispose()
    expect(stopEffect().length).toBe(0)
    kernel.dispose()
  })

  it('disposes Solid reactive effects and host watcher when project tab closes', async () => {
    const closedIds: string[] = []
    const kernel = createAppKernel({ host: createMemoryHost((id) => closedIds.push(id)) })
    let cleanupCount = 0
    let runs = 0
    let setCount!: (v: number) => void

    kernel.registerPlugin({
      id: 'tracker',
      name: 'Tracker',
      activate(ctx) {
        ctx.onProjectOpen((_scope) => {
          const [count, setter] = createSignal(0)
          setCount = setter
          createEffect(() => {
            count()
            runs += 1
          })
          onCleanup(() => {
            cleanupCount += 1
          })
          return toDisposable(() => {
            cleanupCount += 10
          })
        })
      },
    })

    const scope = await kernel.openProject('D:\\code\\repo-a')
    expect(runs).toBe(1)
    setCount(1)
    expect(runs).toBe(2)

    // Duplicate path (different slash/casing) reuses the active project without opening a second tab.
    const dup = await kernel.openProject('d:/code/repo-a/')
    expect(dup.id).toBe(scope.id)
    expect(kernel.projects().length).toBe(1)

    await kernel.closeProject(scope.id)
    setCount(2)
    expect(runs).toBe(2)
    expect(scope.isDisposed).toBe(true)
    expect(closedIds).toEqual([scope.id])
    expect(cleanupCount).toBe(11)
    expect(kernel.projects().length).toBe(0)
    kernel.dispose()
  })

  it('maintains LRU warm project cap and selects adjacent tab on close', async () => {
    const kernel = createAppKernel({ host: createMemoryHost(), maxWarmProjects: 2 })
    const p1 = await kernel.openProject('/repo/1')
    const p2 = await kernel.openProject('/repo/2')
    const p3 = await kernel.openProject('/repo/3')

    expect(kernel.warmProjectIds()).toEqual([p3.id, p2.id])
    expect(kernel.isWarm(p1.id)).toBe(false)
    expect(kernel.isWarm(p3.id)).toBe(true)

    kernel.activateProject(p1.id)
    expect(kernel.warmProjectIds()).toEqual([p1.id, p3.id])
    expect(kernel.activeProjectId()).toBe(p1.id)

    await kernel.closeProject(p1.id)
    expect(kernel.activeProjectId()).toBe(p2.id)
    kernel.dispose()
  })
})
