import { batch, createMemo, createRoot, createSignal, type Accessor, type Setter } from 'solid-js'
import { DisposableStore, toDisposable, type Disposable } from './disposable'
import { EventBus } from './events'
import { ProjectScopeImpl } from './scope'
import type {
  AppKernel,
  AppKernelOptions,
  ContributionMap,
  ContributionPoint,
  KernelEvents,
  Plugin,
  PluginContext,
  ProjectScope,
  ServiceKey,
} from './types'

interface ProjectOpenHook {
  handler: (scope: ProjectScope) => void | Disposable
  pluginStore: DisposableStore
}

export function normalizePathKey(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows drive-letter normalization (`D:/foo` == `d:/foo`).
  if (/^[A-Za-z]:/.test(trimmed)) {
    return trimmed[0].toLowerCase() + trimmed.slice(1)
  }
  return trimmed
}

/**
 * 把 fromIndex 的元素移动到 toIndex（splice 落位语义，供页签拖拽排序共用）。
 * 越界下标收敛到合法区间；起点非法或原地移动返回 null（no-op）。
 */
export function moveWithin<T>(
  list: readonly T[],
  fromIndex: number,
  toIndex: number,
): T[] | null {
  if (fromIndex < 0 || fromIndex >= list.length) return null
  const target = Math.max(0, Math.min(list.length - 1, toIndex))
  if (target === fromIndex) return null
  const next = [...list]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(target, 0, moved)
  return next
}

