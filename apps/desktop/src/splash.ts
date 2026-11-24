/**
 * 等待若干个动画帧，确保响应式更新完成真实 DOM 绘制后再撤掉启动画面。
 */
export function waitForNextFrames(count = 2): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let remaining = Math.max(1, count)
    const step = () => {
      remaining -= 1
      if (remaining <= 0) {
        resolve()
      } else {
        requestAnimationFrame(step)
      }
    }
    requestAnimationFrame(step)
  })
}

/**
 * 淡出并移除首屏 `#app-splash` 遮罩；若页面上不存在则静默跳过。
 */
export function dismissSplash(doc: Document = document): void {
  const splash = doc.getElementById('app-splash')
  if (!splash) return

  let removed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = () => {
    if (removed) return
    removed = true
    if (timer !== undefined) clearTimeout(timer)
    splash.removeEventListener('transitionend', cleanup)
    splash.remove()
  }

  splash.addEventListener('transitionend', cleanup, { once: true })
  splash.classList.add('is-ready')
  // 兜底：若浏览器禁用过渡动画（如 prefers-reduced-motion 或 headless 测试），确保节点被清理。
  timer = setTimeout(cleanup, 260)
}
