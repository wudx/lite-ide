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
  await expect(page.getByText('Staged Changes (1)')).toBeVisible()
  await expect(page.getByText('Changes (1)', { exact: true })).toBeVisible()

  // Statusbar mirrors the branch of the active project.
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('main')

  await page.screenshot({ path: testInfo.outputPath('git-panel-initial.png'), animations: 'disabled' })

  // Stage the unstaged file via its hover action.
  await unstagedRow.hover()
  await unstagedRow.getByRole('button', { name: `Stage ${UNSTAGED_FILE}` }).click()
  const restagedRow = page.locator(`[data-git-section="staged"][data-git-path="${UNSTAGED_FILE}"]`)
  await expect(restagedRow).toBeVisible()
  await expect(page.getByText('Staged Changes (2)', { exact: true })).toBeVisible()
  await expect(page.locator(`[data-git-section="unstaged"]`)).toHaveCount(0)

  // Commit the staged changes.
  await page.getByPlaceholder('Commit message (Ctrl+Enter to commit)').fill('feat: demo commit')
  await page.screenshot({ path: testInfo.outputPath('git-panel-staged.png'), animations: 'disabled' })
  await page.getByTestId('git-commit-button').click()

  await expect(page.getByText('Working tree clean')).toBeVisible()
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('↑1')
  await page.screenshot({ path: testInfo.outputPath('git-panel-committed.png'), animations: 'disabled' })

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

  await expect(page.getByText('Not a Git repository')).toBeVisible()
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
  await unstagedRow.getByRole('button', { name: `Discard ${UNSTAGED_FILE}` }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('git-discard-confirm.png'), animations: 'disabled' })
  await page.getByRole('dialog').getByText('Discard', { exact: true }).click()

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
  await expect(page.getByText('Staged Changes (1)')).toBeVisible()
  await expect(page.getByText('Changes (1)', { exact: true })).toBeVisible()

  // Stage all remaining unstaged changes via the section header button.
  await page.getByRole('button', { name: 'Stage All Changes', exact: true }).click()
  await expect(page.getByText('Staged Changes (2)', { exact: true })).toBeVisible()
  await expect(page.locator('[data-git-section="unstaged"]')).toHaveCount(0)
  await expect(page.locator('[data-git-section="staged"]')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('git-panel-staged-all.png'), animations: 'disabled' })

  // Unstage all staged changes at once via the Staged Changes header button.
  await page.getByRole('button', { name: 'Unstage All Changes', exact: true }).click()
  await expect(page.locator('[data-git-section="staged"]')).toHaveCount(0)
  await expect(page.getByText('Changes (2)', { exact: true })).toBeVisible()
  await expect(page.locator('[data-git-section="unstaged"]')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('git-panel-unstaged-all.png'), animations: 'disabled' })

  // Clicking the branch-header refresh button shows visible spin feedback even on fast backends.
  const refreshBtn = page.getByRole('button', { name: 'Refresh Status', exact: true })
  await refreshBtn.click()
  await expect(refreshBtn.locator('svg')).toHaveClass(/animate-spin/)
  await expect(refreshBtn.locator('svg')).not.toHaveClass(/animate-spin/)

  // Stage all changes back into Staged Changes in one click.
  await page.getByRole('button', { name: 'Stage All Changes', exact: true }).click()
  await expect(page.getByText('Staged Changes (2)', { exact: true })).toBeVisible()
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
  await expect(toggleBtn).toHaveAttribute('title', 'View as Tree')
  await expect(page.locator('[data-git-dir]')).toHaveCount(0)

  // Switch to tree mode: `src` folder row appears above `src/App.tsx`.
  await toggleBtn.click()
  await expect(toggleBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(toggleBtn).toHaveAttribute('title', 'View as List')
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
  await srcDirRow.getByRole('button', { name: 'Stage src', exact: true }).click()
  const stagedSrcDirRow = page.locator('[data-git-section="staged"][data-git-dir="src"]')
  await expect(stagedSrcDirRow).toBeVisible()
  await expect(page.locator(`[data-git-section="staged"][data-git-path="${UNSTAGED_FILE}"]`)).toBeVisible()

  // Folder hover action unstages files inside the folder back to Changes.
  await stagedSrcDirRow.hover()
  await stagedSrcDirRow.getByRole('button', { name: 'Unstage src', exact: true }).click()
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
  const filterInput = popover.getByLabel('Filter or create branch')
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
  await popover.getByLabel('Filter or create branch').fill('feat/e2e-branch')
  await popover.locator('[data-git-create-branch="feat/e2e-branch"]').click()
  await expect(popover).toHaveCount(0)
  await expect(page.getByTestId('git-branch-name')).toHaveText('feat/e2e-branch')
  await expect(page.getByTestId('statusbar-git-branch')).toContainText('feat/e2e-branch')

  expect(consoleErrors).toEqual([])
})
