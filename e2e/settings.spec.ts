import { expect, test, type Page } from '@playwright/test'

// Settings dialog + multi-theme switching acceptance (mock demo project).
const THEME_STORAGE_KEY = 'lite-ide.theme.v1'
const LOCALE_STORAGE_KEY = 'lite-ide.locale.v1'
const EXCLUDE_STORAGE_KEY = 'lite-ide.explorer.exclude.v1'
const AI_MODEL_STORAGE_KEY = 'lite-ide.ai-model.v1'
const SOLARIZED_EDITOR_BG = 'rgb(253, 246, 227)' // --bg-editor #FDF6E3
const SOLARIZED_BASE2_BG = 'rgb(238, 232, 213)' // --bg-app / --bg-sidebar #EEE8D5
const SOLARIZED_CHROME_BG = 'rgb(217, 210, 194)' // --bg-editor-chrome #D9D2C2
const SOLARIZED_UI_FG = 'rgb(66, 88, 96)' // --text-primary #425860
const SOLARIZED_EDITOR_FG = 'rgb(101, 123, 131)' // editor.foreground #657B83

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

  await page.getByRole('button', { name: '打开设置' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Contributed sections show up in the dialog navigation.
  await expect(dialog.getByRole('button', { name: '外观' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '通用' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '资源管理器' })).toBeVisible()
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

  await dialog.getByRole('button', { name: '浅色', exact: true }).click()
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

  // The theme-nord plugin contributes an entry to the appearance grid.
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

  // Reload: cached snapshot in index.html + synchronous embedded plugin activation
  // must apply nord-dark immediately without ever flashing the default dark theme.
  await page.keyboard.press('Escape')
  await page.addInitScript(() => {
    const seen: string[] = []
    const record = () => {
      const val = document.documentElement?.dataset.theme
      if (val && seen[seen.length - 1] !== val) seen.push(val)
    }
    record()
    new MutationObserver(record).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    ;(window as unknown as { __seenThemes?: string[] }).__seenThemes = seen
  })
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  const restored = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    seenThemes: (window as unknown as { __seenThemes?: string[] }).__seenThemes ?? [],
  }))
  expect(restored.theme).toBe('nord-dark')
  expect(restored.dark).toBe(true)
  expect(restored.appBg).toBe('#2e3440')
  expect(restored.seenThemes).not.toContain('dark')

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

test('six built-in themes appear in a 3x2 grid, switch Gruvbox and Catppuccin Latte without FOUC', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // 外观设置共 6 套内置主题（前 3 浅 + 后 3 深），呈 3×2 网格整齐排列。
  const themeCards = dialog.locator('section button')
  await expect(themeCards).toHaveCount(6)
  await expect(themeCards).toHaveText([
    '浅色',
    'Solarized Light',
    'Catppuccin 浅色',
    '深色',
    'Nord 深色',
    'Gruvbox 深色',
  ])
  await page.screenshot({ path: testInfo.outputPath('theme-grid-6.png'), animations: 'disabled' })

  // 切换到 Gruvbox 深色（嵌入式内置）。
  await dialog.getByRole('button', { name: 'Gruvbox 深色', exact: true }).click()
  const gruvboxState = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    light: document.documentElement.classList.contains('light'),
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }))
  expect(gruvboxState).toEqual({
    theme: 'gruvbox-dark',
    dark: true,
    light: false,
    appBg: '#282828',
    accent: '#8ec07c',
  })
  await page.screenshot({ path: testInfo.outputPath('theme-gruvbox-dark.png'), animations: 'disabled' })

  // 切换到 Catppuccin 浅色（第 6 套嵌入式内置浅色主题）。
  await dialog.getByRole('button', { name: 'Catppuccin 浅色', exact: true }).click()
  const latteState = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains('dark'),
    light: document.documentElement.classList.contains('light'),
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }))
  expect(latteState).toEqual({
    theme: 'catppuccin-latte',
    dark: false,
    light: true,
    appBg: '#dce0e8',
    accent: '#8839ef',
  })
  await page.screenshot({
    path: testInfo.outputPath('theme-catppuccin-latte.png'),
    animations: 'disabled',
  })

  // 重载验证 Catppuccin 浅色快照首帧直出，无暗色闪烁。
  await page.keyboard.press('Escape')
  await page.addInitScript(() => {
    const seen: string[] = []
    const record = () => {
      const val = document.documentElement?.dataset.theme
      if (val && seen[seen.length - 1] !== val) seen.push(val)
    }
    record()
    new MutationObserver(record).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    ;(window as unknown as { __seenThemes?: string[] }).__seenThemes = seen
  })
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  const restored = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    light: document.documentElement.classList.contains('light'),
    appBg: document.documentElement.style.getPropertyValue('--bg-app'),
    seenThemes: (window as unknown as { __seenThemes?: string[] }).__seenThemes ?? [],
  }))
  expect(restored.theme).toBe('catppuccin-latte')
  expect(restored.light).toBe(true)
  expect(restored.appBg).toBe('#dce0e8')
  expect(restored.seenThemes).not.toContain('dark')

  // 打开 README.md 与 src/kernel.ts，验证浅色插件主题下 Markdown 标题与代码视图均清晰可读。
  await page.getByRole('treeitem', { name: 'README.md' }).click()
  const mdHeading = page.locator('.markdown-body h1').first()
  await expect(mdHeading).toBeVisible()
  await expect(mdHeading).toHaveCSS('color', 'rgb(76, 79, 105)')
  await page.screenshot({
    path: testInfo.outputPath('theme-catppuccin-latte-workspace.png'),
    animations: 'disabled',
  })

  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'kernel.ts' }).click()
  await expect(page.locator('.cm-editor')).toBeVisible()
  await expect(page.locator('.cm-editor')).toHaveCSS('background-color', 'rgb(239, 241, 245)')

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
  await expect(page.locator('body')).toHaveCSS('background-color', SOLARIZED_BASE2_BG)
  await expect(page.locator('aside').first()).toHaveCSS('background-color', SOLARIZED_BASE2_BG)
  await expect(page.getByRole('tablist').locator('..')).toHaveCSS(
    'background-color',
    SOLARIZED_CHROME_BG,
  )
  await expect(page.locator('body')).toHaveCSS('color', SOLARIZED_UI_FG)
  await expect(editor).toHaveCSS('background-color', SOLARIZED_EDITOR_BG)
  await expect(editor).toHaveCSS('color', SOLARIZED_EDITOR_FG)
  await page.screenshot({
    path: testInfo.outputPath('solarized-code-preview.png'),
    animations: 'disabled',
  })

  expect(consoleErrors).toEqual([])
})

