import { expect, test, type Page } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage. The
// demo templates ship cross-file symbols (src/services.ts references
// src/kernel.ts; MemoryFileStore implements FileStore) to exercise the
// F12 / Shift+F12 / Ctrl+F12 navigation stack end to end.

const PANEL = '代码导航结果'

async function trackConsoleErrors(page: Page): Promise<string[]> {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  return consoleErrors
}

async function openFile(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('treeitem', { name: 'src' }).click()
  await page.getByRole('treeitem', { name }).click()
  await expect(page.getByRole('tab', { name })).toBeVisible()
  // Wait until CodeMirror rendered the file content before clicking symbols.
  await expect(page.locator('.cm-content .cm-line').first()).toBeVisible()
  // Let the async language support finish swapping in syntax spans; clicking
  // mid-swap can land at stale coordinates.
  await page.waitForLoadState('networkidle')
}

interface SymbolClickTarget {
  /** 1-based line the symbol sits on. */
  line: number
  /** Inclusive 1-based column range the click must land inside. */
  colStart: number
  colEnd: number
}

/**
 * Click a symbol token and verify via the status bar that the cursor landed
 * inside the word. CodeMirror re-renders lines when syntax highlighting
 * arrives, which can shift click coordinates — retry a few times instead of
 * trusting a single click.
 */
async function clickSymbol(
  page: Page,
  word: string,
  target: SymbolClickTarget,
  modifiers?: { modifiers: ('Control' | 'Meta' | 'Shift' | 'Alt')[] },
): Promise<void> {
  const loc = page.getByText(word, { exact: true }).first()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await loc.click(modifiers)
    const status = (await page.locator('footer').textContent()) ?? ''
    const match = status.match(/第 (\d+) 行，第 (\d+) 列/)
    if (
      match &&
      Number(match[1]) === target.line &&
      Number(match[2]) >= target.colStart &&
      Number(match[2]) <= target.colEnd
    ) {
      return
    }
    await page.waitForTimeout(150)
  }
  throw new Error(
    `cursor never landed inside "${word}" (want line ${target.line} cols ${target.colStart}-${target.colEnd})`,
  )
}

test('F12 jumps from a usage in services.ts to the definition in kernel.ts', async ({
  page,
}, testInfo) => {
  const consoleErrors = await trackConsoleErrors(page)
  await openFile(page, 'services.ts')

  // `import { createServiceKey } from './kernel'` — line 1, cols 10-25.
  await clickSymbol(page, 'createServiceKey', { line: 1, colStart: 10, colEnd: 25 })
  await page.keyboard.press('F12')

  await expect(page.getByRole('tab', { name: 'kernel.ts' })).toBeVisible()
  // Cursor lands on the definition line (kernel.ts line 5).
  await expect(page.getByText('第 5 行', { exact: false })).toBeVisible()
  await expect(page.locator('.cm-flashLine')).toContainText('function createServiceKey')
  await page.screenshot({ path: testInfo.outputPath('nav-goto-definition.png'), animations: 'disabled' })

  expect(consoleErrors).toEqual([])
})

test('Ctrl+click on a symbol jumps to its definition', async ({ page }) => {
  const consoleErrors = await trackConsoleErrors(page)
  await openFile(page, 'App.tsx')

  // `import { MemoryFileStore } from './services'` — line 2, cols 10-23.
  // A successful Ctrl+click jumps straight to services.ts; retry while the
  // editor may still be swapping in syntax highlighting.
  const target = page.getByText('MemoryFileStore', { exact: true }).first()
  const servicesTab = page.getByRole('tab', { name: 'services.ts' })
  for (let attempt = 0; attempt < 4 && !(await servicesTab.isVisible().catch(() => false)); attempt += 1) {
    await target.click({ modifiers: ['Control'] })
    await page.waitForTimeout(150)
  }

  await expect(servicesTab).toBeVisible()
  await expect(page.locator('.cm-flashLine')).toContainText('class MemoryFileStore')
  expect(consoleErrors).toEqual([])
})

test('Shift+F12 opens the references panel and rows jump to their location', async ({
  page,
}, testInfo) => {
  const consoleErrors = await trackConsoleErrors(page)
  await openFile(page, 'kernel.ts')

  // `export function createServiceKey<T>(name: string) {` — line 5, cols 17-32.
  await clickSymbol(page, 'createServiceKey', { line: 5, colStart: 17, colEnd: 32 })
  await page.keyboard.press('Shift+F12')

  const panel = page.getByRole('dialog', { name: PANEL })
  await expect(panel).toBeVisible()
  const rows = panel.locator('[data-navigation-row]')
  await expect(rows).toHaveCount(3)
  // Definition row (kernel.ts) is flagged; services.ts references follow.
  await expect(rows.first()).toHaveAttribute('data-rel-path', 'src/kernel.ts')
  await expect(rows.nth(1)).toHaveAttribute('data-rel-path', 'src/services.ts')
  await expect(panel.getByText('定义', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('nav-references-panel.png'), animations: 'disabled' })

  // Clicking a reference row reveals it and keeps the panel open for browsing.
  await rows.nth(1).click()
  await expect(page.getByRole('tab', { name: 'services.ts' })).toBeVisible()
  await expect(panel).toBeVisible()

  // Keyboard flow: focus returns to the panel, ArrowDown moves the highlight
  // (mouse hover left it on row 1) and Enter reveals the selected reference.
  await panel.focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByText('第 9 行', { exact: false })).toBeVisible()
  await expect(panel).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  expect(consoleErrors).toEqual([])
})

test('Ctrl+F12 jumps from the FileStore interface to its implementation', async ({
  page,
}) => {
  const consoleErrors = await trackConsoleErrors(page)
  await openFile(page, 'services.ts')

  // `export interface FileStore {` — line 3, cols 18-26.
  await clickSymbol(page, 'FileStore', { line: 3, colStart: 18, colEnd: 26 })
  await page.keyboard.press('Control+F12')

  await expect(page.getByText('第 12 行', { exact: false })).toBeVisible()
  await expect(page.locator('.cm-flashLine')).toContainText('class MemoryFileStore')
  expect(consoleErrors).toEqual([])
})

test('navigation without a code cursor shows guidance instead of jumping', async ({
  page,
}, testInfo) => {
  const consoleErrors = await trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // No code file open yet → no cursor context to act on.
  await page.keyboard.press('F12')
  const panel = page.getByRole('dialog', { name: PANEL })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('请先将光标放在代码中的符号上', { exact: false })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('nav-no-cursor.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  expect(consoleErrors).toEqual([])
})