export function createAppKernel(options: AppKernelOptions): AppKernel {
  const maxWarmProjects = Math.max(1, options.maxWarmProjects ?? 5)
  const services = new Map<symbol, unknown>()
  const events = new EventBus<KernelEvents>()
  const rootStore = new DisposableStore()
  const plugins = new Map<string, DisposableStore>()
  const projectOpenHooks = new Set<ProjectOpenHook>()
  const closeHooks = new Map<string, () => Promise<void> | void>()
  const inflightOpens = new Map<string, Promise<ProjectScope>>()

  const contributionSignals = new Map<
    ContributionPoint,
    [Accessor<readonly unknown[]>, Setter<readonly unknown[]>]
  >()

  function ensurePoint<K extends ContributionPoint>(
    point: K,
  ): [Accessor<readonly ContributionMap[K][]>, Setter<readonly ContributionMap[K][]>] {
    let pair = contributionSignals.get(point)
    if (!pair) {
      const [get, set] = createSignal<readonly unknown[]>([])
      pair = [get, set]
      contributionSignals.set(point, pair)
    }
    return pair as [Accessor<readonly ContributionMap[K][]>, Setter<readonly ContributionMap[K][]>]
  }

  const { projects, setProjects, activeProjectId, setActiveProjectId, warmProjectIds, setWarmProjectIds, activeProject } =
    createRoot((disposeKernelRoot) => {
      rootStore.add(toDisposable(disposeKernelRoot))
      const [projects, setProjects] = createSignal<readonly ProjectScope[]>([])
      const [activeProjectId, setActiveProjectId] = createSignal<string | null>(null)
      const [warmProjectIds, setWarmProjectIds] = createSignal<readonly string[]>([])

      const activeProject = createMemo(() => {
        const id = activeProjectId()
        if (!id) return undefined
        return projects().find((p) => p.id === id)
      })

      return {
        projects,
        setProjects,
        activeProjectId,
        setActiveProjectId,
        warmProjectIds,
        setWarmProjectIds,
        activeProject,
      }
    })

  function touchWarmProject(projectId: string) {
    setWarmProjectIds((prev) => {
      const next = [projectId, ...prev.filter((id) => id !== projectId)]
      return next.slice(0, maxWarmProjects)
    })
  }

  function invokeProjectHook(hook: ProjectOpenHook, scope: ProjectScope) {
    if (scope.isDisposed || hook.pluginStore.isDisposed) return
    const result = scope.runInScope(() => hook.handler(scope))
    if (!result) return

    let cleaned = false
    const unified = toDisposable(() => {
      if (cleaned) return
      cleaned = true
      hook.pluginStore.delete(unified)
      result.dispose()
    })
    scope.onDispose(unified)
    hook.pluginStore.add(unified)
  }

  const kernel: AppKernel = {
    projects,
    activeProjectId,
    activeProject,
    warmProjectIds,

    isWarm(projectId: string): boolean {
      return warmProjectIds().includes(projectId)
    },

    provide<T>(key: ServiceKey<T>, service: T): Disposable {
      services.set(key.id, service)
      return rootStore.add(
        toDisposable(() => {
          if (services.get(key.id) === service) {
            services.delete(key.id)
          }
        }),
      )
    },

    tryGet<T>(key: ServiceKey<T>): T | undefined {
      return services.get(key.id) as T | undefined
    },

    get<T>(key: ServiceKey<T>): T {
      if (!services.has(key.id)) {
        throw new Error(`Service "${key.name}" not found in AppKernel`)
      }
      return services.get(key.id) as T
    },

    contribute<K extends ContributionPoint>(point: K, item: ContributionMap[K]): Disposable {
      const [, setList] = ensurePoint(point)
      setList((prev) => [...prev, item])
      return rootStore.add(
        toDisposable(() => {
          setList((prev) => prev.filter((entry) => entry !== item))
        }),
      )
    },

    contributions<K extends ContributionPoint>(point: K): Accessor<readonly ContributionMap[K][]> {
      const [getList] = ensurePoint(point)
      return getList
    },

    onEvent<K extends keyof KernelEvents>(
      event: K,
      listener: (payload: KernelEvents[K]) => void,
    ): Disposable {
      return events.on(event, listener)
    },

    emit<K extends keyof KernelEvents>(event: K, payload: KernelEvents[K]): void {
      events.emit(event, payload)
    },

    registerPlugin(plugin: Plugin): Disposable {
      if (plugins.has(plugin.id)) {
        throw new Error(`Plugin "${plugin.id}" is already registered`)
      }

      const pluginStore = new DisposableStore()
      plugins.set(plugin.id, pluginStore)

      const ctx: PluginContext = {
        kernel,
        provide<T>(key: ServiceKey<T>, service: T): Disposable {
          return pluginStore.add(kernel.provide(key, service))
        },
        get<T>(key: ServiceKey<T>): T {
          return kernel.get(key)
        },
        tryGet<T>(key: ServiceKey<T>): T | undefined {
          return kernel.tryGet(key)
        },
        contribute<K extends ContributionPoint>(point: K, item: ContributionMap[K]): Disposable {
          return pluginStore.add(kernel.contribute(point, item))
        },
        onEvent<K extends keyof KernelEvents>(
          event: K,
          listener: (payload: KernelEvents[K]) => void,
        ): Disposable {
          return pluginStore.add(kernel.onEvent(event, listener))
        },
        emit<K extends keyof KernelEvents>(event: K, payload: KernelEvents[K]): void {
          kernel.emit(event, payload)
        },
        onProjectOpen(handler: (scope: ProjectScope) => void | Disposable): Disposable {
          const hook: ProjectOpenHook = { handler, pluginStore }
          projectOpenHooks.add(hook)
          for (const existingScope of projects()) {
            invokeProjectHook(hook, existingScope)
          }
          return pluginStore.add(
            toDisposable(() => {
              projectOpenHooks.delete(hook)
            }),
          )
        },
        onDispose(disposable: Disposable | (() => void)): Disposable {
          const d = typeof disposable === 'function' ? toDisposable(disposable) : disposable
          return pluginStore.add(d)
        },
      }

      try {
        const ret = plugin.activate(ctx)
        if (ret) {
          pluginStore.add(ret)
        }
      } catch (err) {
        plugins.delete(plugin.id)
        pluginStore.dispose()
        throw err
      }

      events.emit('plugin.registered', { id: plugin.id })

      return toDisposable(() => {
        if (!plugins.delete(plugin.id)) return
        pluginStore.dispose()
        events.emit('plugin.unregistered', { id: plugin.id })
      })
    },

    async openProject(rootPath: string): Promise<ProjectScope> {
      const requestKey = normalizePathKey(rootPath)
      const existingByInput = projects().find((p) => normalizePathKey(p.rootPath) === requestKey)
      if (existingByInput) {
        kernel.activateProject(existingByInput.id)
        return existingByInput
      }

      const pending = inflightOpens.get(requestKey)
      if (pending) return pending

      const promise = (async () => {
        const handle = await options.host.open(rootPath)
        const { info } = handle

        const existingByCanonical = projects().find(
          (p) =>
            p.id === info.id ||
            normalizePathKey(p.rootPath) === normalizePathKey(info.rootPath),
        )
        if (existingByCanonical) {
          kernel.activateProject(existingByCanonical.id)
          return existingByCanonical
        }

        const scope = new ProjectScopeImpl(info.id, info.name, info.rootPath, kernel)
        if (handle.close) {
          closeHooks.set(info.id, handle.close)
        }

        try {
          handle.setupScope?.(scope)

          for (const hook of [...projectOpenHooks]) {
            invokeProjectHook(hook, scope)
          }
        } catch (err) {
          scope.dispose()
          closeHooks.delete(info.id)
          if (handle.close) {
            try {
              await handle.close()
            } catch {
              // Preserve the original setup error.
            }
          }
          throw err
        }

        batch(() => {
          setProjects((prev) => [...prev, scope])
          touchWarmProject(scope.id)
          setActiveProjectId(scope.id)
        })

        events.emit('project.opened', { scope })
        events.emit('project.activated', { scope })
        return scope
      })()

      inflightOpens.set(requestKey, promise)
      try {
        return await promise
      } finally {
        inflightOpens.delete(requestKey)
      }
    },

    async openProjectWithDialog(dialogOptions?: { title?: string }): Promise<ProjectScope | null> {
      if (!options.host.pickFolder) return null
      const folder = await options.host.pickFolder(dialogOptions)
      if (!folder) return null
      return kernel.openProject(folder)
    },

    activateProject(projectId: string): void {
      const scope = projects().find((p) => p.id === projectId)
      if (!scope) return
      if (activeProjectId() === projectId) {
        touchWarmProject(projectId)
        return
      }
      touchWarmProject(projectId)
      setActiveProjectId(projectId)
      events.emit('project.activated', { scope })
    },

    reorderProjects(fromIndex: number, toIndex: number): void {
      const next = moveWithin(projects(), fromIndex, toIndex)
      if (!next) return
      setProjects(next)
      events.emit('project.reordered', { projectIds: next.map((p) => p.id) })
    },

    async closeProject(projectId: string): Promise<void> {
      const current = projects()
      const idx = current.findIndex((p) => p.id === projectId)
      if (idx === -1) return

      const target = current[idx]
      const nextList = current.filter((p) => p.id !== projectId)
      const isClosingActive = activeProjectId() === projectId
      const fallback = isClosingActive ? (nextList[idx] ?? nextList[idx - 1] ?? null) : undefined

      batch(() => {
        setProjects(nextList)
        setWarmProjectIds((prev) => prev.filter((id) => id !== projectId))

        if (isClosingActive) {
          setActiveProjectId(fallback ? fallback.id : null)
          if (fallback) {
            touchWarmProject(fallback.id)
          }
        }
      })

      if (isClosingActive) {
        events.emit('project.activated', { scope: fallback ?? undefined })
      }

      target.dispose()
      const hostClose = closeHooks.get(projectId)
      closeHooks.delete(projectId)
      if (hostClose) {
        await hostClose()
      }

      events.emit('project.closed', {
        projectId: target.id,
        rootPath: target.rootPath,
      })
    },

    async executeCommand(commandId: string): Promise<void> {
      const commands = kernel.contributions('command')()
      const cmd = commands.find((c) => c.id === commandId)
      if (!cmd) {
        throw new Error(`Command "${commandId}" not found`)
      }
      await cmd.run({ kernel, activeProject: activeProject() })
    },

    dispose(): void {
      for (const scope of [...projects()]) {
        scope.dispose()
        const hostClose = closeHooks.get(scope.id)
        if (hostClose) {
          void hostClose()
        }
      }
      closeHooks.clear()
      setProjects([])
      setWarmProjectIds([])
      setActiveProjectId(null)

      for (const [, store] of [...plugins]) {
        store.dispose()
      }
      plugins.clear()
      projectOpenHooks.clear()
      rootStore.dispose()
      services.clear()
      events.clear()
    },
  }

  return kernel
}
