import { expect, test, type Locator, type Page } from '@playwright/test'

// 页签拖拽排序：文件页签与项目页签共用指针拖拽控制器（tab-drag.ts）。
// reducedMotion 让换位后的布局与滚动稳定，断言读取的是落定状态。
test.use({ viewport: { width: 960, height: 680 }, reducedMotion: 'reduce' })

async function readEditorTabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="编辑器标签页"]',
    )
    return Array.from(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).map(
      (el) => el.textContent ?? '',
    )
  })
}

async function readProjectTabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tabs = document.querySelectorAll<HTMLElement>('header [role="tab"]')
    return Array.from(tabs).map((el) => el.textContent?.trim() ?? '')
  })
}

async function dragTab(page: Page, source: Locator, target: Locator): Promise<void> {
  const s = await source.boundingBox()
  const t = await target.boundingBox()
  if (!s || !t) throw new Error('tab bounding boxes unavailable')
  const startX = s.x + s.width / 2
  const y = s.y + s.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  // 分步移动以越过拖拽启动阈值，终点略过目标页签中线保证换位。
  await page.mouse.move(t.x + t.width / 2 + 12, y, { steps: 10 })
  await page.mouse.up()
}

test('editor tabs reorder by drag and keep the active selection', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // 依次打开三个文件，页签按打开顺序排列。
  await page.getByRole('treeitem', { name: 'README.md' }).click()
  await page.getByRole('treeitem', { name: 'package.json' }).click()
  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'kernel.ts' }).click()
  await expect(page.getByRole('tab', { name: 'kernel.ts' })).toBeVisible()
  expect(await readEditorTabOrder(page)).toEqual(['README.md', 'package.json', 'kernel.ts'])

  // 把第一个页签拖到最后一个页签之后：顺序重排，选中文件保持不变。
  await dragTab(
    page,
    page.getByRole('tab', { name: 'README.md' }),
    page.getByRole('tab', { name: 'kernel.ts' }),
  )
  await expect.poll(() => readEditorTabOrder(page)).toEqual([
    'package.json',
    'kernel.ts',
    'README.md',
  ])
  await expect(page.getByRole('tab', { name: 'kernel.ts' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.screenshot({ path: testInfo.outputPath('editor-tabs-reordered.png'), animations: 'disabled' })

  // 拖拽不吞点击：落位后点 README.md 仍能正常激活。
  await page.getByRole('tab', { name: 'README.md' }).click()
  await expect(page.getByRole('tab', { name: 'README.md' })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  expect(consoleErrors).toEqual([])
})

test('project tabs reorder by drag and persist the new order', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await expect(page.locator('header [role="tab"]')).toHaveCount(2)
  expect(await readProjectTabOrder(page)).toEqual(['lite-ide-demo', 'rust-core-sample'])

  await dragTab(
    page,
    page.getByRole('tab', { name: 'lite-ide-demo' }),
    page.getByRole('tab', { name: 'rust-core-sample' }),
  )
  await expect.poll(() => readProjectTabOrder(page)).toEqual(['rust-core-sample', 'lite-ide-demo'])
  await page.screenshot({ path: testInfo.outputPath('project-tabs-reordered.png'), animations: 'disabled' })

  // 重排即时持久化（尾随去抖 ≤120ms）：会话恢复按新顺序还原。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored: unknown = JSON.parse(
          localStorage.getItem('lite-ide.openProjects.v1') ?? '[]',
        )
        return (Array.isArray(stored) ? stored : []).map((p: string) =>
          p.split('/').filter(Boolean).pop(),
        )
      }),
    )
    .toEqual(['rust-core-sample', 'lite-ide-demo'])

  expect(consoleErrors).toEqual([])
})

test('drag released outside the strip leaves no stuck state', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('treeitem', { name: 'README.md' }).click()
  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'kernel.ts' }).click()
  await expect(page.getByRole('tab', { name: 'kernel.ts' })).toBeVisible()

  // 拖起 README.md 后纵向拖出页签条再松手（常见取消手势）：
  // 不应换位，也不应留下卡死的拖拽状态（capture 兜底必须生效）。
  const source = await page.getByRole('tab', { name: 'README.md' }).boundingBox()
  if (!source) throw new Error('tab bounding box unavailable')
  const startX = source.x + source.width / 2
  const startY = source.y + source.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 40, startY + 140, { steps: 8 })
  await page.mouse.up()

  expect(await readEditorTabOrder(page)).toEqual(['README.md', 'kernel.ts'])
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe('')
  await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).toBe('')

  // 控制器未卡死：后续点击正常激活，再次正常拖拽仍可换位。
  await page.getByRole('tab', { name: 'kernel.ts' }).click()
  await expect(page.getByRole('tab', { name: 'kernel.ts' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const kernel = await page.getByRole('tab', { name: 'kernel.ts' }).boundingBox()
  const readme = await page.getByRole('tab', { name: 'README.md' }).boundingBox()
  if (!kernel || !readme) throw new Error('tab bounding boxes unavailable')
  const y = kernel.y + kernel.height / 2
  await page.mouse.move(kernel.x + kernel.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(readme.x + readme.width / 2 - 12, y, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => readEditorTabOrder(page)).toEqual(['kernel.ts', 'README.md'])
  await page.screenshot({ path: testInfo.outputPath('after-aborted-drag.png'), animations: 'disabled' })

  expect(consoleErrors).toEqual([])
})
