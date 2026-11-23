import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'solid-js'
import {
  computeInsertIndex,
  createTabDragReorder,
  resolveMoveIndex,
  TAB_DRAG_START_THRESHOLD_PX,
  type TabDragReorder,
} from '../src/tab-drag'

function rectOf(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    top: 0,
    bottom: 30,
    width,
    height: 30,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

interface PointerInit {
  button?: number
  pointerId?: number
  clientX?: number
  clientY?: number
  target?: EventTarget | null
  currentTarget?: EventTarget | null
}

function pointerEvent(init: PointerInit): PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    target: null,
    currentTarget: null,
    ...init,
  } as unknown as PointerEvent
}

describe('tab-drag pure helpers', () => {
  it('computeInsertIndex splits tabs at their midpoints', () => {
    const mids = [100, 200, 300]
    expect(computeInsertIndex(mids, 40)).toBe(0)
    expect(computeInsertIndex(mids, 100)).toBe(1)
    expect(computeInsertIndex(mids, 160)).toBe(1)
    expect(computeInsertIndex(mids, 299)).toBe(2)
    expect(computeInsertIndex(mids, 301)).toBe(3)
    expect(computeInsertIndex([], 120)).toBe(0)
  })

  it('resolveMoveIndex converts an insert position into the final splice index', () => {
    expect(resolveMoveIndex(0, 1)).toBe(0)
    expect(resolveMoveIndex(0, 2)).toBe(1)
    expect(resolveMoveIndex(2, 1)).toBe(1)
    expect(resolveMoveIndex(2, 3)).toBe(2)
  })
})

