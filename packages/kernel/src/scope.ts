import { createRoot, getOwner, runWithOwner, type Owner } from 'solid-js'
import { DisposableStore, toDisposable, type Disposable } from './disposable'
import type { AppKernel, ProjectScope, ServiceKey } from './types'

export class ProjectScopeImpl implements ProjectScope {
  readonly id: string
  readonly name: string
  readonly rootPath: string

  private readonly services = new Map<symbol, unknown>()
  private readonly store = new DisposableStore()
  private readonly parent: AppKernel
  private readonly owner: Owner | null
  private readonly disposeRoot: () => void

  constructor(
    id: string,
    name: string,
    rootPath: string,
    parent: AppKernel,
  ) {
    this.id = id
    this.name = name
    this.rootPath = rootPath
    this.parent = parent

    let capturedOwner: Owner | null = null
    let capturedDispose = () => {}
    createRoot((dispose) => {
      capturedOwner = getOwner()
      capturedDispose = dispose
    })
    this.owner = capturedOwner
    this.disposeRoot = capturedDispose
  }

  get isDisposed(): boolean {
    return this.store.isDisposed
  }

  provide<T>(key: ServiceKey<T>, service: T): Disposable {
    if (this.store.isDisposed) {
      throw new Error(`Cannot provide service "${key.name}" on disposed scope "${this.id}"`)
    }
    this.services.set(key.id, service)
    return this.store.add(
      toDisposable(() => {
        if (this.services.get(key.id) === service) {
          this.services.delete(key.id)
        }
      }),
    )
  }

  tryGet<T>(key: ServiceKey<T>): T | undefined {
    if (this.services.has(key.id)) {
      return this.services.get(key.id) as T
    }
    return this.parent.tryGet(key)
  }

  get<T>(key: ServiceKey<T>): T {
    const value = this.tryGet(key)
    if (value === undefined) {
      throw new Error(`Service "${key.name}" not found in project scope "${this.name}"`)
    }
    return value
  }

  onDispose(disposable: Disposable | (() => void)): Disposable {
    const item = typeof disposable === 'function' ? toDisposable(disposable) : disposable
    return this.store.add(item)
  }

  runInScope<R>(fn: () => R): R {
    if (this.store.isDisposed || !this.owner) {
      return fn()
    }
    return runWithOwner(this.owner, fn) as R
  }

  dispose(): void {
    if (this.store.isDisposed) return
    this.store.dispose()
    this.services.clear()
    this.disposeRoot()
  }
}
