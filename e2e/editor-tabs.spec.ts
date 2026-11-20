import { expect, test, type Page } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage. The
// viewport is narrowed so a handful of tabs overflow the editor tab strip,
// mirroring the "many open files" scenario without needing dozens of tabs.
test.use({ viewport: { width: 960, height: 680 } })

interface StripMetrics {
  overflow: boolean
  scrollLeft: number
  activeTab: string
  activeTabVisible: boolean
}

async function readStrip(page: Page): Promise<StripMetrics> {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="编辑器标签页"]',
    )
    if (!strip) return { overflow: false, scrollLeft: 0, activeTab: '', activeTabVisible: false }
    const active = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    const stripRect = strip.getBoundingClientRect()
    const tabRect = active?.getBoundingClientRect()
    return {
      overflow: strip.scrollWidth > strip.clientWidth,
      scrollLeft: strip.scrollLeft,
      activeTab: active?.textContent ?? '',
      activeTabVisible:
        !!tabRect && tabRect.left >= stripRect.left - 1 && tabRect.right <= stripRect.right + 1,
    }
  })
}

test('tab strip scrolls newly opened tabs into view when overflowing', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  // Boot: mock backend auto-opens the demo projects and shows the explorer tree.
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Open every text file of the demo project; each appends a tab at the end.
  await page.getByRole('treeitem', { name: 'README.md' }).click()
  await page.getByRole('treeitem', { name: 'package.json' }).click()
  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'kernel.ts' }).click()
  await page.getByRole('treeitem', { name: 'App.tsx' }).click()
  await expect(page.getByRole('tab', { name: 'App.tsx' })).toBeVisible()

  // Keep creating untitled tabs until the strip overflows horizontally.
  const plus = page.getByTitle('新建未命名文件')
  for (let i = 0; i < 8; i++) {
    if (await readStrip(page).then((m) => m.overflow)) break
    await plus.click()
  }
  await expect
    .poll(() => readStrip(page).then((m) => m.overflow), 'tab strip should overflow horizontally')
    .toBe(true)

  // The just-opened active tab sits past the visible width: it must have been
  // scrolled into view instead of staying hidden beyond the strip edge.
  await expect
    .poll(() => readStrip(page).then((m) => m.activeTabVisible), 'active tab should be visible')
    .toBe(true)
  await expect
    .poll(() => readStrip(page).then((m) => m.scrollLeft), 'strip should scroll towards the end')
    .toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('tabs-revealed.png'), animations: 'disabled' })

  // Re-activating the first tab from the explorer scrolls back to it.
  await page.getByRole('treeitem', { name: 'README.md' }).click()
  await expect
    .poll(() => readStrip(page).then((m) => m.activeTab), 'first tab should be re-activated')
    .toContain('README.md')
  await expect
    .poll(() => readStrip(page).then((m) => m.activeTabVisible), 'first tab should be visible')
    .toBe(true)

  // Keyboard navigation onto the last (off-screen) tab reveals it as well.
  const tabs = page.getByRole('tablist', { name: '编辑器标签页' }).getByRole('tab')
  const tabCount = await tabs.count()
  const lastTabName = (await tabs.last().textContent()) ?? ''
  for (let i = 1; i < tabCount; i++) await page.keyboard.press('Control+PageDown')
  await expect
    .poll(() => readStrip(page).then((m) => m.activeTab), 'last tab should be keyboard-activated')
    .toContain(lastTabName)
  await expect
    .poll(
      () => readStrip(page).then((m) => m.activeTabVisible),
      'keyboard-activated tab should be visible',
    )
    .toBe(true)

  expect(consoleErrors).toEqual([])
})
