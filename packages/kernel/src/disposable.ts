export interface Disposable {
  dispose(): void
}

export function toDisposable(fn: () => void): Disposable {
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      fn()
    },
  }
}

export class DisposableStore implements Disposable {
  private items: Disposable[] = []
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose()
      return item
    }
    this.items.push(item)
    return item
  }

  delete(item: Disposable): void {
    const idx = this.items.indexOf(item)
    if (idx !== -1) {
      this.items.splice(idx, 1)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const current = this.items.splice(0, this.items.length)
    // Dispose in reverse registration order (LIFO).
    for (let i = current.length - 1; i >= 0; i--) {
      try {
        current[i].dispose()
      } catch (err) {
        console.error('[kernel] dispose error:', err)
      }
    }
  }
}
