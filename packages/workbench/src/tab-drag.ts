import { createSignal, onCleanup, type Accessor } from 'solid-js'

/** 拖拽启动位移阈值（px）：位移小于该值按点击处理，不进入拖拽。 */
export const TAB_DRAG_START_THRESHOLD_PX = 6

/** 拖拽接近页签条左右边缘时的自动滚动热区宽度（px）。 */
export const TAB_DRAG_EDGE_SCROLL_ZONE_PX = 36

/** 指针纵向偏离页签条的容差（px）：超出即冻结换位与边缘滚动（视为取消手势）。 */
export const TAB_DRAG_Y_TOLERANCE_PX = 12

/**
 * 计算插入位（0..mids.length，「插到第 i 个页签之前」语义）：
 * 指针越过某页签中线即视为插到该页签之前。
 */
export function computeInsertIndex(mids: readonly number[], clientX: number): number {
  for (let i = 0; i < mids.length; i += 1) {
    if (clientX < mids[i]) return i
  }
  return mids.length
}

/** 把插入位换算为最终落位下标（splice 移动语义：先摘除再插入）。 */
export function resolveMoveIndex(fromIndex: number, insertIndex: number): number {
  return insertIndex > fromIndex ? insertIndex - 1 : insertIndex
}

export interface TabDragReorderOptions {
  /** 页签条滚动容器：命中检测与边缘自动滚动的参照。 */
  getStrip: () => HTMLElement | undefined
  /** 换位回调：fromIndex 为当前下标，toIndex 为目标落位（splice 语义）。 */
  reorder: (fromIndex: number, toIndex: number) => void
}

export interface TabDragReorder {
  /** 正被拖拽页签的 id；未拖拽时为 null。 */
  readonly draggingId: Accessor<string | null>
  /** 页签根元素需绑定的事件处理器（含拖拽结束后的误点抑制）。 */
  tabHandlers(id: string): {
    onPointerDown: (e: PointerEvent) => void
    onPointerMove: (e: PointerEvent) => void
    onPointerUp: (e: PointerEvent) => void
    onPointerCancel: (e: PointerEvent) => void
    onClickCapture: (e: MouseEvent) => void
  }
}

/**
 * 横向页签条的指针拖拽排序控制器，供项目页签与文件页签共用。
 *
 * 行为约定：按下即捕获指针（快速拖动不丢事件）；位移越过阈值才进入拖拽，
 * 其余情况保持原生点击/中键关闭/右键菜单；拖拽中按页签中线实时换位，
 * 指针纵向拖出页签条则冻结换位（取消手势），接近左右边缘时自动横向滚动；
 * 真实拖拽结束的 click 被捕获拦截，避免落位时误触发页签激活。
 */
