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
  // 嵌入式内置插件常驻已安装列表（可停用、不可卸载）。
  await expect(dialog.getByTestId('plugin-embedded-builtin.preview-markdown')).toBeVisible()
  await expect(dialog.getByTestId('plugin-uninstall-builtin.preview-markdown')).toHaveCount(0)
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
  // 用户插件全部卸载后，嵌入式内置插件仍在列且不受影响。
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-nord')).toBeVisible()
  await expect(dialog.getByTestId('plugin-status-hello-status')).toHaveCount(0)

  // The store is emptied and catalog entries come back.
  const store = JSON.parse(
    await page.evaluate((k) => localStorage.getItem(k) ?? '{}', MOCK_PLUGIN_STORE_KEY),
  )
  expect(Object.keys(store)).toEqual([])
  await expect(dialog.getByTestId('plugin-catalog-install-hello-status')).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('catalog install of the bundle-format sample activates sidebar, css and chunked previewer', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  // bundle-notes 样例：format=bundle + css 资产 + 懒加载 chunk 的全能力样例。
  await dialog.getByTestId('plugin-catalog-install-bundle-notes').click()
  await expect(dialog.getByTestId('plugin-status-bundle-notes')).toHaveText('运行中')

  // 关闭设置对话框，回到工作台验证贡献。
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // 侧栏出现「笔记」视图（bundle 里的 Solid 组件经宿主 solid 单例渲染）。
  const notesTab = page.getByRole('button', { name: '笔记' })
  await expect(notesTab).toBeVisible()
  await notesTab.click()
  await expect(page.getByPlaceholder('记录一条笔记…')).toBeVisible()

  // manifest.css 资产经 pluginReadAsset 注入 <style> 标签。
  const styleTag = await page.evaluate(() =>
    document.querySelector('style[data-liteide-plugin="bundle-notes"]')?.textContent.slice(0, 60),
  )
  expect(styleTag).toBeTruthy()

  // 添加一条笔记：插件自有服务键 + localStorage 持久化。
  await page.getByPlaceholder('记录一条笔记…').fill('hello from bundle plugin')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByText('hello from bundle plugin')).toBeVisible()
  const noteStore = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('lite-ide.sample.bundle-notes.')),
  )
  expect(noteStore).toHaveLength(1)
  await page.screenshot({
    path: testInfo.outputPath('plugins-bundle-notes.png'),
    animations: 'disabled',
  })

  // chunk 预览器：新建 .log 文件 → previewer.provider load() 经
  // liteide.loadChunk('logView') 求值 log-view.js → 行号预览。
  await page.getByRole('button', { name: '资源管理器' }).click()
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  const nameInput = page.getByPlaceholder('新文件名称…')
  await expect(nameInput).toBeVisible()
  await nameInput.fill('error.log')
  await nameInput.press('Enter')
  const logEntry = page.getByRole('treeitem').filter({ hasText: 'error.log' }).first()
  await expect(logEntry).toBeVisible()
  await logEntry.click()
  // 行号 "1" 出现即代表懒 chunk 已求值并渲染。
  await expect(page.locator('pre').filter({ hasText: /^1/ }).first()).toBeVisible({ timeout: 10_000 })
  await page.screenshot({
    path: testInfo.outputPath('plugins-bundle-log-chunk.png'),
    animations: 'disabled',
  })

  // 卸载：贡献与注入的样式一起移除。
  const dialog2 = await openPluginsSection(page)
  await dialog2.getByTestId('plugin-uninstall-bundle-notes').click()
  await dialog2.getByTestId('plugin-uninstall-bundle-notes').click()
  await expect(dialog2.getByTestId('plugin-status-bundle-notes')).toHaveCount(0)
  await dialog2.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('button', { name: '笔记' })).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.querySelector('style[data-liteide-plugin="bundle-notes"]'),
    ),
  ).toBeNull()

  expect(consoleErrors).toEqual([])
})
