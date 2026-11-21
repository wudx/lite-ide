import { expect, test } from '@playwright/test'

// Mock-mode demo project's preset workbook: the file tree shows
// data/metrics.xlsx (bytes generated lazily by the mock git backend).
const XLSX_FILE = 'data/metrics.xlsx'

test('explorer click renders the sheet preview and jumps into the table comparison', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Expand data/ in the explorer tree and click the workbook: the sheet
  // previewer takes over instead of the binary fallback card.
  await page.getByRole('tree').getByText('data', { exact: true }).first().click()
  const sheetRow = page.getByRole('tree').getByText('metrics.xlsx', { exact: true })
  await expect(sheetRow).toBeVisible()
  await sheetRow.click()

  const preview = page.getByTestId('xlsx-table-preview')
  await expect(preview).toBeVisible()

  const table = preview.getByTestId('xlsx-sheet-table')
  await expect(table).toBeVisible()

  // Header row rendered from the first record; data rows follow with
  // 1-based row numbers starting at 2.
  await expect(table.locator('thead td')).toContainText(['metric', 'week1', 'week2', 'week3', 'updated'])
  await expect(table.locator('tbody tr')).toHaveCount(5)
  // The added throughput row sits between coverage and build_time.
  await expect(table.locator('tbody tr').nth(3)).toContainText('throughput')
  await expect(table.locator('tbody tr').nth(3)).toContainText('1480')

  // The file carries an unstaged change, so the toolbar offers the jump
  // into the Git table comparison.
  const compareBtn = preview.getByTestId('xlsx-open-comparison')
  await expect(compareBtn).toBeVisible()
  await compareBtn.click()

  // The diff previewer takes over and opens straight into the table view.
  const diffView = page.getByTestId('git-diff-view')
  await expect(diffView).toBeVisible()
  await expect(diffView).toHaveAttribute('data-git-diff-section', 'unstaged')
  await expect(diffView).toHaveAttribute('data-git-diff-view-mode', 'table')
  const diffTable = diffView.getByTestId('git-diff-table')
  await expect(diffTable).toBeVisible()
  const changedPair = diffTable.locator('[data-git-diff-table-pair="changed"]')
  await expect(changedPair).toHaveCount(1)
  await expect(changedPair.locator('[data-git-diff-cell="right"][data-cell-index="3"]')).toContainText('99.98')

  await page.screenshot({ path: testInfo.outputPath('git-xlsx-preview.png'), animations: 'disabled' })

  expect(consoleErrors).toEqual([])
})