describe('createTabDragReorder', () => {
  const created: Array<() => void> = []

  afterEach(() => {
    for (const dispose of created.splice(0).reverse()) dispose()
    document.body.innerHTML = ''
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  })

  interface Harness {
    drag: TabDragReorder
    strip: HTMLElement
    tabA: HTMLElement
    tabB: HTMLElement
    reorder: ReturnType<typeof vi.fn>
  }

  function createHarness(): Harness {
    const strip = document.createElement('div')
    const tabA = document.createElement('div')
    const tabB = document.createElement('div')
    tabA.dataset.tabDragId = 'a'
    tabB.dataset.tabDragId = 'b'
    strip.append(tabA, tabB)
    document.body.append(strip)

    // jsdom 无 pointer capture 与布局，这里以桩提供几何信息。
    for (const el of [tabA, tabB]) {
      ;(el as HTMLElement & { setPointerCapture?: unknown }).setPointerCapture = () => {}
      ;(el as HTMLElement & { hasPointerCapture?: unknown }).hasPointerCapture = () => false
    }
    tabA.getBoundingClientRect = () => rectOf(0, 100)
    tabB.getBoundingClientRect = () => rectOf(100, 100)
    strip.getBoundingClientRect = () => rectOf(0, 200)

    const reorder = vi.fn()
    let drag!: TabDragReorder
    created.push(
      createRoot((dispose) => {
        drag = createTabDragReorder({ getStrip: () => strip, reorder })
        return dispose
      }),
    )
    return { drag, strip, tabA, tabB, reorder }
  }

  function press(harness: Harness, el: HTMLElement, clientX: number) {
    harness.drag
      .tabHandlers(el.dataset.tabDragId!)
      .onPointerDown(
        pointerEvent({ target: el, currentTarget: el, clientX, clientY: 10 }),
      )
  }

  function move(harness: Harness, el: HTMLElement, clientX: number, clientY = 10) {
    harness.drag
      .tabHandlers(el.dataset.tabDragId!)
      .onPointerMove(pointerEvent({ target: el, currentTarget: el, clientX, clientY }))
  }

  function release(harness: Harness, el: HTMLElement) {
    harness.drag.tabHandlers(el.dataset.tabDragId!).onPointerUp(
      pointerEvent({ target: el, currentTarget: el, clientX: 0, clientY: 0 }),
    )
  }

  it('ignores movement below the start threshold (stays a click)', () => {
    const harness = createHarness()
    press(harness, harness.tabA, 50)
    move(harness, harness.tabA, 50 + TAB_DRAG_START_THRESHOLD_PX - 1)

    expect(harness.reorder).not.toHaveBeenCalled()
    expect(harness.drag.draggingId()).toBeNull()
  })

  it('reorders live while dragging past a neighbour midpoint', () => {
    const harness = createHarness()
    press(harness, harness.tabA, 50)
    move(harness, harness.tabA, 160)

    expect(harness.drag.draggingId()).toBe('a')
    expect(harness.reorder).toHaveBeenCalledWith(0, 1)

    release(harness, harness.tabA)
    expect(harness.drag.draggingId()).toBeNull()
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
  })

  it('keeps events tracked via the pressed tab even when moves target other tabs', () => {
    const harness = createHarness()
    press(harness, harness.tabA, 50)
    // 快速拖动时 move 落在邻页签上：捕获指针后仍由按下的页签处理。
    move(harness, harness.tabB, 170)

    expect(harness.reorder).toHaveBeenCalledWith(0, 1)
  })

  it('freezes reordering and edge scroll while the pointer leaves the strip vertically', () => {
    const harness = createHarness()
    press(harness, harness.tabA, 50)
    // 纵向拖出条外（容差 12px，条高 30px）：进入拖拽但不换位。
    move(harness, harness.tabA, 170, 200)

    expect(harness.drag.draggingId()).toBe('a')
    expect(harness.reorder).not.toHaveBeenCalled()

    // 拖回条内恢复换位。
    move(harness, harness.tabA, 170, 10)
    expect(harness.reorder).toHaveBeenCalledWith(0, 1)
  })

  it('re-arms pointer capture after each live reorder (implicit release on DOM move)', () => {
    const harness = createHarness()
    const capture = vi.fn()
    ;(harness.tabA as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = capture
    press(harness, harness.tabA, 50)
    expect(capture).toHaveBeenCalledTimes(1)

    move(harness, harness.tabA, 160)
    expect(harness.reorder).toHaveBeenCalledWith(0, 1)
    // pointerdown 捕获一次 + 换位后重设一次。
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenLastCalledWith(1)
  })

  it('suppresses the click that follows a real drag, then recovers', () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const handlers = harness.drag.tabHandlers('a')
      press(harness, harness.tabA, 50)
      move(harness, harness.tabA, 160)
      release(harness, harness.tabA)

      const prevented = vi.fn()
      const stopped = vi.fn()
      const click = { preventDefault: prevented, stopPropagation: stopped } as unknown as MouseEvent

      handlers.onClickCapture(click)
      expect(prevented).toHaveBeenCalled()
      expect(stopped).toHaveBeenCalled()

      vi.runAllTimers()
      handlers.onClickCapture(click)
      expect(prevented).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a drag from secondary buttons or nested buttons', () => {
    const harness = createHarness()
    const handlers = harness.drag.tabHandlers('a')

    handlers.onPointerDown(pointerEvent({ target: harness.tabA, currentTarget: harness.tabA, button: 1 }))
    handlers.onPointerDown(pointerEvent({ target: harness.tabA, currentTarget: harness.tabA, button: 2 }))
    move(harness, harness.tabA, 160)
    expect(harness.drag.draggingId()).toBeNull()
    expect(harness.reorder).not.toHaveBeenCalled()

    const closeButton = document.createElement('button')
    harness.tabA.append(closeButton)
    handlers.onPointerDown(pointerEvent({ target: closeButton, currentTarget: harness.tabA }))
    move(harness, harness.tabA, 160)
    expect(harness.drag.draggingId()).toBeNull()
    expect(harness.reorder).not.toHaveBeenCalled()
  })
})
