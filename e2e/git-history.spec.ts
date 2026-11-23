import { expect, test, type Page } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage.
const NEWEST_COMMIT_SHA = '3f9d2c1a8b7e4f60a1b2c3d4e5f60718293a4b5c'

function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

test('git history lists seeded commits, expands files and opens the commit diff', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-branch-name')).toHaveText('main')

  // Toggle into history mode.
  await page.getByTestId('git-history-toggle').click()
  const list = page.getByTestId('git-history-list')
  await expect(list).toBeVisible()
  await expect(page.locator('[data-git-commit]')).toHaveCount(3)

  // Newest first; the demo repo seeds three commits by "Demo User".
  const firstRow = page.locator('[data-git-commit]').first()
  await expect(firstRow).toHaveAttribute('data-git-commit', NEWEST_COMMIT_SHA)
  await expect(firstRow).toContainText('feat: 示例面板支持提交与推送流程')
  await expect(firstRow).toContainText('Demo User')
  await page.screenshot({ path: testInfo.outputPath('git-history-list.png'), animations: 'disabled' })

  // Expand the newest commit: its file list shows src/App.tsx.
  await firstRow.click()
  const fileBtn = page.locator('[data-git-commit-path="src/App.tsx"]')
  await expect(fileBtn).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('git-history-expanded.png'),
    animations: 'disabled',
  })

  // Open the file's diff for this commit: the previewer renders the commit
  // patch with a commit pill instead of the staged/unstaged switcher.
  await fileBtn.click()
  await expect(page.getByTestId('git-diff-view')).toBeVisible()
  await expect(page.getByTestId('git-diff-commit-sha')).toContainText('提交 3f9d2c1')
  await expect(page.getByTestId('git-diff-rows')).toContainText('push flow demo')
  await expect(page.getByTestId('git-diff-section')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('git-history-commit-diff.png'),
    animations: 'disabled',
  })

  // Collapsing the commit hides its file list again.
  await firstRow.click()
  await expect(page.locator('[data-git-commit-path="src/App.tsx"]')).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})

