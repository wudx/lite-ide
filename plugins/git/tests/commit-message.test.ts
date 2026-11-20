import type { GitDiffFile, GitFileStatus } from '@lite-ide/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildCommitMessagePrompt,
  DEFAULT_COMMIT_SYSTEM_PROMPT,
  fileImportanceScore,
  selectKeyDiffs,
  stripCodeFence,
} from '../src/commit-message'

function diff(relPath: string, patch = `diff --git a/${relPath} b/${relPath}\n+++ b/${relPath}`): GitDiffFile {
  return { relPath, patch }
}

function entry(relPath: string, x = ' ', y = 'M'): GitFileStatus {
  return { x, y, relPath }
}

describe('fileImportanceScore', () => {
  it('ranks source code above config above docs', () => {
    expect(fileImportanceScore('src/app.ts')).toBe(30)
    expect(fileImportanceScore('src/main.rs')).toBe(30)
    expect(fileImportanceScore('src/App.tsx')).toBe(30)
    expect(fileImportanceScore('config/settings.json')).toBe(10)
    expect(fileImportanceScore('styles/app.css')).toBe(5)
    expect(fileImportanceScore('docs/notes.md')).toBe(0)
    expect(fileImportanceScore('unknown.xyz')).toBe(0)
  })

  it('excludes lockfiles and build output', () => {
    expect(fileImportanceScore('package-lock.json')).toBe(-100)
    expect(fileImportanceScore('pnpm-lock.yaml')).toBe(-100)
    expect(fileImportanceScore('src-tauri/Cargo.lock')).toBe(-100)
    expect(fileImportanceScore('apps/web/dist/index.js')).toBe(-100)
    expect(fileImportanceScore('lib/parser.min.js')).toBe(-100)
    expect(fileImportanceScore('packages/a/bundle.js.map')).toBe(-100)
  })
})

describe('selectKeyDiffs', () => {
  it('prefers key code files and sorts ties by patch size', () => {
    const diffs = [
      diff('docs/readme.md', 'x'.repeat(5000)),
      diff('src/small.ts', 'a'.repeat(100)),
      diff('src/huge.rs', 'b'.repeat(4000)),
      diff('package-lock.json', 'c'.repeat(8000)),
    ]
    const { selected, overflowPaths } = selectKeyDiffs(diffs, { maxFiles: 2 })
    expect(selected.map((s) => s.relPath)).toEqual(['src/huge.rs', 'src/small.ts'])
    expect(overflowPaths).toEqual(['docs/readme.md', 'package-lock.json'])
  })

  it('clamps per-file patches and stops at the total budget', () => {
    const diffs = [
      diff('a.ts', 'x'.repeat(600)),
      diff('b.ts', 'y'.repeat(600)),
      diff('c.ts', 'z'.repeat(600)),
    ]
    const { selected, overflowPaths } = selectKeyDiffs(diffs, {
      maxFiles: 10,
      maxTotalChars: 1000,
      maxFileChars: 500,
    })
    expect(selected).toHaveLength(2)
    expect(selected[0].patch).toHaveLength(500)
    expect(selected[0].truncated).toBe(true)
    expect(selected[1].patch).toHaveLength(500)
    expect(overflowPaths).toEqual(['c.ts'])
  })

  it('keeps patches intact within budgets', () => {
    const { selected } = selectKeyDiffs([diff('a.ts', 'x'.repeat(120))], {
      maxFileChars: 500,
    })
    expect(selected[0].truncated).toBe(false)
    expect(selected[0].patch).toHaveLength(120)
  })
})

describe('buildCommitMessagePrompt', () => {
  it('uses the default system prompt and lists changes plus key diffs', () => {
    const prompt = buildCommitMessagePrompt({
      entries: [entry('src/app.ts', 'M', ' '), entry('notes.txt', '?', '?')],
      diffs: [diff('src/app.ts', 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b')],
    })
    expect(prompt.system).toBe(DEFAULT_COMMIT_SYSTEM_PROMPT)
    expect(prompt.user).toContain('变更文件（共 2 个）：')
    expect(prompt.user).toContain('- [M] src/app.ts')
    expect(prompt.user).toContain('- [?] notes.txt')
    expect(prompt.user).toContain('重点文件 diff：')
    expect(prompt.user).toContain('文件：src/app.ts')
    expect(prompt.user).toContain('@@ -1 +1 @@')
    expect(prompt.user).not.toContain('未附带 diff')
  })

  it('lists overflow files by path and marks truncated diffs', () => {
    const longPatch = 'x'.repeat(300)
    const prompt = buildCommitMessagePrompt(
      {
        entries: [entry('a.ts', 'M', ' '), entry('pnpm-lock.yaml', 'M', ' ')],
        diffs: [diff('a.ts', longPatch), diff('pnpm-lock.yaml', longPatch)],
      },
      { maxFileChars: 100 },
    )
    expect(prompt.user).toContain('文件：a.ts（diff 已截断）')
    expect(prompt.user).toContain('未附带 diff（非重点或超出预算）：pnpm-lock.yaml')
    expect(prompt.user).not.toContain('pnpm-lock.yaml\n' + longPatch)
  })

  it('replaces the system prompt with the custom prompt verbatim', () => {
    const custom = 'Use English, concise Conventional Commits.'
    const prompt = buildCommitMessagePrompt(
      { entries: [entry('a.ts', 'M', ' ')], diffs: [] },
      { customPrompt: `  ${custom}  ` },
    )
    expect(prompt.system).toBe(custom)
    expect(prompt.system).not.toContain('资深软件工程师')
  })
})

describe('stripCodeFence', () => {
  it('removes a wrapping markdown code fence', () => {
    expect(stripCodeFence('```\nfeat: x\n```')).toBe('feat: x')
    expect(stripCodeFence('```text\nfeat: x\nbody\n```')).toBe('feat: x\nbody')
  })

  it('keeps plain messages untouched', () => {
    expect(stripCodeFence('feat: x')).toBe('feat: x')
    // Inline fences in the middle of a message are preserved.
    expect(stripCodeFence('uses ```code``` inline')).toBe('uses ```code``` inline')
  })
})
