import { expect, test, type Page } from '@playwright/test'

// External plugin system: install / disable / uninstall via the settings
// "插件" section against the browser demo backend (mock catalog + localStorage).
const MOCK_PLUGIN_STORE_KEY = 'lite-ide.mock-plugins.v1'
const DISABLED_STORAGE_KEY = 'lite-ide.plugins.disabled.v1'
const THEME_STORAGE_KEY = 'lite-ide.theme.v1'

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

async function openPluginsSection(page: Page) {
  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '插件' }).click()
  await expect(dialog.getByRole('heading', { name: '插件管理' })).toBeVisible()
  return dialog
}

test('plugins section lists the catalog and installs the Hello Status plugin', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  await expect(dialog.getByText('尚未安装任何插件')).toBeVisible()
  await expect(dialog.getByText('可安装的插件')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugins-section.png'), animations: 'disabled' })

  // Install: the entry activates immediately and contributes a statusbar item.
  await dialog.getByTestId('plugin-catalog-install-hello-status').click()
  await expect(page.getByText('你好，插件！')).toBeVisible()
  await expect(dialog.getByTestId('plugin-status-hello-status')).toHaveText('运行中')
  await expect(dialog.getByText('Hello Status')).toBeVisible()
  // Installed entries disappear from the catalog strip.
  await expect(dialog.getByTestId('plugin-catalog-install-hello-status')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('plugins-hello-installed.png'),
    animations: 'disabled',
  })

  // The demo backend persists installs in localStorage.
  const stored = await page.evaluate((k) => localStorage.getItem(k), MOCK_PLUGIN_STORE_KEY)
  expect(stored).toContain('hello-status')

  expect(consoleErrors).toEqual([])
})

test('disable / re-enable toggles plugin contributions and persists across reload', async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  const dialog = await openPluginsSection(page)
  await dialog.getByTestId('plugin-catalog-install-hello-status').click()
  await expect(page.getByText('你好，插件！')).toBeVisible()

  // Disable: the statusbar item disappears and the row shows 已停用.
  await dialog.getByTestId('plugin-disable-hello-status').click()
  await expect(page.getByText('你好，插件！')).toHaveCount(0)
  await expect(dialog.getByTestId('plugin-status-hello-status')).toHaveText('已停用')
  expect(
    await page.evaluate((k) => localStorage.getItem(k), DISABLED_STORAGE_KEY),
  ).toBe(JSON.stringify(['hello-status']))

  // Reload: the plugin stays installed but disabled; nothing activates.
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await expect(page.getByText('你好，插件！')).toHaveCount(0)
  const dialog2 = await openPluginsSection(page)
  await expect(dialog2.getByTestId('plugin-status-hello-status')).toHaveText('已停用')

  // Re-enable: contributions come back without a reload.
  await dialog2.getByTestId('plugin-enable-hello-status').click()
  await expect(page.getByText('你好，插件！')).toBeVisible()
  await expect(dialog2.getByTestId('plugin-status-hello-status')).toHaveText('运行中')

  expect(consoleErrors).toEqual([])
})

test('installing the Gruvbox theme plugin extends the appearance section live', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  await dialog.getByTestId('plugin-catalog-install-theme-gruvbox').click()
  await expect(dialog.getByTestId('plugin-status-theme-gruvbox')).toHaveText('运行中')

  // The contributed theme appears in the appearance grid without a reload.
  await dialog.getByRole('button', { name: '外观' }).click()
  const gruvbox = dialog.getByRole('button', { name: 'Gruvbox Dark' })
  await expect(gruvbox).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugins-gruvbox-appearance.png'), animations: 'disabled' })

  // Applying it injects the plugin-provided inline variables.
  await gruvbox.click()
  const state = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }))
  expect(state).toEqual({ theme: 'gruvbox-dark', appBg: '#282828', accent: '#8ec07c' })
  await page.screenshot({ path: testInfo.outputPath('plugins-gruvbox-applied.png'), animations: 'disabled' })

  expect(consoleErrors).toEqual([])
})

test('uninstalling (two-click confirm) removes plugins and their contributions', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  await dialog.getByTestId('plugin-catalog-install-hello-status').click()
  await dialog.getByTestId('plugin-catalog-install-theme-gruvbox').click()
  await expect(page.getByText('你好，插件！')).toBeVisible()
  await expect(dialog.getByTestId('plugin-status-theme-gruvbox')).toHaveText('运行中')

  // Gruvbox is the active theme; uninstalling it must fall back to dark.
  await dialog.getByRole('button', { name: '外观' }).click()
  await dialog.getByRole('button', { name: 'Gruvbox Dark' }).click()
  expect(await page.evaluate((k) => localStorage.getItem(k), THEME_STORAGE_KEY)).toBe(
    'gruvbox-dark',
  )
  await dialog.getByRole('button', { name: '插件' }).click()

  // Uninstall needs a second confirming click.
  await dialog.getByTestId('plugin-uninstall-theme-gruvbox').click()
  await expect(dialog.getByTestId('plugin-uninstall-theme-gruvbox')).toHaveText(
    '再次点击确认卸载',
  )
  await page.screenshot({ path: testInfo.outputPath('plugins-uninstall-armed.png'), animations: 'disabled' })
  await dialog.getByTestId('plugin-uninstall-theme-gruvbox').click()

  await expect(dialog.getByTestId('plugin-status-theme-gruvbox')).toHaveCount(0)
  // 未知主题 id 回退内置 dark，存储 id 保留（ThemeState 既有行为）。
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  await dialog.getByTestId('plugin-uninstall-hello-status').click()
  await dialog.getByTestId('plugin-uninstall-hello-status').click()
  await expect(page.getByText('你好，插件！')).toHaveCount(0)
  await expect(dialog.getByText('尚未安装任何插件')).toBeVisible()

  // The store is emptied and catalog entries come back.
  const store = JSON.parse(
    await page.evaluate((k) => localStorage.getItem(k) ?? '{}', MOCK_PLUGIN_STORE_KEY),
  )
  expect(Object.keys(store)).toEqual([])
  await expect(dialog.getByTestId('plugin-catalog-install-hello-status')).toBeVisible()

  expect(consoleErrors).toEqual([])
})
