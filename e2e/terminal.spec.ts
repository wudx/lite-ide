import { expect, test, type Page } from '@playwright/test'

// Terminal bottom panel against the browser demo backend's fake shell
// (see packages/protocol/src/mock-terminal.ts): open the panel from the
// status bar, run commands over the mock virtual FS, toggle with Ctrl+`.
const TERMINAL_BODY = '[data-testid="panel-view-terminal"]'

// 热项目以 display:none 保活，两份 PanelHost 同时存在；测试id 不滤隐藏，
// 一律以 data-active 的项目工作区为作用域。
function activeWorkspace(page: Page) {
  return page.locator('section[data-active="true"]')
}

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

test('terminal panel opens, runs mock shell commands and toggles with Ctrl+`', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Closed by default: the panel stays mounted but hidden (display:none).
  const panelArea = activeWorkspace(page).getByTestId('panel-area')
  await expect(panelArea).not.toBeVisible()

  // Open from the status bar toggle.
  await page.getByTestId('statusbar-terminal').click()
  await expect(panelArea).toBeVisible()
  await expect(activeWorkspace(page).getByTestId('panel-header')).toContainText('终端')
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY} .xterm`)).toBeVisible()

  // The fake shell prints its banner and the first prompt.
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY}`)).toContainText(
    'LiteIDE demo shell',
    { timeout: 10_000 },
  )
  await page.screenshot({
    path: testInfo.outputPath('terminal-panel-open.png'),
    animations: 'disabled',
  })

  // Type a command: the mock shell echoes input and answers `help`.
  await page.locator(`section[data-active="true"] ${TERMINAL_BODY}`).click()
  await page.keyboard.type('help')
  await page.keyboard.press('Enter')
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY}`)).toContainText(
    'Commands:',
  )

  // Commands run against the demo virtual FS.
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY}`)).toContainText(
    'README.md',
  )
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY}`)).toContainText('src/')

  await page.keyboard.type('cd src')
  await page.keyboard.press('Enter')
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY}`)).toContainText('/src')

  await page.screenshot({
    path: testInfo.outputPath('terminal-commands.png'),
    animations: 'disabled',
  })

  // Ctrl+` closes the panel again (plugin-level shortcut).
  await page.keyboard.press('Control+`')
  await expect(panelArea).not.toBeVisible()

  // Reopen through the command's status bar entry; session output persists.
  await page.getByTestId('statusbar-terminal').click()
  await expect(panelArea).toBeVisible()
  await expect(page.locator(`section[data-active="true"] ${TERMINAL_BODY}`)).toContainText('/src')

  expect(consoleErrors).toEqual([])
})
