import { expect, test, type Page } from '@playwright/test'

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  return errors
}

test('audio preview loads wav metadata, waveform, playback controls, and mode switcher', async ({
  page,
}, testInfo) => {
  const consoleErrors = trackConsoleErrors(page)

  await page.goto('/')
  await expect(page.getByRole('tree')).toBeVisible()

  // Expand assets/ and open the demo chime.wav audio asset.
  await page.getByRole('treeitem', { name: 'assets' }).click()
  const wavItem = page.getByRole('treeitem', { name: 'chime.wav' })
  await expect(wavItem).toBeVisible()
  await wavItem.click()

  const region = page.getByRole('region', { name: '音频预览：chime.wav' })
  await expect(region).toBeVisible()
  await expect(region.getByText('audio/wav')).toBeVisible()

  // Wait for audio metadata & waveform decoding (e.g. 48 kHz 单声道, ~0.75s -> 0:00.8).
  await expect(region.getByText(/^\d+(\.\d+)? kHz$/)).toBeVisible()
  await expect(region.getByText('单声道')).toBeVisible()
  await expect(region.getByText('/ 0:00.8')).toBeVisible()

  const audio = region.locator('audio')
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState))
    .toBeGreaterThanOrEqual(1)

  await page.screenshot({ path: testInfo.outputPath('audio-preview.png'), animations: 'disabled' })

  // Enable loop before Play/Pause check so the 0.75s clip never ends mid-assertion.
  const loopBtn = region.getByRole('button', { name: '切换循环' })
  await loopBtn.click()
  await expect(loopBtn).toHaveAttribute('aria-pressed', 'true')
  expect(await audio.evaluate((el: HTMLAudioElement) => el.loop)).toBe(true)

  const playBtn = region.getByRole('button', { name: '播放' })
  await playBtn.click()
  await expect(region.getByRole('button', { name: '暂停' })).toBeVisible()
  await region.getByRole('button', { name: '暂停' }).click()
  await expect(region.getByRole('button', { name: '播放' })).toBeVisible()

  // Speed and mute controls update the underlying <audio> state.
  await region.getByRole('button', { name: '1.5x' }).click()
  expect(await audio.evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(1.5)

  const muteBtn = region.getByRole('button', { name: '静音' })
  await muteBtn.click()
  await expect(region.getByRole('button', { name: '取消静音' })).toBeVisible()
  expect(await audio.evaluate((el: HTMLAudioElement) => el.muted)).toBe(true)

  // Mode switcher can toggle between 声音 and 信息 (fallback) previewers.
  await page.getByRole('button', { name: '信息', exact: true }).click()
  await expect(page.getByText('二进制文件无法在文本预览器中显示')).toBeVisible()
  await page.getByRole('button', { name: '声音', exact: true }).click()
  await expect(region).toBeVisible()

  expect(consoleErrors).toEqual([])
})