test('git history shows fresh commits and persists the mode across reload', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()

  // Stage everything and commit in the changes view.
  await page.getByRole('button', { name: '暂存全部更改', exact: true }).click()
  await page.getByPlaceholder('输入提交信息 (Ctrl+Enter 提交)').fill('feat: e2e 历史提交')
  await page.getByTestId('git-commit-button').click()
  await expect(page.getByText('工作区干净')).toBeVisible()

  // Switch to history: the fresh commit tops the list above the three seeds.
  await page.getByTestId('git-history-toggle').click()
  const firstRow = page.locator('[data-git-commit]').first()
  await expect(firstRow).toContainText('feat: e2e 历史提交')
  await expect(page.locator('[data-git-commit]')).toHaveCount(4)
  await page.screenshot({
    path: testInfo.outputPath('git-history-after-commit.png'),
    animations: 'disabled',
  })

  // Mode preference persists across reload. The mock backend state lives in
  // page memory, so history resets to the three seeded commits after reload.
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-history-list')).toBeVisible()
  await expect(page.getByTestId('git-history-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-git-commit]')).toHaveCount(3)
  await expect(page.locator('[data-git-commit]').first()).toContainText(
    'feat: 示例面板支持提交与推送流程',
  )

  // Back to the changes view via the toggle.
  await page.getByTestId('git-history-toggle').click()
  await expect(page.getByTestId('git-history-list')).toHaveCount(0)
  await expect(page.getByTestId('git-commit-button')).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('git history context menu resets branch to a commit, keeping diffs in the worktree', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackErrors(page)
  const SECOND_COMMIT_SHA = '8c1d4e2f0a9b3c6d5e7f8091a2b3c4d5e6f70819'

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.getByTestId('git-history-toggle').click()
  const list = page.getByTestId('git-history-list')
  await expect(list).toBeVisible()
  await expect(page.locator('[data-git-commit]')).toHaveCount(3)

  // Right-click the second commit: the custom menu opens (the native WebView
  // menu is suppressed by the handler).
  await page.locator('[data-git-commit]').nth(1).click({ button: 'right' })
  const menu = page.getByTestId('git-history-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('重置到该版本')
  await expect(menu).toContainText('新建分支')
  await expect(menu).toContainText('挑选到当前分支')
  await page.screenshot({
    path: testInfo.outputPath('git-history-context-menu.png'),
    animations: 'disabled',
  })

  // Confirm the mixed reset: the branch drops the newest commit while its
  // diff lands back in the worktree as unstaged changes.
  await menu.getByTestId('git-history-reset').click()
  const dialog = page.getByRole('dialog', { name: '重置到该版本' })
  await expect(dialog).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('git-history-reset-confirm.png'),
    animations: 'disabled',
  })
  await dialog.getByRole('button', { name: '重置', exact: true }).click()

  await expect(page.locator('[data-git-commit]')).toHaveCount(2)
  await expect(page.locator('[data-git-commit]').first()).toContainText(
    'docs: 完善预览器与主题插件说明',
  )
  await expect(page.locator(`[data-git-commit="${SECOND_COMMIT_SHA}"]`)).toHaveCount(1)
  await page.screenshot({
    path: testInfo.outputPath('git-history-after-reset.png'),
    animations: 'disabled',
  })

  // Back to the changes view: the staged section emptied (index reset to the
  // target) and README.md joined the unstaged section (1 → 4 entries).
  await page.getByTestId('git-history-toggle').click()
  await expect(page.getByTestId('git-commit-button')).toBeVisible()
  await expect(page.getByRole('button', { name: /已暂存的更改/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /更改 \(4\)/ })).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('git history context menu creates a branch at a commit', async ({ page }, testInfo) => {
  const consoleErrors = trackErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.getByTestId('git-history-toggle').click()
  await expect(page.getByTestId('git-history-list')).toBeVisible()

  await page.locator('[data-git-commit]').first().click({ button: 'right' })
  await page.getByTestId('git-history-create-branch').click()

  const dialog = page.getByTestId('git-branch-dialog')
  await expect(dialog).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('git-history-branch-dialog.png'),
    animations: 'disabled',
  })
  await page.getByTestId('git-branch-dialog-input').fill('feat/from-commit')
  await page.getByTestId('git-branch-dialog-confirm').click()
  await expect(dialog).toHaveCount(0)

  // The branch list gains the new entry while the checkout stays on main.
  await page.getByTestId('git-history-toggle').click()
  await expect(page.getByTestId('git-branch-name')).toHaveText('main')
  await page.getByTestId('git-branch-switcher').click()
  await expect(page.getByRole('option', { name: /feat\/from-commit/ })).toBeVisible()
  await page.screenshot({
    path: testInfo.outputPath('git-history-branch-created.png'),
    animations: 'disabled',
  })

  expect(consoleErrors).toEqual([])
})

test('git history context menu cherry-picks a commit onto the current branch', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.getByTestId('git-history-toggle').click()
  await expect(page.getByTestId('git-history-list')).toBeVisible()
  await expect(page.locator('[data-git-commit]')).toHaveCount(3)

  // Pick the second (docs) commit: it lands on top as a fresh commit with the
  // same subject and file list.
  await page.locator('[data-git-commit]').nth(1).click({ button: 'right' })
  await page.getByTestId('git-history-cherry-pick').click()

  await expect(page.locator('[data-git-commit]')).toHaveCount(4)
  await expect(page.locator('[data-git-commit]').first()).toContainText(
    'docs: 完善预览器与主题插件说明',
  )
  await page.screenshot({
    path: testInfo.outputPath('git-history-after-cherry-pick.png'),
    animations: 'disabled',
  })

  expect(consoleErrors).toEqual([])
})
