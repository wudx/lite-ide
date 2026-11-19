import { toDisposable, type Disposable } from './disposable'

export class EventBus<EventMap extends Record<string, unknown>> {
  private listeners = new Map<keyof EventMap, Set<(payload: never) => void>>()

  on<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void,
  ): Disposable {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const fn = listener as (payload: never) => void
    set.add(fn)
    return toDisposable(() => {
      set?.delete(fn)
      if (set && set.size === 0) {
        this.listeners.delete(event)
      }
    })
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return
    for (const listener of [...set]) {
      try {
        ;(listener as (p: EventMap[K]) => void)(payload)
      } catch (err) {
        console.error(`[kernel] event "${String(event)}" listener failed:`, err)
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
