import { expect, test, type Locator, type Page } from '@playwright/test'

// Terminal bottom panel against the browser demo backend's fake shell
// (see packages/protocol/src/mock-terminal.ts): open the panel from the
// status bar, run commands over the mock virtual FS, toggle with Ctrl+`,
// and manage multiple independent terminal tabs.
const TERMINAL_BODY = '[data-testid="panel-view-terminal"]'

// 热项目以 display:none 保活，两份 PanelHost 同时存在；测试id 不滤隐藏，
// 一律以 data-active 的项目工作区为作用域。
function activeWorkspace(page: Page) {
  return page.locator('section[data-active="true"]')
}

async function dragTerminalTab(page: Page, source: Locator, target: Locator): Promise<void> {
  const s = await source.boundingBox()
  const t = await target.boundingBox()
  if (!s || !t) throw new Error('terminal tab bounding boxes unavailable')
  const startX = s.x + s.width / 2
  const y = s.y + s.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(t.x + t.width / 2 + 12, y, { steps: 10 })
  await page.mouse.up()
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
  await expect(activeWorkspace(page).getByTestId('panel-header')).toHaveCount(0)
  await expect(activeWorkspace(page).getByTestId('terminal-tabs')).toBeVisible()
  await expect(activeWorkspace(page).getByTestId('terminal-tab-1')).toContainText('终端 1')

  const pane1 = activeWorkspace(page).getByTestId('terminal-pane-1')
  await expect(pane1.locator('.xterm')).toBeVisible()

  // The fake shell prints its banner and the first prompt.
  await expect(pane1).toContainText('LiteIDE demo shell', { timeout: 10_000 })
  await page.screenshot({
    path: testInfo.outputPath('terminal-panel-open.png'),
    animations: 'disabled',
  })

  // Type a command: the mock shell echoes input and answers `help`.
  await pane1.click()
  await page.keyboard.type('help')
  await page.keyboard.press('Enter')
  await expect(pane1).toContainText('Commands:')

  // Commands run against the demo virtual FS.
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await expect(pane1).toContainText('README.md')
  await expect(pane1).toContainText('src/')

  await page.keyboard.type('cd src')
  await page.keyboard.press('Enter')
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(pane1).toContainText('/src')

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
  await expect(pane1).toContainText('/src')

  expect(consoleErrors).toEqual([])
})

