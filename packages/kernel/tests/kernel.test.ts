import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js'
import { describe, expect, it } from 'vitest'
import {
  createAppKernel,
  createServiceKey,
  moveWithin,
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

  it('supports panel.view contributions with registration/disposal lifecycle', () => {
    const kernel = createAppKernel({ host: createMemoryHost() })
    const panels = kernel.contributions('panel.view')
    expect(panels().length).toBe(0)

    const plugin: Plugin = {
      id: 'panelist',
      name: 'Panelist',
      activate(ctx) {
        ctx.contribute('panel.view', {
          id: 'demo-panel',
          title: 'Demo Panel',
          titleKey: 'demo.panel.title',
          order: 10,
          component: () => null,
        })
      },
    }
    const dispose = kernel.registerPlugin(plugin)
    const contributed = panels()
    expect(contributed.length).toBe(1)
    expect(contributed[0].id).toBe('demo-panel')
    expect(contributed[0].titleKey).toBe('demo.panel.title')

    dispose.dispose()
    expect(panels().length).toBe(0)
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

  it('reorders project tabs without touching active project or warm set', async () => {
    const kernel = createAppKernel({ host: createMemoryHost() })
    const p1 = await kernel.openProject('/repo/1')
    const p2 = await kernel.openProject('/repo/2')
    const p3 = await kernel.openProject('/repo/3')
    kernel.activateProject(p2.id)

    kernel.reorderProjects(0, 2)
    expect(kernel.projects().map((p) => p.name)).toEqual(['2', '3', '1'])
    expect(kernel.activeProjectId()).toBe(p2.id)
    expect(kernel.isWarm(p1.id)).toBe(true)

    // 越界下标收敛到合法区间：拖过末尾等价于移到末位。
    kernel.reorderProjects(1, 99)
    expect(kernel.projects().map((p) => p.name)).toEqual(['2', '1', '3'])

    // 无效起点与原地移动均为 no-op。
    kernel.reorderProjects(-1, 0)
    kernel.reorderProjects(99, 0)
    kernel.reorderProjects(2, 2)
    expect(kernel.projects().map((p) => p.name)).toEqual(['2', '1', '3'])

    kernel.dispose()
  })

  it('emits project.reordered with the new id order', async () => {
    const kernel = createAppKernel({ host: createMemoryHost() })
    const p1 = await kernel.openProject('/repo/1')
    const p2 = await kernel.openProject('/repo/2')
    const p3 = await kernel.openProject('/repo/3')

    const orders: string[][] = []
    kernel.onEvent('project.reordered', ({ projectIds }) => {
      orders.push([...projectIds])
    })

    kernel.reorderProjects(2, 0)
    expect(orders).toEqual([[p3.id, p1.id, p2.id]])
    expect(kernel.projects().map((p) => p.id)).toEqual([p3.id, p1.id, p2.id])

    // no-op 不发事件。
    kernel.reorderProjects(0, 0)
    expect(orders.length).toBe(1)

    kernel.dispose()
  })

  it('moveWithin clamps out-of-range targets and reports no-ops as null', () => {
    expect(moveWithin(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveWithin(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveWithin(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b'])
    expect(moveWithin(['a', 'b', 'c'], 1, -5)).toEqual(['b', 'a', 'c'])
    expect(moveWithin(['a', 'b', 'c'], -1, 0)).toBeNull()
    expect(moveWithin(['a', 'b', 'c'], 3, 0)).toBeNull()
    expect(moveWithin(['a', 'b', 'c'], 1, 1)).toBeNull()
  })

  it('provides plugin services before projects/warm/active signals notify reactive UI', async () => {
    const StoreKey = createServiceKey<string>('plugin.store')
    const kernel = createAppKernel({ host: createMemoryHost() })

    kernel.registerPlugin({
      id: 'store-provider',
      name: 'Store Provider',
      activate(ctx) {
        ctx.onProjectOpen((scope) => {
          scope.provide(StoreKey, `store-for-${scope.name}`)
        })
      },
    })

    const observed: Array<{ name: string; store: string; activeId: string | null }> = []
    const disposeObserver = createRoot((dispose) => {
      createEffect(() => {
        for (const scope of kernel.projects()) {
          if (kernel.isWarm(scope.id)) {
            observed.push({
              name: scope.name,
              store: scope.get(StoreKey),
              activeId: kernel.activeProjectId(),
            })
          }
        }
      })
      return dispose
    })

    const opened = await kernel.openProject('/repo/reactive-test')
    expect(observed).toEqual([
      {
        name: 'reactive-test',
        store: 'store-for-reactive-test',
        activeId: opened.id,
      },
    ])

    disposeObserver()
    kernel.dispose()
  })
})
