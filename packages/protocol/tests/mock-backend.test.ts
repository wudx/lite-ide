import type { FsDelta, TerminalEvent } from '@lite-ide/protocol'
import { describe, expect, it } from 'vitest'
import { createMockBackend, MOCK_DEMO_PATHS } from '../src/mock-backend'

describe('Mock WorkspaceBackend', () => {
  it('maintains stable modifiedMs across statPreview reads and advances on write', async () => {
    const backend = createMockBackend()
    const deltas: FsDelta[] = []
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], (d) => deltas.push(d))

    const stat1 = await backend.statPreview(info.id, 'src/kernel.ts')
    await new Promise((r) => setTimeout(r, 15))
    const stat2 = await backend.statPreview(info.id, 'src/kernel.ts')
    expect(stat2.modifiedMs).toBe(stat1.modifiedMs)

    const writeRes = await backend.writeText(info.id, 'src/kernel.ts', 'export const v = 2\n')
    expect(writeRes.meta.modifiedMs).toBeGreaterThan(stat1.modifiedMs)
    expect(writeRes.lineCount).toBe(2)

    await Promise.resolve()
    expect(deltas.some((d) => d.affectedPaths.includes('src/kernel.ts'))).toBe(true)

    const payload = await backend.readText(info.id, 'src/kernel.ts')
    expect(payload.content).toBe('export const v = 2\n')
  })

  it('supports createFile, createDir, renamePath, and deletePath with conflict checks', async () => {
    const backend = createMockBackend()
    const deltas: FsDelta[] = []
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], (d) => deltas.push(d))

    const dir = await backend.createDir(info.id, 'src/utils')
    expect(dir.isDir).toBe(true)

    const created = await backend.createFile(info.id, 'src/utils/math.ts')
    expect(created.relPath).toBe('src/utils/math.ts')
    expect(created.mime).toBe('text/typescript')

    await expect(backend.createFile(info.id, 'src/utils/math.ts')).rejects.toThrow(/already exists/i)

    const rootEntries = await backend.listDir(info.id, 'src')
    expect(rootEntries.some((e) => e.relPath === 'src/utils' && e.isDir)).toBe(true)

    await backend.writeText(info.id, 'src/utils/math.ts', 'export const add = (a: number, b: number) => a + b\n')
    const renamed = await backend.renamePath(info.id, 'src/utils', 'src/helpers')
    expect(renamed.relPath).toBe('src/helpers')

    const movedContent = await backend.readText(info.id, 'src/helpers/math.ts')
    expect(movedContent.content).toContain('export const add')

    await backend.deletePath(info.id, 'src/helpers')
    await expect(backend.statPreview(info.id, 'src/helpers/math.ts')).rejects.toThrow()
    await expect(backend.deletePath(info.id, '')).rejects.toThrow()

    await Promise.resolve()
    expect(deltas.length).toBeGreaterThan(0)
  })

  it('serves playable audio metadata and dataUrl for demo wav asset', async () => {
    const backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})

    const meta = await backend.statPreview(info.id, 'assets/chime.wav')
    expect(meta.ext).toBe('wav')
    expect(meta.mime).toBe('audio/wav')
    expect(meta.isBinary).toBe(true)
    expect(meta.size).toBeGreaterThan(44)

    const url = backend.resolveFileUrl?.(info.id, 'assets/chime.wav')
    expect(url).toMatch(/^data:audio\/wav;base64,/)
  })
})

function decodeTerminalEvents(events: TerminalEvent[]): string {
  const bytes = events.flatMap((event) => {
    if (event.type !== 'data') return []
    const binary = atob(event.base64)
    return Array.from(binary, (ch) => ch.charCodeAt(0))
  })
  return new TextDecoder().decode(new Uint8Array(bytes))
}

describe('Mock backend terminal fake shell', () => {
  it('spawns a banner, executes commands over the demo FS, and tracks cwd', async () => {
    const backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
    const events: TerminalEvent[] = []

    const handle = await backend.terminalSpawn!(info.id, {
      cols: 80,
      rows: 24,
      onEvent: (event) => events.push(event),
    })
    expect(handle.sessionId).toBeTruthy()
    expect(handle.shellLabel).toBe('LiteIDE Shell')
    const banner = decodeTerminalEvents(events)
    expect(banner).toContain('LiteIDE demo shell')
    expect(banner).toContain('help')

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'ls\r')
    const listing = decodeTerminalEvents(events)
    expect(listing).toContain('README.md')
    expect(listing).toContain('src/')
    expect(listing.endsWith('$ ')).toBe(true)

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'cd src\r')
    await backend.terminalWrite!(handle.sessionId, 'pwd\r')
    expect(decodeTerminalEvents(events)).toContain('/src')

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'echo 你好 LiteIDE\r')
    expect(decodeTerminalEvents(events)).toContain('你好 LiteIDE')

    await backend.terminalKill!(handle.sessionId)
  })

  it('supports backspace, cat, unknown commands, and exit', async () => {
    const backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
    const events: TerminalEvent[] = []
    const handle = await backend.terminalSpawn!(info.id, {
      cols: 80,
      rows: 24,
      onEvent: (event) => events.push(event),
    })

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'zz\x7f\x7f\x7fhelp\r')
    expect(decodeTerminalEvents(events)).toContain('Commands:')

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'cat README.md\r')
    expect(decodeTerminalEvents(events)).toContain('# LiteIDE Micro-Kernel Preview')

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'no-such-cmd\r')
    expect(decodeTerminalEvents(events)).toContain('no-such-cmd: command not found')

    events.length = 0
    await backend.terminalWrite!(handle.sessionId, 'exit\r')
    const exitEvents = events.filter((event) => event.type === 'exit')
    expect(exitEvents).toEqual([{ type: 'exit', code: 0 }])
  })

  it('rejects writes to unknown sessions and cleans up on project close', async () => {
    const backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
    const events: TerminalEvent[] = []
    const handle = await backend.terminalSpawn!(info.id, {
      cols: 80,
      rows: 24,
      onEvent: (event) => events.push(event),
    })

    await expect(backend.terminalWrite!('term-unknown', 'x')).rejects.toThrow(
      'Terminal session not found',
    )

    // Project close kills the live session and reports the exit.
    await backend.closeProject(info.id)
    expect(events.some((event) => event.type === 'exit')).toBe(true)

    // Idempotent kill for an already-gone session.
    await expect(backend.terminalKill!(handle.sessionId)).resolves.toBeUndefined()
  })
})
