import { expect, test, type Page } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage.
const DIALOG = '快速打开'
const INPUT = '按名称搜索文件…'

async function trackConsoleErrors(page: Page): Promise<string[]> {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  return consoleErrors
}

async function openQuickOpen(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p')
  await expect(page.getByRole('dialog', { name: DIALOG })).toBeVisible()
}

test('Ctrl+P quick open searches files by name and opens one via Enter', async ({
  page,
}, testInfo) => {
  const consoleErrors = await trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await openQuickOpen(page)
  const dialog = page.getByRole('dialog', { name: DIALOG })
  await expect(dialog.getByPlaceholder(INPUT)).toBeFocused()
  // Empty query lists the project files instead of nothing.
  await expect(dialog.getByRole('option').first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('quick-open-empty.png'), animations: 'disabled' })

  await page.keyboard.type('kernel')
  const result = dialog.getByRole('option').filter({ hasText: 'kernel.ts' })
  await expect(result).toHaveCount(1)
  await expect(result).toHaveAttribute('data-rel-path', 'src/kernel.ts')
  await page.screenshot({ path: testInfo.outputPath('quick-open-search.png'), animations: 'disabled' })

  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'kernel.ts' })).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('quick open highlights matches, navigates with arrows, and closes on Escape', async ({
  page,
}, testInfo) => {
  const consoleErrors = await trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await openQuickOpen(page)
  const dialog = page.getByRole('dialog', { name: DIALOG })
  const options = dialog.getByRole('option')
  await expect(options.first()).toBeVisible()

  // Arrow navigation moves the aria-selected highlight and wraps around.
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(options.last()).toHaveAttribute('aria-selected', 'true')

  await page.screenshot({ path: testInfo.outputPath('quick-open-navigate.png'), animations: 'disabled' })

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  expect(consoleErrors).toEqual([])
})

test('quick open opens a file via mouse click and shows the empty state', async ({
  page,
}, testInfo) => {
  const consoleErrors = await trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await openQuickOpen(page)
  const dialog = page.getByRole('dialog', { name: DIALOG })

  await page.keyboard.type('readme')
  const result = dialog.getByRole('option').filter({ hasText: 'README.md' })
  await expect(result).toHaveCount(1)
  await result.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('tab', { name: 'README.md' })).toBeVisible()

  // Query that matches nothing in the active project shows the empty state.
  await openQuickOpen(page)
  await page.keyboard.type('zzzznope')
  await expect(dialog.getByText('无匹配文件')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('quick-open-empty-state.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  expect(consoleErrors).toEqual([])
})
