import { expect, test, type Page } from '@playwright/test'

// Settings dialog + multi-theme switching acceptance (mock demo project).
const THEME_STORAGE_KEY = 'lite-ide.theme.v1'
const EXCLUDE_STORAGE_KEY = 'lite-ide.explorer.exclude.v1'
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

test('appearance section switches the three built-in themes and persists across reload', async ({
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

test('plugin-contributed Nord theme appears in settings, applies inline variables and persists', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // The theme-nord plugin contributes a 4th entry to the appearance grid.
  const nordButton = dialog.getByRole('button', { name: 'Nord 深色' })
  await expect(nordButton).toBeVisible()
  await nordButton.click()

  // Selecting it flips data-theme + dark class and injects the contributed
  // variables as inline styles overriding app.css :root defaults.
  const nordState = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    light: document.documentElement.classList.contains('light'),
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }))
  expect(nordState).toEqual({
    theme: 'nord-dark',
    dark: true,
    light: false,
    appBg: '#2e3440',
    accent: '#88c0d0',
  })
  expect(
    await page.evaluate((k) => localStorage.getItem(k), THEME_STORAGE_KEY),
  ).toBe('nord-dark')
  await page.screenshot({ path: testInfo.outputPath('theme-nord-dark.png'), animations: 'disabled' })

  // The FOUC whitelist only knows built-ins, so after reload the kernel must
  // re-apply the stored plugin theme once the theme-nord plugin registers.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  const restored = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
  }))
  expect(restored.theme).toBe('nord-dark')
  expect(restored.dark).toBe(true)
  expect(restored.appBg).toBe('#2e3440')

  // Switching back to a built-in clears the injected inline variables.
  await page.keyboard.press('Control+,')
  // exact: true — '深色' would otherwise substring-match 'Nord 深色' as well.
  await dialog.getByRole('button', { name: '深色', exact: true }).click()
  const cleared = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
  }))
  expect(cleared.theme).toBe('dark')
  expect(cleared.appBg).toBe('')

  expect(consoleErrors).toEqual([])
})

test('explorer section excludes entries by glob pattern and persists across reload', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  // Demo project ships engine-style *.meta assets (e.g. Cocos Creator).
  await expect(page.getByRole('treeitem', { name: 'scene.meta' })).toBeVisible()

  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '资源管理器' }).click()
  const patterns = dialog.getByLabel('排除模式')
  await expect(patterns).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('explorer-exclude-section.png'),
    animations: 'disabled',
  })

  // Extension pattern hides *.meta everywhere; changes apply while typing.
  await patterns.fill('*.meta')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('treeitem', { name: 'scene.meta' })).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: 'package.json' })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('explorer-excluded-meta.png'),
    animations: 'disabled',
  })

  // Directory-name pattern hides the whole assets subtree.
  await page.keyboard.press('Control+,')
  await dialog.getByRole('button', { name: '资源管理器' }).click()
  await patterns.fill('*.meta\nassets')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('treeitem', { name: 'assets' })).toHaveCount(0)
  expect(await page.evaluate((k) => localStorage.getItem(k), EXCLUDE_STORAGE_KEY)).toBe(
    JSON.stringify(['*.meta', 'assets']),
  )

  // Reload: rules are restored from localStorage and still hide entries.
  await page.reload()
  await expect(page.getByRole('treeitem', { name: 'package.json' })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: 'scene.meta' })).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: 'assets' })).toHaveCount(0)

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