export function createTabDragReorder(options: TabDragReorderOptions): TabDragReorder {
  const [draggingId, setDraggingId] = createSignal<string | null>(null)

  let pressEl: HTMLElement | undefined
  let pressId: string | null = null
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let lastClientX = 0
  let lastClientY = 0
  let scrollFrame = 0
  // 真实拖拽刚结束时置位：pointerup 之后同步派发的 click 会被捕获拦截。
  let suppressClick = false

  function stopScrollLoop() {
    if (scrollFrame) {
      cancelAnimationFrame(scrollFrame)
      scrollFrame = 0
    }
  }

  function releaseCapture() {
    if (!pressEl || pointerId === null) return
    try {
      if (pressEl.hasPointerCapture?.(pointerId)) {
        pressEl.releasePointerCapture(pointerId)
      }
    } catch {
      // jsdom / 旧环境无 pointer capture，忽略。
    }
  }

  function capturePointer() {
    if (!pressEl || pointerId === null) return
    try {
      pressEl.setPointerCapture?.(pointerId)
    } catch {
      // jsdom / 旧环境无 pointer capture，忽略。
    }
  }

  // 兜底监听：换位导致的隐式捕获释放或指针落在页签之外时，up/cancel
  // 仍能结束拖拽，避免 pointerId 卡死、样式残留与滚动循环失控。
  function handleWindowPointerEnd(e: PointerEvent) {
    if (pointerId === null || e.pointerId !== pointerId) return
    endDrag()
  }

  function handleWindowBlur() {
    if (pointerId === null) return
    endDrag()
  }

  function armWindowFallback() {
    window.addEventListener('pointerup', handleWindowPointerEnd)
    window.addEventListener('pointercancel', handleWindowPointerEnd)
    window.addEventListener('blur', handleWindowBlur)
  }

  function disarmWindowFallback() {
    window.removeEventListener('pointerup', handleWindowPointerEnd)
    window.removeEventListener('pointercancel', handleWindowPointerEnd)
    window.removeEventListener('blur', handleWindowBlur)
  }

  function endDrag() {
    disarmWindowFallback()
    stopScrollLoop()
    releaseCapture()
    pressEl = undefined
    pressId = null
    pointerId = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    if (draggingId() !== null) {
      setDraggingId(null)
      // click 紧随 pointerup 同步派发；异步复位以免吞掉后续正常点击。
      suppressClick = true
      setTimeout(() => {
        suppressClick = false
      }, 0)
    }
  }

  function updateDrag(clientX: number, clientY: number) {
    const strip = options.getStrip()
    if (!strip || !pressEl) return
    const stripRect = strip.getBoundingClientRect()
    // 指针纵向拖出页签条（取消手势）：冻结换位与边缘滚动，等待松手复位。
    if (
      clientY < stripRect.top - TAB_DRAG_Y_TOLERANCE_PX ||
      clientY > stripRect.bottom + TAB_DRAG_Y_TOLERANCE_PX
    ) {
      return
    }
    // 页签条溢出时，指针停在左右热区内则持续滚动，支持拖到可视范围外的落点。
    let inScrollZone = false
    if (strip.scrollWidth > strip.clientWidth) {
      if (clientX < stripRect.left + TAB_DRAG_EDGE_SCROLL_ZONE_PX) {
        strip.scrollLeft -= Math.max(4, Math.ceil(stripRect.left + TAB_DRAG_EDGE_SCROLL_ZONE_PX - clientX))
        inScrollZone = true
      } else if (clientX > stripRect.right - TAB_DRAG_EDGE_SCROLL_ZONE_PX) {
        strip.scrollLeft += Math.max(4, Math.ceil(clientX - (stripRect.right - TAB_DRAG_EDGE_SCROLL_ZONE_PX)))
        inScrollZone = true
      }
    }

    // 命中检测：按 DOM 顺序取全部页签中线，求指针应插入的位置。
    const els = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-drag-id]'))
    const mids = els.map((el) => {
      const rect = el.getBoundingClientRect()
      return rect.left + rect.width / 2
    })
    const fromIndex = els.indexOf(pressEl)
    if (fromIndex !== -1) {
      const toIndex = resolveMoveIndex(fromIndex, computeInsertIndex(mids, clientX))
      if (toIndex !== fromIndex) {
        options.reorder(fromIndex, toIndex)
        // <For> 换位会移动被捕获节点并触发隐式捕获释放，同步重设。
        capturePointer()
      }
    }

    if (inScrollZone && !scrollFrame && typeof requestAnimationFrame === 'function') {
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0
        updateDrag(lastClientX, lastClientY)
      })
    }
  }

  function handlePointerDown(e: PointerEvent, id: string) {
    // 仅主键发起拖拽；同一指针已在拖拽流程中时不重复接管（多点触控防串）。
    if (e.button !== 0 || pointerId !== null) return
    if ((e.target as HTMLElement | null)?.closest?.('button')) return
    suppressClick = false
    pointerId = e.pointerId
    pressId = id
    startX = e.clientX
    startY = e.clientY
    lastClientX = e.clientX
    lastClientY = e.clientY
    pressEl = e.currentTarget as HTMLElement
    // 立即捕获指针：后续 move/up 全部派发到按下页签，快速拖动不丢事件。
    capturePointer()
    armWindowFallback()
  }

  function handlePointerMove(e: PointerEvent) {
    if (pointerId === null || e.pointerId !== pointerId) return
    if (draggingId() === null) {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.hypot(dx, dy) < TAB_DRAG_START_THRESHOLD_PX) return
      // 越过阈值才真正进入拖拽：期间禁止文本选中并给出拖拽光标。
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'grabbing'
      setDraggingId(pressId)
    }
    lastClientX = e.clientX
    lastClientY = e.clientY
    updateDrag(e.clientX, e.clientY)
  }

  function handlePointerUp(e: PointerEvent) {
    if (pointerId === null || e.pointerId !== pointerId) return
    endDrag()
  }

  function handleClickCapture(e: MouseEvent) {
    if (!suppressClick) return
    e.preventDefault()
    e.stopPropagation()
  }

  onCleanup(() => {
    disarmWindowFallback()
    stopScrollLoop()
    if (pointerId !== null) {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    pressEl = undefined
    pressId = null
    pointerId = null
  })

  return {
    draggingId,
    tabHandlers(id: string) {
      return {
        onPointerDown: (e) => handlePointerDown(e, id),
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerUp,
        onClickCapture: handleClickCapture,
      }
    },
  }
}
