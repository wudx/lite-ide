import { expect, test } from '@playwright/test'

// Mock-mode demo project's preset CSV diff (see createMockGitBackend):
// the uptime row changes one cell and the throughput row is added.
const CSV_FILE = 'data/metrics.csv'
const NON_TABULAR_FILE = 'src/App.tsx'

test('csv diff renders an aligned table view with cell-level highlights', async ({
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

  const csvRow = page.locator(`[data-git-section="unstaged"][data-git-path="${CSV_FILE}"]`)
  await csvRow.click()

  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'unstaged')

  // Tabular files expose the third "表格" view mode; default stays unified.
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'unified')
  await diffView.locator('[data-testid="git-diff-view-toggle"][data-view="table"]').click()
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'table')

  const table = diffView.getByTestId('git-diff-table')
  await expect(table).toBeVisible()

  // Six pairs: header, changed uptime, three context rows, added throughput.
  await expect(table.locator('[data-git-diff-table-pair="header"]')).toHaveCount(1)
  await expect(table.locator('[data-git-diff-table-pair="context"]')).toHaveCount(3)
  await expect(table.locator('[data-git-diff-table-pair="added"]')).toHaveCount(1)
  await expect(table.locator('[data-git-diff-table-pair="added"]')).toContainText('throughput')

  // The uptime pair differs in exactly one column; both sides flag their
  // differing cell (old 99.99 left, new 99.98 right).
  const changedPair = table.locator('[data-git-diff-table-pair="changed"]')
  await expect(changedPair).toHaveCount(1)
  await expect(changedPair.locator('[data-git-diff-cell-changed="true"]')).toHaveCount(2)
  await expect(
    changedPair.locator('[data-git-diff-cell="right"][data-git-diff-cell-changed="true"]'),
  ).toContainText('99.98')
  await expect(
    changedPair.locator('[data-git-diff-cell="left"][data-git-diff-cell-changed="true"]'),
  ).toContainText('99.99')
  await expect(table.locator('[data-git-diff-cell-changed="true"]')).toHaveCount(2)

  await page.screenshot({ path: testInfo.outputPath('git-diff-table.png'), animations: 'disabled' })

  // The table preference persists across reload.
  await page.reload()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('button', { name: 'Git', exact: true }).click()
  await page.locator(`[data-git-section="unstaged"][data-git-path="${CSV_FILE}"]`).click()
  await expect(page.getByTestId('git-diff-view')).toHaveAttribute('data-git-diff-view-mode', 'table')
  await expect(page.getByTestId('git-diff-table')).toBeVisible()

  // Non-tabular files fall back to the unified view and hide the table toggle.
  await page.locator(`[data-git-section="unstaged"][data-git-path="${NON_TABULAR_FILE}"]`).click()
  const codeDiffView = page.getByTestId('git-diff-view')
  await expect(codeDiffView).toHaveAttribute('data-git-diff-view-mode', 'unified')
  await expect(codeDiffView.locator('[data-testid="git-diff-view-toggle"][data-view="table"]')).toHaveCount(0)

  // Switching back to the csv restores the persisted table view.
  await page.locator(`[data-git-section="unstaged"][data-git-path="${CSV_FILE}"]`).click()
  await expect(page.getByTestId('git-diff-view')).toHaveAttribute('data-git-diff-view-mode', 'table')

  expect(consoleErrors).toEqual([])
})
