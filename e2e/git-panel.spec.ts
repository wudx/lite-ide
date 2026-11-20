import { expect, test } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage.
const STAGED_FILE = 'README.md'
const UNSTAGED_FILE = 'src/App.tsx'

test('git panel lists changes, stages files and commits in mock mode', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Switch the sidebar to the Git view.
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-branch-name')).toHaveText('main')

  // Demo repo seeds: one staged modification, one unstaged modification.
  const stagedRow = page.locator(`[data-git-section="staged"][data-git-path="${STAGED_FILE}"]`)
  await expect(stagedRow).toBeVisible()
  const unstagedRow = page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)
  await expect(unstagedRow).toBeVisible()
  await expect(page.getByText('已暂存的更改 (1)')).toBeVisible()
  await expect(page.getByText('更改 (1)', { exact: true })).toBeVisible()

  // Statusbar mirrors the branch of the active project.
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('main')

  await page.screenshot({ path: testInfo.outputPath('git-panel-initial.png'), animations: 'disabled' })

  // Stage the unstaged file via its hover action.
  await unstagedRow.hover()
  await unstagedRow.getByRole('button', { name: `暂存 ${UNSTAGED_FILE}` }).click()
  const restagedRow = page.locator(`[data-git-section="staged"][data-git-path="${UNSTAGED_FILE}"]`)
  await expect(restagedRow).toBeVisible()
  await expect(page.getByText('已暂存的更改 (2)', { exact: true })).toBeVisible()
  await expect(page.locator(`[data-git-section="unstaged"]`)).toHaveCount(0)

  // Commit the staged changes.
  await page.getByPlaceholder('输入提交信息 (Ctrl+Enter 提交)').fill('feat: demo commit')
  await page.screenshot({ path: testInfo.outputPath('git-panel-staged.png'), animations: 'disabled' })
  await page.getByTestId('git-commit-button').click()

  await expect(page.getByText('工作区干净')).toBeVisible()
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('↑1')
  await page.screenshot({ path: testInfo.outputPath('git-panel-committed.png'), animations: 'disabled' })

  // Push the commit via the button to the right of Refresh and verify ahead indicator clears.
  const pushBtn = page.getByTestId('git-push-button')
  await expect(pushBtn).toBeVisible()
  await expect(pushBtn).toBeEnabled()
  await pushBtn.click()
  await expect(page.getByTestId('statusbar-git-branch')).not.toContainText('↑1')
  await expect(page.getByTestId('git-branch-switcher')).not.toContainText('↑1')

  expect(consoleErrors).toEqual([])
})

test('git panel shows the not-a-repository state for mock projects without git', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Switch to the second demo project (no git repository in mock mode).
  await page.getByRole('tab', { name: /rust-core-sample/ }).click()
  await page.getByRole('button', { name: 'Git', exact: true }).click()

  await expect(page.getByText('当前目录不是 Git 仓库')).toBeVisible()
  await expect(page.getByTestId('git-push-button')).toBeDisabled()
  // The statusbar branch indicator hides for non-repositories.
  await expect(page.getByTestId('statusbar-git-branch')).toHaveCount(0)

  await page.screenshot({ path: testInfo.outputPath('git-panel-no-repo.png'), animations: 'disabled' })
  expect(consoleErrors).toEqual([])
})

test('git panel discards an unstaged change after confirmation', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.getByRole('button', { name: 'Git', exact: true }).click()
  const unstagedRow = page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)
  await expect(unstagedRow).toBeVisible()

  await unstagedRow.hover()
  await unstagedRow.getByRole('button', { name: `放弃 ${UNSTAGED_FILE}` }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('git-discard-confirm.png'), animations: 'disabled' })
  await page.getByRole('dialog').getByText('放弃', { exact: true }).click()

  await expect(
    page.locator(`[data-git-path="${UNSTAGED_FILE}"]`),
  ).toHaveCount(0)
  expect(consoleErrors).toEqual([])
})

test('git panel stages all and unstages all changes in mock mode', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByText('已暂存的更改 (1)')).toBeVisible()
  await expect(page.getByText('更改 (1)', { exact: true })).toBeVisible()

  // Stage all remaining unstaged changes via the section header button.
  await page.getByRole('button', { name: '暂存全部更改', exact: true }).click()
  await expect(page.getByText('已暂存的更改 (2)', { exact: true })).toBeVisible()
  await expect(page.locator('[data-git-section="unstaged"]')).toHaveCount(0)
  await expect(page.locator('[data-git-section="staged"]')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('git-panel-staged-all.png'), animations: 'disabled' })

  // Unstage all staged changes at once via the Staged Changes header button.
  await page.getByRole('button', { name: '取消暂存全部更改', exact: true }).click()
  await expect(page.locator('[data-git-section="staged"]')).toHaveCount(0)
  await expect(page.getByText('更改 (2)', { exact: true })).toBeVisible()
  await expect(page.locator('[data-git-section="unstaged"]')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('git-panel-unstaged-all.png'), animations: 'disabled' })

  // Clicking the branch-header refresh button shows visible spin feedback even on fast backends.
  const refreshBtn = page.getByRole('button', { name: '刷新状态', exact: true })
  await refreshBtn.click()
  await expect(refreshBtn.locator('svg')).toHaveClass(/animate-spin/)
  await expect(refreshBtn.locator('svg')).not.toHaveClass(/animate-spin/)

  // Stage all changes back into Staged Changes in one click.
  await page.getByRole('button', { name: '暂存全部更改', exact: true }).click()
  await expect(page.getByText('已暂存的更改 (2)', { exact: true })).toBeVisible()
  await expect(page.locator('[data-git-section="unstaged"]')).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})

