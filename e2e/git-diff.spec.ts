import { expect, test } from '@playwright/test'

// Mock-mode demo project opened automatically on a fresh localStorage.
const STAGED_FILE = 'README.md'
const UNSTAGED_FILE = 'src/App.tsx'

test('clicking a git panel change row opens the diff preview', async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await expect(page.getByTestId('git-branch-name')).toHaveText('main')

  // Clicking the staged README.md row opens its diff in the preview area.
  const stagedRow = page.locator(`[data-git-section="staged"][data-git-path="${STAGED_FILE}"]`)
  await stagedRow.click()

  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'staged')
  // The document tab strip is the first tablist in the preview host.
  await expect(page.getByRole('tablist', { name: '编辑器标签页' }).locator('[aria-selected="true"]')).toContainText(STAGED_FILE)

  // The mock staged diff swaps one line: one deletion, one addition.
  await expect(diffView.locator('[data-git-diff-kind="del"]')).toHaveCount(1)
  await expect(diffView.locator('[data-git-diff-kind="add"]')).toHaveCount(1)
  await expect(diffView.getByTestId('git-diff-stats')).toContainText('+1')
  await expect(diffView.getByTestId('git-diff-stats')).toContainText('−1')
  await expect(diffView.locator('[data-git-diff-kind="add"]')).toContainText('Audio waveform')

  await page.screenshot({ path: testInfo.outputPath('git-diff-staged.png'), animations: 'disabled' })

  // Switching to the unstaged comparison shows the empty state: README.md has
  // no unstaged changes in the demo repo.
  await diffView.locator('[data-testid="git-diff-section"][data-section="unstaged"]').click()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'unstaged')
  await expect(diffView.getByText('此对比范围暂无差异。')).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath('git-diff-staged-empty.png'), animations: 'disabled' })

  expect(consoleErrors).toEqual([])
})

test('clicking an unstaged row and toggling sections updates the diff', async ({
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

  const unstagedRow = page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)
  await unstagedRow.click()

  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'unstaged')
  await expect(page.getByRole('tablist', { name: '编辑器标签页' }).locator('[aria-selected="true"]')).toContainText('App.tsx')
  await expect(diffView.locator('[data-git-diff-kind="del"]')).toHaveCount(2)
  await expect(diffView.locator('[data-git-diff-kind="add"]')).toHaveCount(2)
  await expect(diffView.locator('[data-git-diff-kind="add"]').first()).toContainText('counter-btn')

  await page.screenshot({ path: testInfo.outputPath('git-diff-unstaged.png'), animations: 'disabled' })

  // The staged comparison is empty for this file before it gets staged.
  await diffView.locator('[data-testid="git-diff-section"][data-section="staged"]').click()
  await expect(diffView.getByText('此对比范围暂无差异。')).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('diff preview survives stage/unstage round-trips and coexists with the code previewer', async ({
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

  // Open the unstaged diff of src/App.tsx.
  const unstagedRow = page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)
  await unstagedRow.click()
  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'unstaged')
  await expect(diffView.locator('[data-git-diff-kind="add"]')).toHaveCount(2)

  // Stage the change from the panel: the diff goes empty because the worktree
  // now matches the index, and the file moves to the staged section.
  await unstagedRow.hover()
  await unstagedRow.getByRole('button', { name: `暂存 ${UNSTAGED_FILE}` }).click()
  await expect(
    page.locator(`[data-git-section="staged"][data-git-path="${UNSTAGED_FILE}"]`),
  ).toBeVisible()
  await expect(diffView.getByText('此对比范围暂无差异。')).toBeVisible()

  // Re-open from the staged section: the same change shows as staged.
  await page
    .locator(`[data-git-section="staged"][data-git-path="${UNSTAGED_FILE}"]`)
    .click()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'staged')
  await expect(diffView.locator('[data-git-diff-kind="add"]').first()).toContainText('counter-btn')

  await page.screenshot({ path: testInfo.outputPath('git-diff-after-stage.png'), animations: 'disabled' })

  // The previewer pill still allows falling back to the code editor and back.
  const codePill = page.getByRole('button', { name: '代码', exact: true })
  await expect(codePill).toBeVisible()
  await codePill.click()
  await expect(page.locator('.cm-editor').first()).toBeVisible()
  await expect(page.getByTestId('git-diff-view')).toHaveCount(0)

  const diffPill = page.getByRole('button', { name: '差异', exact: true })
  await diffPill.click()
  await expect(page.getByTestId('git-diff-view')).toBeVisible()

  expect(consoleErrors).toEqual([])
})

test('diff preview toggles between unified and side-by-side views and persists', async ({
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

  const unstagedRow = page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`)
  await unstagedRow.click()
  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()

  // Default is the unified view.
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'unified')
  await expect(diffView.locator('[data-git-diff-kind="del"]')).toHaveCount(2)

  // Switch to the side-by-side view: old lines pair with new lines.
  await diffView.locator('[data-testid="git-diff-view-toggle"][data-view="split"]').click()
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'split')
  const splitRows = diffView.locator('[data-git-diff-split-row]')
  await expect(splitRows).toHaveCount(10)
  // The hunk pairs the two removed lines with the two added lines in order:
  // pairs 0-4 are context, pair 5 pairs the button lines, pair 6 the texts.
  await expect(splitRows.nth(5).locator('[data-git-diff-side="left"]')).toContainText(
    '<button onClick=',
  )
  await expect(splitRows.nth(5).locator('[data-git-diff-side="right"]')).toContainText('counter-btn')
  await expect(splitRows.nth(6).locator('[data-git-diff-side="left"]')).toContainText(
    'Active Count: {count()}',
  )
  await expect(splitRows.nth(6).locator('[data-git-diff-side="right"]')).toContainText(
    'Clicked {count()} times',
  )
  // Left gutters show old numbers, right gutters show new numbers.
  await expect(splitRows.nth(5).locator('[data-git-diff-side="left"] span').first()).toHaveText('6')
  await expect(splitRows.nth(5).locator('[data-git-diff-side="right"] span').first()).toHaveText('6')

  await page.screenshot({ path: testInfo.outputPath('git-diff-split.png'), animations: 'disabled' })

  // The preference persists across reload; reopening the diff restores split view.
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.locator(`[data-git-section="unstaged"][data-git-path="${UNSTAGED_FILE}"]`).click()
  await expect(page.getByTestId('git-diff-view')).toHaveAttribute('data-git-diff-view-mode', 'split')

  // Switching back to unified restores the inline rows.
  await page.getByTestId('git-diff-view').locator('[data-testid="git-diff-view-toggle"][data-view="unified"]').click()
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'unified')
  await expect(diffView.locator('[data-git-diff-kind="del"]')).toHaveCount(2)
  await expect(diffView.locator('[data-git-diff-split-row]')).toHaveCount(0)

  expect(consoleErrors).toEqual([])
})