test('supports multiple independent terminal tabs, switching, and closing', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const workspace = activeWorkspace(page)
  const panelArea = workspace.getByTestId('panel-area')

  await page.getByTestId('statusbar-terminal').click()
  await expect(panelArea).toBeVisible()

  const tab1 = workspace.getByTestId('terminal-tab-1')
  const pane1 = workspace.getByTestId('terminal-pane-1')
  await expect(tab1).toHaveAttribute('aria-selected', 'true')
  await expect(pane1).toContainText('LiteIDE demo shell', { timeout: 10_000 })

  // Run `cd src` in terminal 1.
  await pane1.click()
  await page.keyboard.type('cd src')
  await page.keyboard.press('Enter')
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(pane1).toContainText('/src')

  // Create terminal 2 via the "+" button; both tabs exist and terminal 2 is active.
  await workspace.getByTestId('terminal-new-tab').click()
  const tab2 = workspace.getByTestId('terminal-tab-2')
  const pane2 = workspace.getByTestId('terminal-pane-2')
  await expect(tab1).toBeVisible()
  await expect(tab2).toBeVisible()
  await expect(tab2).toContainText('终端 2')
  await expect(tab2).toHaveAttribute('aria-selected', 'true')
  await expect(tab1).toHaveAttribute('aria-selected', 'false')
  await expect(pane2).toBeVisible()
  await expect(pane1).not.toBeVisible()
  await expect(page.getByTestId('statusbar-terminal-count')).toHaveText('2')

  // Terminal 2 starts a fresh shell at root `/`.
  await expect(pane2).toContainText('LiteIDE demo shell', { timeout: 10_000 })
  await pane2.click()
  await page.keyboard.type('echo second-tab-session')
  await page.keyboard.press('Enter')
  await expect(pane2).toContainText('second-tab-session')
  await page.keyboard.type('pwd')
  await page.keyboard.press('Enter')
  await expect(pane2).toContainText('pwd/lite-ide-demo:/$')
  await expect(pane2).not.toContainText('/src')

  await page.screenshot({
    path: testInfo.outputPath('terminal-multi-tabs.png'),
    animations: 'disabled',
  })

  // Switch back to terminal 1 and confirm its output and cwd persisted independently.
  await tab1.click()
  await expect(tab1).toHaveAttribute('aria-selected', 'true')
  await expect(pane1).toBeVisible()
  await expect(pane2).not.toBeVisible()
  await expect(pane1).toContainText('/src')
  await expect(pane1).not.toContainText('second-tab-session')

  // Close terminal 2 -> only terminal 1 remains, count badge disappears.
  await workspace.getByTestId('terminal-tab-close-2').click({ force: true })
  await expect(tab2).toHaveCount(0)
  await expect(tab1).toBeVisible()
  await expect(page.getByTestId('statusbar-terminal-count')).toHaveCount(0)

  // Close the last remaining terminal -> panel hides automatically.
  await workspace.getByTestId('terminal-tab-close-1').click()
  await expect(panelArea).not.toBeVisible()

  // Reopen from status bar -> recreates Terminal 1 cleanly.
  await page.getByTestId('statusbar-terminal').click()
  await expect(panelArea).toBeVisible()
  await expect(workspace.getByTestId('terminal-tab-1')).toBeVisible()
  await expect(workspace.getByTestId('terminal-pane-1')).toContainText('LiteIDE demo shell', {
    timeout: 10_000,
  })
  await expect(workspace.locator(`${TERMINAL_BODY} [role="tab"]`)).toHaveCount(1)

  expect(consoleErrors).toEqual([])
})

test('supports Ctrl+Shift+` new terminal, drag reorder, middle-click close and hide button', async ({
  page,
}) => {
  const consoleErrors = trackConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  const workspace = activeWorkspace(page)
  const panelArea = workspace.getByTestId('panel-area')

  // First Ctrl+Shift+` opens the panel with the single default Terminal 1.
  await page.keyboard.press('Control+Shift+Backquote')
  await expect(panelArea).toBeVisible()
  await expect(workspace.locator(`${TERMINAL_BODY} [role="tab"]`)).toHaveCount(1)
  await expect(workspace.getByTestId('terminal-pane-1')).toContainText('LiteIDE demo shell', {
    timeout: 10_000,
  })

  // Pressing Ctrl+Shift+` again creates Terminal 2 and Terminal 3.
  await page.keyboard.press('Control+Shift+Backquote')
  await page.keyboard.press('Control+Shift+Backquote')
  await expect(workspace.locator(`${TERMINAL_BODY} [role="tab"]`)).toHaveCount(3)
  await expect(page.getByTestId('statusbar-terminal-count')).toHaveText('3')

  const readTabIds = () =>
    workspace
      .locator(`${TERMINAL_BODY} [role="tab"]`)
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))

  expect(await readTabIds()).toEqual(['terminal-tab-1', 'terminal-tab-2', 'terminal-tab-3'])

  // Drag Terminal 1 past Terminal 3 -> order becomes [2, 3, 1].
  await dragTerminalTab(
    page,
    workspace.getByTestId('terminal-tab-1'),
    workspace.getByTestId('terminal-tab-3'),
  )
  await expect.poll(readTabIds).toEqual(['terminal-tab-2', 'terminal-tab-3', 'terminal-tab-1'])

  // Middle-click Terminal 3 closes it cleanly.
  await workspace.getByTestId('terminal-tab-3').click({ button: 'middle' })
  await expect.poll(readTabIds).toEqual(['terminal-tab-2', 'terminal-tab-1'])
  await expect(page.getByTestId('statusbar-terminal-count')).toHaveText('2')

  // Hide panel via the header chevron button.
  await workspace.getByTestId('terminal-hide-panel').click()
  await expect(panelArea).not.toBeVisible()

  expect(consoleErrors).toEqual([])
})