test('git panel toggles between list and tree views, collapses folders, and persists preference', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()

  // Default mode is list: no folder rows are shown.
  const toggleBtn = page.getByTestId('git-view-mode-toggle')
  await expect(toggleBtn).toHaveAttribute('aria-pressed', 'false')
  await expect(toggleBtn).toHaveAttribute('title', '树形视图')
  await expect(page.locator('[data-git-dir]')).toHaveCount(0)

  // Switch to tree mode: `src` folder row appears above `src/App.tsx`.
  await toggleBtn.click()
  await expect(toggleBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(toggleBtn).toHaveAttribute('title', '列表视图')
  const srcDirRow = page.locator('[data-git-section="unstaged"][data-git-dir="src"]')
  await expect(srcDirRow).toBeVisible()
  await expect(page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('git-panel-tree-view.png'), animations: 'disabled' })

  // Collapsing the folder hides its child file row; expanding restores it.
  await srcDirRow.click()
  await expect(page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)).toHaveCount(0)
  await srcDirRow.click()
  await expect(page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)).toBeVisible()

  // Folder hover action stages files inside the folder.
  await srcDirRow.hover()
  await srcDirRow.getByRole('button', { name: '暂存 src', exact: true }).click()
  const stagedSrcDirRow = page.locator('[data-git-section="staged"][data-git-dir="src"]')
  await expect(stagedSrcDirRow).toBeVisible()
  await expect(page.locator(`[data-git-section="staged"][data-git-path="${UNSTAGED_FILE}"]`)).toBeVisible()

  // Folder hover action unstages files inside the folder back to Changes.
  await stagedSrcDirRow.hover()
  await stagedSrcDirRow.getByRole('button', { name: '取消暂存 src', exact: true }).click()
  await expect(page.locator('[data-git-section="staged"][data-git-dir="src"]')).toHaveCount(0)
  await expect(page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)).toBeVisible()

  // Preference persists across reload.
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-view-mode-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-git-section="unstaged"][data-git-dir="src"]')).toBeVisible()

  // Switch back to list mode.
  await page.getByTestId('git-view-mode-toggle').click()
  await expect(page.getByTestId('git-view-mode-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-git-dir]')).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})

test('git panel switches branches and creates a new branch in mock mode', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-branch-name')).toHaveText('main')
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('main')

  // Open the branch picker and switch to `feat/demo`.
  await page.getByTestId('git-branch-switcher').click()
  const popover = page.getByTestId('git-branch-popover')
  await expect(popover).toBeVisible()
  await expect(popover.locator('[data-git-branch="feat/demo"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('git-branch-picker.png'), animations: 'disabled' })

  await popover.locator('[data-git-branch="feat/demo"]').click()
  await expect(popover).toHaveCount(0)
  await expect(page.getByTestId('git-branch-name')).toHaveText('feat/demo')
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('feat/demo')

  // Keyboard navigation: ArrowDown + Enter switches branch, Escape & outside click close popover.
  await page.getByTestId('git-branch-switcher').click()
  await expect(popover).toBeVisible()
  const filterInput = popover.getByLabel('筛选或新建分支')
  await expect(filterInput).toBeFocused()
  await filterInput.press('ArrowDown')
  await filterInput.press('Enter')
  await expect(popover).toHaveCount(0)
  await expect(page.getByTestId('git-branch-name')).toHaveText('fix/scroll')

  await page.getByTestId('git-branch-switcher').click()
  await expect(popover).toBeVisible()
  await filterInput.press('Escape')
  await expect(popover).toHaveCount(0)

  await page.getByTestId('git-branch-switcher').click()
  await expect(popover).toBeVisible()
  await page.locator('main').click()
  await expect(popover).toHaveCount(0)

  // Open the picker again, filter and create a brand-new branch.
  await page.getByTestId('git-branch-switcher').click()
  await expect(popover).toBeVisible()
  await popover.getByLabel('筛选或新建分支').fill('feat/e2e-branch')
  await popover.locator('[data-git-create-branch="feat/e2e-branch"]').click()
  await expect(popover).toHaveCount(0)
  await expect(page.getByTestId('git-branch-name')).toHaveText('feat/e2e-branch')
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('feat/e2e-branch')

  expect(consoleErrors).toEqual([])
})
