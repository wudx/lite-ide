import { expect, test, type Page } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage.
const ROOT_PATH = '/workspace/lite-ide-demo'
const FILE_NAME = 'README.md'
const REL_PATH = 'README.md'
const ABS_PATH = `${ROOT_PATH}/${REL_PATH}`

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText())
}

async function openExplorerContextMenu(page: Page): Promise<void> {
  const row = page.getByRole('treeitem', { name: FILE_NAME })
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
}

test('explorer and editor-tab context menus copy absolute and relative paths', async ({
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

  // --- Explorer context menu ------------------------------------------------
  await openExplorerContextMenu(page)
  const menu = page.getByRole('menu')
  await expect(menu.getByText('复制路径')).toBeVisible()
  await expect(menu.getByText('复制相对路径')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('explorer-menu.png'), animations: 'disabled' })

  await menu.getByText('复制相对路径').click()
  expect(await readClipboard(page)).toBe(REL_PATH)

  await openExplorerContextMenu(page)
  await page.getByRole('menu').getByText('复制路径', { exact: true }).click()
  expect(await readClipboard(page)).toBe(ABS_PATH)

  // --- Reveal in file manager: file rows -------------------------------------
  // Mock 模式下该动作为安全空操作，只验证菜单项渲染与点击后菜单关闭。
  await openExplorerContextMenu(page)
  const revealMenu = page.getByRole('menu')
  await expect(revealMenu.getByText('在文件管理器中打开')).toBeVisible()
  await revealMenu.getByText('在文件管理器中打开').click()
  await expect(page.getByRole('menu')).toBeHidden()

  // --- Reveal in file manager: directory rows --------------------------------
  const dirRow = page.getByRole('treeitem', { name: 'src' })
  await expect(dirRow).toBeVisible()
  await dirRow.click({ button: 'right' })
  const dirMenu = page.getByRole('menu')
  await expect(dirMenu.getByText('在文件管理器中打开')).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('explorer-dir-menu.png'),
    animations: 'disabled',
  })
  await dirMenu.getByText('在文件管理器中打开').click()
  await expect(page.getByRole('menu')).toBeHidden()

  // --- Editor tab context menu ----------------------------------------------
  await page.getByRole('treeitem', { name: FILE_NAME }).click()
  const tab = page.getByRole('tab', { name: FILE_NAME })
  await expect(tab).toBeVisible()

  await tab.click({ button: 'right' })
  const tabMenu = page.getByRole('menu')
  await expect(tabMenu.getByText('全部关闭')).toBeVisible()
  await expect(tabMenu.getByText('复制路径', { exact: true })).toBeVisible()
  await expect(tabMenu.getByText('复制相对路径')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('tab-menu.png'), animations: 'disabled' })

  await tabMenu.getByText('复制路径', { exact: true }).click()
  expect(await readClipboard(page)).toBe(ABS_PATH)

  await tab.click({ button: 'right' })
  await page.getByRole('menu').getByText('复制相对路径').click()
  expect(await readClipboard(page)).toBe(REL_PATH)

  expect(consoleErrors).toEqual([])
})

test('deactivated editor tab loses its border card immediately on switch', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Open two files so both editor tabs exist, then make the first one active.
  await page.getByRole('treeitem', { name: 'package.json' }).click()
  await page.getByRole('treeitem', { name: FILE_NAME }).click()
  await expect(page.getByRole('tab', { name: FILE_NAME })).toBeVisible()
  await page.getByRole('tab', { name: FILE_NAME }).click()
  await page.waitForTimeout(300) // let the activation transition settle

  // Switch away: the old tab must drop its 1px border card and inset shadow
  // on the very next frame — only colors may keep fading (no ghost outline).
  await page.getByRole('tab', { name: 'package.json' }).click()
  const oldTabStyle = await page.getByRole('tab', { name: FILE_NAME }).evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      borderTopWidth: s.borderTopWidth,
      borderLeftWidth: s.borderLeftWidth,
      boxShadow: s.boxShadow,
      transitionProperty: s.transitionProperty,
    }
  })
  // Only colors may keep fading; geometry (border width) and shadow must snap.
  expect(oldTabStyle.transitionProperty).not.toContain('all')
  expect(oldTabStyle.transitionProperty).not.toContain('box-shadow')
  expect(parseFloat(oldTabStyle.borderTopWidth)).toBe(0)
  expect(parseFloat(oldTabStyle.borderLeftWidth)).toBe(0)
  expect(oldTabStyle.boxShadow).toBe('none')

  await page.screenshot({ path: testInfo.outputPath('tab-switched.png'), animations: 'disabled' })
})

