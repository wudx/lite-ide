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
  // 嵌入式内置插件常驻已安装列表（可停用、不可卸载）：含 explorer/git/preview-code 与三套内置主题插件。
  await expect(dialog.getByTestId('plugin-embedded-builtin.explorer')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.git')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.preview-markdown')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.preview-code')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-nord')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-gruvbox')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-catppuccin-latte')).toBeVisible()
  await expect(dialog.getByTestId('plugin-uninstall-builtin.explorer')).toHaveCount(0)
  await expect(dialog.getByTestId('plugin-uninstall-builtin.git')).toHaveCount(0)
  await expect(dialog.getByTestId('plugin-uninstall-builtin.theme-gruvbox')).toHaveCount(0)
  await expect(dialog.getByTestId('plugin-uninstall-builtin.theme-catppuccin-latte')).toHaveCount(0)
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

test('installing the Dracula theme plugin extends the appearance section live', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  await dialog.getByTestId('plugin-catalog-install-theme-dracula').click()
  await expect(dialog.getByTestId('plugin-status-theme-dracula')).toHaveText('运行中')

  // The contributed theme appears in the appearance grid without a reload.
  await dialog.getByRole('button', { name: '外观' }).click()
  const dracula = dialog.getByRole('button', { name: 'Dracula' })
  await expect(dracula).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugins-dracula-appearance.png'), animations: 'disabled' })

  // Applying it injects the plugin-provided inline variables.
  await dracula.click()
  const state = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }))
  expect(state).toEqual({ theme: 'dracula', appBg: '#282a36', accent: '#bd93f9' })
  await page.screenshot({ path: testInfo.outputPath('plugins-dracula-applied.png'), animations: 'disabled' })

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
  await dialog.getByTestId('plugin-catalog-install-theme-dracula').click()
  await expect(page.getByText('你好，插件！')).toBeVisible()
  await expect(dialog.getByTestId('plugin-status-theme-dracula')).toHaveText('运行中')

  // Dracula is the active theme; uninstalling it must fall back to dark.
  await dialog.getByRole('button', { name: '外观' }).click()
  await dialog.getByRole('button', { name: 'Dracula' }).click()
  expect(await page.evaluate((k) => localStorage.getItem(k), THEME_STORAGE_KEY)).toBe(
    'dracula',
  )
  await dialog.getByRole('button', { name: '插件' }).click()

  // Uninstall needs a second confirming click.
  await dialog.getByTestId('plugin-uninstall-theme-dracula').click()
  await expect(dialog.getByTestId('plugin-uninstall-theme-dracula')).toHaveText(
    '再次点击确认卸载',
  )
  await page.screenshot({ path: testInfo.outputPath('plugins-uninstall-armed.png'), animations: 'disabled' })
  await dialog.getByTestId('plugin-uninstall-theme-dracula').click()

  await expect(dialog.getByTestId('plugin-status-theme-dracula')).toHaveCount(0)
  // 未知主题 id 回退内置 dark，存储 id 保留（ThemeState 既有行为）。
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  await dialog.getByTestId('plugin-uninstall-hello-status').click()
  await dialog.getByTestId('plugin-uninstall-hello-status').click()
  await expect(page.getByText('你好，插件！')).toHaveCount(0)
  // 用户插件全部卸载后，嵌入式内置插件仍在列且不受影响。
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-nord')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-gruvbox')).toBeVisible()
  await expect(dialog.getByTestId('plugin-embedded-builtin.theme-catppuccin-latte')).toBeVisible()
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

const GITHUB_MANIFEST = {
  id: 'github-demo',
  name: 'GitHub Demo',
  version: '1.0.0',
  main: 'main.js',
}
const GITHUB_MAIN_JS =
  "liteide.plugin({ activate(ctx) { return ctx.contribute('statusbar.item', {" +
  " id: 'github-demo.item', align: 'right', order: 95," +
  " component: () => { const el = document.createElement('span');" +
  " el.textContent = '来自 GitHub'; return el } }) } })"

/** 拦截 api.github.com 与 raw.githubusercontent.com，伪造一个单文件插件仓库。 */
async function interceptGithubDemo(page: Page): Promise<void> {
  const tree = {
    tree: [
      { path: 'README.md', type: 'blob', size: 30 },
      { path: 'plugin.json', type: 'blob', size: JSON.stringify(GITHUB_MANIFEST).length },
      { path: 'main.js', type: 'blob', size: GITHUB_MAIN_JS.length },
    ],
    truncated: false,
  }
  await page.route(/api\.github\.com\/repos\/lite-ide\/demo(\/|$|\?)/, (route) =>
    route.fulfill({ json: { default_branch: 'main' } }),
  )
  await page.route(/api\.github\.com\/repos\/lite-ide\/demo\/git\/trees\//, (route) =>
    route.fulfill({ json: tree }),
  )
  await page.route(/raw\.githubusercontent\.com\/lite-ide\/demo\/.+\/plugin\.json$/, (route) =>
    route.fulfill({ body: JSON.stringify(GITHUB_MANIFEST) }),
  )
  await page.route(/raw\.githubusercontent\.com\/lite-ide\/demo\/.+\/main\.js$/, (route) =>
    route.fulfill({ body: GITHUB_MAIN_JS }),
  )
}

test('installs a plugin from a GitHub repository URL (network intercepted)', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await interceptGithubDemo(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  await dialog.getByTestId('plugin-github-toggle').click()
  await expect(dialog.getByTestId('plugin-github-url-input')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugins-github-input.png'), animations: 'disabled' })

  await dialog.getByTestId('plugin-github-url-input').fill('https://github.com/lite-ide/demo')
  await dialog.getByTestId('plugin-github-install').click()
  // 安装后立即激活：状态栏贡献与「运行中」徽标同时出现，输入行收起。
  await expect(page.getByText('来自 GitHub')).toBeVisible()
  await expect(dialog.getByTestId('plugin-status-github-demo')).toHaveText('运行中')
  await expect(dialog.getByTestId('plugin-github-url-input')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('plugins-github-installed.png'),
    animations: 'disabled',
  })

  // 浏览器演示后端经 localStorage 持久化。
  const stored = await page.evaluate((k) => localStorage.getItem(k), MOCK_PLUGIN_STORE_KEY)
  expect(stored).toContain('github-demo')

  // 卸载恢复现场：贡献消失，目录即空。
  await dialog.getByTestId('plugin-uninstall-github-demo').click()
  await dialog.getByTestId('plugin-uninstall-github-demo').click()
  await expect(page.getByText('来自 GitHub')).toHaveCount(0)
  await expect(dialog.getByTestId('plugin-status-github-demo')).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})

test('github install surfaces parse errors for non-github URLs', async ({ page }) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const dialog = await openPluginsSection(page)
  await dialog.getByTestId('plugin-github-toggle').click()
  await dialog.getByTestId('plugin-github-url-input').fill('https://gitlab.com/foo/bar')
  await dialog.getByTestId('plugin-github-install').click()
  // 解析失败在发起网络请求前报错，错误框展示后端 message。
  await expect(dialog.getByText(/操作失败/)).toBeVisible()
  await expect(dialog.getByText(/only github\.com/)).toBeVisible()
  // 输入行保留现场便于修改重试。
  await expect(dialog.getByTestId('plugin-github-url-input')).toBeVisible()

  expect(consoleErrors).toEqual([])
})
