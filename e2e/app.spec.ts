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
  await expect(menu.getByText('Copy Path')).toBeVisible()
  await expect(menu.getByText('Copy Relative Path')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('explorer-menu.png'), animations: 'disabled' })

  await menu.getByText('Copy Relative Path').click()
  expect(await readClipboard(page)).toBe(REL_PATH)

  await openExplorerContextMenu(page)
  await page.getByRole('menu').getByText('Copy Path', { exact: true }).click()
  expect(await readClipboard(page)).toBe(ABS_PATH)

  // --- Editor tab context menu ----------------------------------------------
  await page.getByRole('treeitem', { name: FILE_NAME }).click()
  const tab = page.getByRole('tab', { name: FILE_NAME })
  await expect(tab).toBeVisible()

  await tab.click({ button: 'right' })
  const tabMenu = page.getByRole('menu')
  await expect(tabMenu.getByText('Close All')).toBeVisible()
  await expect(tabMenu.getByText('Copy Path', { exact: true })).toBeVisible()
  await expect(tabMenu.getByText('Copy Relative Path')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('tab-menu.png'), animations: 'disabled' })

  await tabMenu.getByText('Copy Path', { exact: true }).click()
  expect(await readClipboard(page)).toBe(ABS_PATH)

  await tab.click({ button: 'right' })
  await page.getByRole('menu').getByText('Copy Relative Path').click()
  expect(await readClipboard(page)).toBe(REL_PATH)

  expect(consoleErrors).toEqual([])
})
