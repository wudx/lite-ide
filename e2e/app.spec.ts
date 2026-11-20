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
