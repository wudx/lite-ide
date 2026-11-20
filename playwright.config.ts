import { defineConfig } from '@playwright/test'

// E2E server port: 1420 by default (matches `pnpm dev`); override with
// E2E_PORT when 1420 is already taken by another checkout on this machine.
const port = Number(process.env.E2E_PORT ?? 1420)

// E2E_BROWSER_CHANNEL selects a system browser (e.g. "msedge", "chrome") to
// avoid downloading the bundled Chromium; leave unset for default Chromium.
const channel = process.env.E2E_BROWSER_CHANNEL

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    // Pin 127.0.0.1: vite only binds the IPv6 loopback by default on Windows,
    // while "localhost" can resolve to IPv4 first.
    baseURL: `http://127.0.0.1:${port}`,
    channel: channel || undefined,
    locale: 'zh-CN',
    // Clipboard assertions need the async Clipboard API permissions.
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    command: `node apps/desktop/node_modules/vite/bin/vite.js apps/desktop --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
