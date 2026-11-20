import { expect, test, type Page } from '@playwright/test'

// Settings dialog + multi-theme switching acceptance (mock demo project).
const THEME_STORAGE_KEY = 'lite-ide.theme.v1'
const SOLARIZED_EDITOR_BG = 'rgb(253, 246, 227)' // --bg-editor #FDF6E3

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

const themeState = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    light: document.documentElement.classList.contains('light'),
  }))

test('gear button and Ctrl+, open the settings dialog; Escape, ✕ and backdrop close it', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.getByRole('button', { name: 'Open Settings' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Contributed sections show up in the dialog navigation.
  await expect(dialog.getByRole('button', { name: '外观' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('settings-dialog.png'), animations: 'disabled' })

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.keyboard.press('Control+,')
  await expect(dialog).toBeVisible()
  await dialog.getByTitle('关闭').click()
  await expect(dialog).toBeHidden()

  // Reopen and click the backdrop itself (viewport corner, outside the panel).
  await page.keyboard.press('Control+,')
  await expect(dialog).toBeVisible()
  await page.mouse.click(12, 12)
  await expect(dialog).toBeHidden()

  expect(consoleErrors).toEqual([])
})

test('appearance section switches all three themes and persists across reload', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // Fresh profile boots into the dark theme.
  expect(await themeState(page)).toEqual({ theme: 'dark', dark: true, light: false })

  await dialog.getByRole('button', { name: '浅色' }).click()
  expect(await themeState(page)).toEqual({ theme: 'light', dark: false, light: true })
  await page.screenshot({ path: testInfo.outputPath('theme-light.png'), animations: 'disabled' })

  await dialog.getByRole('button', { name: 'Solarized Light' }).click()
  expect(await themeState(page)).toEqual({ theme: 'solarized-light', dark: false, light: true })
  expect(await page.evaluate((k) => localStorage.getItem(k), THEME_STORAGE_KEY)).toBe(
    'solarized-light',
  )
  await page.screenshot({
    path: testInfo.outputPath('theme-solarized-light.png'),
    animations: 'disabled',
  })

  // Reload: the FOUC bootstrap script must restore the stored theme.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  expect(await themeState(page)).toEqual({ theme: 'solarized-light', dark: false, light: true })

  expect(consoleErrors).toEqual([])
})

test('code editor renders CodeMirror with the Solarized palette under solarized-light', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.addInitScript((k) => localStorage.setItem(k, 'solarized-light'), THEME_STORAGE_KEY)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.getByRole('treeitem', { name: 'src' }).click()
  const file = page.getByRole('treeitem', { name: 'kernel.ts' })
  await expect(file).toBeVisible()
  await file.click()

  const editor = page.locator('.cm-editor')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveCSS('background-color', SOLARIZED_EDITOR_BG)
  await page.screenshot({
    path: testInfo.outputPath('solarized-code-preview.png'),
    animations: 'disabled',
  })

  expect(consoleErrors).toEqual([])
})