test('general section switches display language across the IDE and persists across reload', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Playwright config pins locale to zh-CN, so Follow System boots into Chinese.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
  await expect(page.getByText('项目: 2')).toBeVisible()

  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name: 'kernel.ts' }).click()
  await expect(page.getByText('已保存')).toBeVisible()
  await expect(page.getByText('第 1 行，第 1 列')).toBeVisible()

  // Open Settings -> 通用 -> switch to English.
  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '通用' }).click()
  await expect(dialog.getByText('界面语言')).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('settings-language-zh.png'),
    animations: 'disabled',
  })

  await dialog.getByRole('button', { name: /English/ }).click()

  // Entire workbench & plugins react immediately without reload.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en-US')
  expect(await page.evaluate((k) => localStorage.getItem(k), LOCALE_STORAGE_KEY)).toBe('en-US')
  await expect(dialog.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Appearance' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'General' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Explorer' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Display Language' })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('settings-language-en.png'),
    animations: 'disabled',
  })

  // Also check Appearance section theme labels translated (including all built-in theme plugins).
  await dialog.getByRole('button', { name: 'Appearance' }).click()
  await expect(dialog.getByRole('button', { name: 'Dark', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Nord Dark' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Gruvbox Dark' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Catppuccin Latte' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Projects: 2')).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible()
  await expect(page.getByText('Ln 1, Col 1')).toBeVisible()
  await expect(page.getByPlaceholder('Filter files...').first()).toBeVisible()

  // Reload: IDE boots directly in English.
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en-US')
  await expect(page.getByText('Projects: 2')).toBeVisible()
  await expect(page.getByPlaceholder('Filter files...').first()).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('ide-english-reloaded.png'),
    animations: 'disabled',
  })

  // Switch back to 跟随系统 (zh-CN) and verify immediate restoration.
  await page.keyboard.press('Control+,')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'General' }).click()
  await dialog.getByRole('button', { name: /Follow System/ }).click()
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
  expect(await page.evaluate((k) => localStorage.getItem(k), LOCALE_STORAGE_KEY)).toBe('system')
  await expect(dialog.getByRole('heading', { name: '设置' })).toBeVisible()
  await expect(page.getByText('项目: 2')).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('models section switches providers, stores the API key locally and persists', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.keyboard.press('Control+,')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // The built-in models section shows up between General and plugin sections.
  await expect(dialog.getByRole('button', { name: '模型' })).toBeVisible()
  await dialog.getByRole('button', { name: '模型' }).click()
  await expect(dialog.getByRole('heading', { name: '模型服务' })).toBeVisible()

  // Three providers contributed: Z.ai (GLM), DeepSeek and MiniMax; DeepSeek is default.
  await expect(dialog.getByTestId('ai-provider-zai')).toBeVisible()
  await expect(dialog.getByTestId('ai-provider-deepseek')).toBeVisible()
  await expect(dialog.getByTestId('ai-provider-minimax')).toBeVisible()
  await expect(dialog.getByTestId('ai-provider-deepseek')).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({
    path: testInfo.outputPath('settings-models-default.png'),
    animations: 'disabled',
  })

  // API key input is masked by default and toggleable.
  const apiKey = dialog.getByTestId('ai-api-key')
  await expect(apiKey).toHaveAttribute('type', 'password')
  await apiKey.fill('sk-deepseek-test-123')
  await expect(apiKey).toHaveAttribute('type', 'password')

  // Default DeepSeek endpoint and model ship as presets.
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('https://api.deepseek.com')
  await expect(dialog.getByTestId('ai-model')).toHaveValue('deepseek-chat')

  // Switch to Z.ai: its preset endpoint/model apply and the selection persists.
  await dialog.getByTestId('ai-provider-zai').click()
  await expect(dialog.getByTestId('ai-provider-zai')).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('https://api.z.ai/api/paas/v4')
  await expect(dialog.getByTestId('ai-model')).toHaveValue('glm-4.6')

  await dialog.getByTestId('ai-api-key').fill('sk-zai-test-456')
  await dialog.getByTestId('ai-commit-prompt').fill('使用英文提交信息')
  await page.screenshot({
    path: testInfo.outputPath('settings-models-zai.png'),
    animations: 'disabled',
  })

  const stored = JSON.parse(
    await page.evaluate((k) => localStorage.getItem(k), AI_MODEL_STORAGE_KEY),
  )
  expect(stored.providerId).toBe('zai')
  expect(stored.providers.zai.apiKey).toBe('sk-zai-test-456')
  expect(stored.providers.deepseek.apiKey).toBe('sk-deepseek-test-123')
  expect(stored.commitPrompt).toBe('使用英文提交信息')

  // Reload: provider, key and custom prompt are restored from localStorage.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.keyboard.press('Control+,')
  // Reopen lands on the first section; switch to the models section explicitly.
  await dialog.getByRole('button', { name: '模型', exact: true }).click()
  await expect(dialog.getByTestId('ai-provider-zai')).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByTestId('ai-api-key')).toHaveValue('sk-zai-test-456')
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('https://api.z.ai/api/paas/v4')
  await expect(dialog.getByTestId('ai-commit-prompt')).toHaveValue('使用英文提交信息')

  // Reset-to-defaults restores the preset base URL/model but keeps the key.
  await dialog.getByTestId('ai-base-url').fill('https://proxy.example.com/v4')
  await dialog.getByRole('button', { name: '恢复默认' }).click()
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('https://api.z.ai/api/paas/v4')
  await expect(dialog.getByTestId('ai-model')).toHaveValue('glm-4.6')
  await expect(dialog.getByTestId('ai-api-key')).toHaveValue('sk-zai-test-456')

  // MiniMax preset: switching applies its endpoint and model.
  await dialog.getByTestId('ai-provider-minimax').click()
  await expect(dialog.getByTestId('ai-provider-minimax')).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('https://api.minimaxi.com/v1')
  await expect(dialog.getByTestId('ai-model')).toHaveValue('MiniMax-M2')

  // Custom provider: the confirm stays disabled until all fields are filled.
  await dialog.getByTestId('ai-add-custom').click()
  const customConfirm = dialog.getByTestId('ai-custom-confirm')
  await expect(customConfirm).toBeDisabled()
  await dialog.getByTestId('ai-custom-name').fill('LAN Ollama')
  await dialog.getByTestId('ai-custom-base-url').fill('http://127.0.0.1:11434/v1')
  await dialog.getByTestId('ai-custom-model').fill('llama3')
  await expect(customConfirm).toBeEnabled()
  await customConfirm.click()

  const customCard = dialog.getByRole('button', { name: /LAN Ollama/ })
  await expect(customCard).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('http://127.0.0.1:11434/v1')
  await expect(dialog.getByTestId('ai-model')).toHaveValue('llama3')
  await page.screenshot({
    path: testInfo.outputPath('settings-models-custom.png'),
    animations: 'disabled',
  })

  const storedAfterAdd = JSON.parse(
    await page.evaluate((k) => localStorage.getItem(k), AI_MODEL_STORAGE_KEY),
  )
  expect(storedAfterAdd.providerId).toMatch(/^custom-/)
  expect(storedAfterAdd.customProviders).toHaveLength(1)
  expect(storedAfterAdd.customProviders[0].label).toBe('LAN Ollama')
  expect(storedAfterAdd.customProviders[0].defaultBaseUrl).toBe('http://127.0.0.1:11434/v1')

  // Reload: the custom provider and its selection are restored from localStorage.
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.keyboard.press('Control+,')
  await dialog.getByRole('button', { name: '模型', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /LAN Ollama/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(dialog.getByTestId('ai-base-url')).toHaveValue('http://127.0.0.1:11434/v1')

  // Deleting needs a second confirming click; selection falls back to the default.
  await dialog.getByRole('button', { name: '删除该自定义提供商' }).click()
  await dialog.getByRole('button', { name: '再次点击确认删除' }).click()
  await expect(dialog.getByRole('button', { name: /LAN Ollama/ })).toHaveCount(0)
  await expect(dialog.getByTestId('ai-provider-deepseek')).toHaveAttribute('aria-pressed', 'true')
  const storedAfterDelete = JSON.parse(
    await page.evaluate((k) => localStorage.getItem(k), AI_MODEL_STORAGE_KEY),
  )
  expect(storedAfterDelete.customProviders).toHaveLength(0)
  expect(storedAfterDelete.providerId).toBe('deepseek')

  expect(consoleErrors).toEqual([])
})
