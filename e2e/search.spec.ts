import { expect, test, type Page } from '@playwright/test'

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

test('Ctrl+Shift+F searches across files and jumps to exact match line', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const workspace = page.locator('section[data-active="true"]')
  await page.keyboard.press('ControlOrMeta+Shift+F')
  const searchInput = workspace.getByTestId('search-query-input')
  await expect(searchInput).toBeVisible()
  await expect(searchInput).toBeFocused()

  await searchInput.fill('createServiceKey')
  await expect(workspace.getByTestId('search-summary')).toHaveText('3 个文件中有 6 个结果')
  await expect(workspace.getByTestId('search-file-src/kernel.ts')).toBeVisible()
  await expect(workspace.getByTestId('search-file-src/long-reference.ts')).toBeVisible()
  await expect(workspace.getByTestId('search-file-src/services.ts')).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath('search-results.png'), animations: 'disabled' })

  // Click the line-100 match in src/long-reference.ts and verify editor opens and jumps there.
  await workspace.getByTestId('search-match-src/long-reference.ts:100:27').click()
  await expect(workspace.getByRole('tab', { name: 'long-reference.ts' })).toBeVisible()
  await expect(workspace.locator('.cm-content .cm-line').first()).toBeVisible()
  await expect(page.locator('footer')).toContainText('第 100 行')

  expect(consoleErrors).toEqual([])
})

test('supports case/whole-word/regex toggles, invalid regex error, and Find in Folder from explorer', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const workspace = page.locator('section[data-active="true"]')

  // Wait for the search plugin tab to finish registering before opening Explorer's context menu.
  await expect(workspace.getByRole('button', { name: '查找', exact: true })).toBeVisible()

  // Trigger "在文件夹中查找" from Explorer context menu on `src`.
  await workspace.getByRole('treeitem', { name: 'src' }).click({ button: 'right' })
  await page.getByRole('menu').getByText('在文件夹中查找').click()

  const searchInput = workspace.getByTestId('search-query-input')
  await expect(searchInput).toBeVisible()
  await expect(workspace.getByTestId('search-include-input')).toHaveValue('src/')

  await searchInput.fill('Store')
  await expect(workspace.getByTestId('search-summary')).toBeVisible()

  // Toggle Case Sensitive + Whole Word: `Store` only matches whole word case-sensitively if present.
  await workspace.getByTestId('search-toggle-case').click()
  await workspace.getByTestId('search-toggle-whole-word').click()
  await expect(workspace.getByTestId('search-summary')).toHaveText('未找到结果。')

  // Clear whole word, keep case sensitive for `FileStore`.
  await workspace.getByTestId('search-toggle-whole-word').click()
  await searchInput.fill('FileStore')
  await expect(workspace.getByTestId('search-file-src/services.ts')).toBeVisible()

  // Invalid regex displays inline error.
  await workspace.getByTestId('search-toggle-regex').click()
  await searchInput.fill('[unclosed')
  await expect(workspace.getByText(/正则表达式无效/)).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('search-regex-error.png'),
    animations: 'disabled',
  })

  expect(consoleErrors).toEqual([])
})

test('Ctrl+Shift+H previews and replaces matches across files including open editor tabs', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const workspace = page.locator('section[data-active="true"]')

  // Open src/kernel.ts in the active editor tab BEFORE replacing across files.
  await workspace.getByRole('treeitem', { name: 'src' }).click()
  await workspace.getByRole('treeitem', { name: 'kernel.ts' }).click()
  await expect(workspace.getByRole('tab', { name: 'kernel.ts' })).toBeVisible()
  await expect(workspace.locator('.cm-content')).toContainText('activateDemo')

  await page.keyboard.press('ControlOrMeta+Shift+H')
  const searchInput = workspace.getByTestId('search-query-input')
  const replaceInput = workspace.getByTestId('search-replace-input')
  await expect(searchInput).toBeVisible()
  await expect(replaceInput).toBeVisible()

  await searchInput.fill('activateDemo')
  await expect(workspace.getByTestId('search-summary')).toHaveText('1 个文件中有 1 个结果')
  await replaceInput.fill('bootDemo')

  const matchRow = workspace.getByTestId('search-match-src/kernel.ts:10:17')
  const previewSpan = matchRow.getByText('bootDemo', { exact: true })
  await expect(previewSpan).toBeVisible()
  const overflowed = await matchRow.evaluate((el) => {
    const snippetSpan = el.querySelector<HTMLElement>('span.truncate')
    return snippetSpan ? snippetSpan.scrollWidth > snippetSpan.clientWidth + 1 : true
  })
  expect(overflowed).toBe(false)

  await page.screenshot({
    path: testInfo.outputPath('search-replace-preview.png'),
    animations: 'disabled',
  })

  await workspace.getByTestId('search-replace-all').click()
  const confirmDialog = page.getByRole('dialog', { name: '确认全部替换' })
  await expect(confirmDialog).toBeVisible()
  await confirmDialog.getByRole('button', { name: '全部替换' }).click()

  await expect(workspace.getByTestId('search-summary')).toHaveText('未找到结果。')

  // The already-open editor tab must immediately display the replaced content and stay saved.
  await expect(workspace.locator('.cm-content')).toContainText('bootDemo')
  await expect(workspace.locator('.cm-content')).not.toContainText('activateDemo')
  await expect(workspace.getByText('已保存')).toBeVisible()

  expect(consoleErrors).toEqual([])
})
