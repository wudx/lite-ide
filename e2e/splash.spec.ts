import { expect, test } from '@playwright/test'

test('shows centered logo splash during boot and reveals workbench only after ready', async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))

  // Hold main.tsx briefly so we can deterministically inspect & screenshot the
  // initial logo-only splash screen before JS initialization finishes.
  let releaseMain!: () => void
  const mainHeld = new Promise<void>((resolve) => {
    releaseMain = resolve
  })
  let mainIntercepted = false
  await page.route('**/src/main.tsx*', async (route) => {
    mainIntercepted = true
    await mainHeld
    await route.continue()
  })

  const navPromise = page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => mainIntercepted).toBe(true)

  const splash = page.locator('#app-splash')
  await expect(splash).toBeVisible()

  const logo = splash.locator('img.app-splash-logo')
  await expect(logo).toBeVisible()
  await expect(logo).toHaveAttribute('src', '/icon.png')

  // Splash should cover the entire viewport cleanly with only the centered logo.
  const viewport = page.viewportSize()
  const splashBox = await splash.boundingBox()
  const logoBox = await logo.boundingBox()
  expect(viewport).not.toBeNull()
  expect(splashBox).not.toBeNull()
  expect(logoBox).not.toBeNull()
  if (viewport && splashBox && logoBox) {
    expect(splashBox.width).toBeGreaterThanOrEqual(viewport.width)
    expect(splashBox.height).toBeGreaterThanOrEqual(viewport.height)
    const logoCenterX = logoBox.x + logoBox.width / 2
    const logoCenterY = logoBox.y + logoBox.height / 2
    expect(Math.abs(logoCenterX - viewport.width / 2)).toBeLessThan(2)
    expect(Math.abs(logoCenterY - viewport.height / 2)).toBeLessThan(2)
  }

  // Main workbench should not be visible while splash is covering it.
  await expect(page.getByRole('tree')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('splash-visible.png'), animations: 'disabled' })

  // Release main.tsx and verify splash fades out and is removed once ready.
  releaseMain()
  await navPromise

  await expect(page.getByRole('tree')).toBeVisible()
  await expect(page.locator('#app-splash')).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('splash-dismissed.png'),
    animations: 'disabled',
  })

  expect(consoleErrors).toEqual([])
})