test('empty preview page hints Ctrl+P and double-clicking it creates an untitled file', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  // Boot: mock backend auto-opens the demo projects with no file selected, so
  // the preview pane shows the empty state with its shortcut hints. The hidden
  // warm project is display:none, so getByRole only sees the active one.
  await page.goto('/')
  const emptyPane = page.getByRole('button', { name: '双击空白处新建未命名文件' })
  await expect(emptyPane).toBeVisible()
  await expect(emptyPane.locator('kbd', { hasText: 'Ctrl+P' })).toBeVisible()
  await expect(emptyPane.getByText('快速打开文件')).toBeVisible()
  await expect(emptyPane.getByText('双击空白处新建未命名文件')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('empty-preview.png'), animations: 'disabled' })

  // A single click must NOT create anything; only a double-click on the empty
  // preview page creates a new untitled file, like the "+" button of an open
  // tab strip.
  await emptyPane.click()
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toHaveCount(0)

  await emptyPane.dblclick()
  await expect(page.getByRole('tab', { name: 'Untitled-1' })).toBeVisible()
  await expect(emptyPane).toBeHidden()

  expect(consoleErrors).toEqual([])
})

test('suppresses browser context menu globally including git stash and diff views', async ({
  page,
}) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Install a bubble-phase observer on window after WorkbenchShell mounts so we
  // see the final `defaultPrevented` state for every contextmenu event.
  await page.evaluate(() => {
    const events: Array<{ defaultPrevented: boolean; tag: string | null }> = []
    ;(window as unknown as { __contextMenuEvents: typeof events }).__contextMenuEvents = events
    window.addEventListener('contextmenu', (e) => {
      events.push({
        defaultPrevented: e.defaultPrevented,
        tag: e.target instanceof Element ? e.target.tagName : null,
      })
    })
  })

  const readRecordedEvents = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __contextMenuEvents: Array<{ defaultPrevented: boolean; tag: string | null }>
          }
        ).__contextMenuEvents,
    )

  // 1. Empty preview pane
  const emptyPane = page.getByRole('button', { name: '双击空白处新建未命名文件' })
  await expect(emptyPane).toBeVisible()
  await emptyPane.click({ button: 'right' })
  let events = await readRecordedEvents()
  expect(events).toHaveLength(1)
  expect(events[0].defaultPrevented).toBe(true)

  // 2. Git stash section
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-branch-name')).toHaveText('main')
  const stashSection = page.getByTestId('git-stash-section')
  await expect(stashSection).toBeVisible()
  await stashSection.click({ button: 'right' })
  events = await readRecordedEvents()
  expect(events).toHaveLength(2)
  expect(events[1].defaultPrevented).toBe(true)

  // 3. Git diff preview area
  const stagedRow = page.locator('[data-git-section="staged"][data-git-path="README.md"]')
  await stagedRow.click()
  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView.locator('[data-git-diff-kind="add"]')).toBeVisible()
  await diffView.click({ button: 'right' })
  events = await readRecordedEvents()
  expect(events).toHaveLength(3)
  expect(events[2].defaultPrevented).toBe(true)

  // 4. Git commit message textarea
  const commitInput = page.getByPlaceholder('输入提交信息 (Ctrl+Enter 提交)')
  await expect(commitInput).toBeVisible()
  await commitInput.click({ button: 'right' })
  events = await readRecordedEvents()
  expect(events).toHaveLength(4)
  expect(events[3]).toEqual({ defaultPrevented: true, tag: 'TEXTAREA' })

  // Custom context menus still open and remain unaffected.
  await stagedRow.click({ button: 'right' })
  await expect(page.getByTestId('git-context-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('git-context-menu')).toBeHidden()

  await page.getByRole('button', { name: '资源管理器', exact: true }).click()
  await openExplorerContextMenu(page)
  await expect(page.getByRole('menu')).toBeVisible()

  expect(consoleErrors).toEqual([])
})
