import { expect, test } from '@playwright/test'

// Mock-mode demo project's preset spreadsheet: the uptime row changes its
// week3 cell and date, and the throughput row is added (see createMockGitBackend).
const XLSX_FILE = 'data/metrics.xlsx'

test('xlsx diff compares workbook versions as an aligned table view', async ({
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

  const xlsxRow = page.locator(`[data-git-section="unstaged"][data-git-path="${XLSX_FILE}"]`)
  await xlsxRow.click()

  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'unstaged')

  // Spreadsheets expose the table view mode; switch into it.
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'unified')
  await diffView.locator('[data-testid="git-diff-view-toggle"][data-view="table"]').click()
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'table')

  const table = diffView.getByTestId('git-diff-table')
  await expect(table).toBeVisible()

  // Pairs: header, changed uptime, three context rows, added throughput.
  await expect(table.locator('[data-git-diff-table-pair="header"]')).toHaveCount(1)
  await expect(table.locator('[data-git-diff-table-pair="context"]')).toHaveCount(3)
  await expect(table.locator('[data-git-diff-table-pair="added"]')).toHaveCount(1)
  await expect(table.locator('[data-git-diff-table-pair="added"]')).toContainText('throughput')

  // The uptime pair differs in two columns: week3 (99.99 → 99.98) and the
  // updated date (2025-11-14 → 2025-11-21) — flagged on both sides.
  const changedPair = table.locator('[data-git-diff-table-pair="changed"]')
  await expect(changedPair).toHaveCount(1)
  await expect(changedPair.locator('[data-git-diff-cell-changed="true"]')).toHaveCount(4)
  await expect(changedPair.locator('[data-git-diff-cell="right"][data-cell-index="3"]')).toContainText('99.98')
  await expect(changedPair.locator('[data-git-diff-cell="right"][data-cell-index="4"]')).toContainText('2025-11-21')
  await expect(changedPair.locator('[data-git-diff-cell="left"][data-cell-index="3"]')).toContainText('99.99')
  await expect(changedPair.locator('[data-git-diff-cell="left"][data-cell-index="4"]')).toContainText('2025-11-14')

  await page.screenshot({ path: testInfo.outputPath('git-diff-xlsx-table.png'), animations: 'disabled' })

  // The staged comparison holds no staged change for this file: empty state.
  await diffView.locator('[data-testid="git-diff-section"][data-section="staged"]').click()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'staged')
  await expect(diffView.getByText('此对比范围暂无差异。')).toBeVisible()

  expect(consoleErrors).toEqual([])
})
