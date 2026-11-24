import type { GitDiffFile, GitFileStatus } from '@lite-ide/protocol'
import { DEFAULT_COMMIT_SYSTEM_PROMPT } from '@lite-ide/workbench'

export { DEFAULT_COMMIT_SYSTEM_PROMPT }

/**
 * Prompt assembly for AI commit-message generation. Kept free of SolidJS and
 * store dependencies so the selection heuristics stay unit-testable.
 */

export interface CommitMessageOptions {
  /** User-defined system prompt from the models settings section. */
  customPrompt?: string
  /** Cap on files carrying full diffs (most important ones win). */
  maxFiles?: number
  /** Global character budget for concatenated diffs. */
  maxTotalChars?: number
  /** Per-file character budget for a single patch. */
  maxFileChars?: number
}

export interface CommitPromptContext {
  /** Staged entries (preferred) or the stageable unstaged fallback. */
  entries: GitFileStatus[]
  /** Per-file patches from `GitBackend.diff` (may be a subset of entries). */
  diffs: GitDiffFile[]
}

export interface SelectedDiff {
  relPath: string
  patch: string
  truncated: boolean
}

export interface CommitPrompt {
  system: string
  user: string
}

/** Extensions considered "key code files" for the priority ranking. */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'kt', 'kts',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'rb', 'vue',
  'svelte', 'dart', 'scala', 'ex', 'exs', 'zig', 'lua', 'sql', 'proto', 'gradle',
])

/** Build/config files carry context but rarely drive the commit subject. */
const CONFIG_EXTENSIONS = new Set([
  'json', 'toml', 'yaml', 'yml', 'xml', 'properties', 'ini', 'cfg', 'env',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmake', 'mk',
])

const STYLE_EXTENSIONS = new Set(['css', 'scss', 'less', 'sass', 'html', 'htm'])

/** Lockfiles, asset metadata, bundles and build output never carry useful commit context. */
const NOISE_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|packages\.lock\.json)$/i,
  /(^|\/)(node_modules|dist|build|out|coverage|\.vite|\.turbo|\.next)\//,
  /\.(meta|min\.js|min\.css|map|snap|lock)$/i,
]

const DEFAULT_MAX_FILES = 12
const DEFAULT_MAX_TOTAL_CHARS = 16000
const DEFAULT_MAX_FILE_CHARS = 4000

/** True when git emitted a binary diff placeholder without textual hunks. */
function isBinaryPatch(patch: string): boolean {
  if (/^@@ /m.test(patch)) return false
  return /^(?:Binary files .+ differ|GIT binary patch)/m.test(patch)
}

function extensionOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return base.toLowerCase()
  return base.slice(dot + 1).toLowerCase()
}

/**
 * Importance score used to pick the "key code files" when many files change.
 * `0` is neutral (docs, unknown); source code ranks highest; lockfiles and
 * build output go negative and are excluded from the diff payload entirely.
 */
export function fileImportanceScore(relPath: string): number {
  const normalized = relPath.replace(/\\/g, '/')
  if (NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) return -100
  const ext = extensionOf(relPath)
  if (CODE_EXTENSIONS.has(ext)) return 30
  if (CONFIG_EXTENSIONS.has(ext)) return 10
  if (STYLE_EXTENSIONS.has(ext)) return 5
  return 0
}

export interface KeyDiffSelection {
  selected: SelectedDiff[]
  /** Files that did not make the budget (listed by path only in the prompt). */
  overflowPaths: string[]
}

/**
 * Picks the most informative diffs within the given budgets: key code files
 * first (ties broken by patch size), excluding noise and binary diff stubs.
 * When `options.maxFileChars` is omitted, any remaining total budget after the
 * initial fair-share pass is redistributed to truncated key files.
 */
export function selectKeyDiffs(
  diffs: GitDiffFile[],
  options: CommitMessageOptions = {},
): KeyDiffSelection {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS
  const hasExplicitFileCap = options.maxFileChars !== undefined
  const perFileCap = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS

  const ranked = diffs
    .map((diff) => ({
      diff,
      score: fileImportanceScore(diff.relPath),
      size: diff.patch.length,
    }))
    .sort((a, b) => b.score - a.score || b.size - a.size)

  interface SelectionEntry {
    relPath: string
    fullPatch: string
    length: number
  }

  const chosen: SelectionEntry[] = []
  const overflowPaths: string[] = []
  let total = 0
  for (const item of ranked) {
    if (
      item.score < 0 ||
      isBinaryPatch(item.diff.patch) ||
      chosen.length >= maxFiles ||
      total >= maxTotalChars
    ) {
      overflowPaths.push(item.diff.relPath)
      continue
    }
    const budget = Math.min(perFileCap, maxTotalChars - total)
    const length = Math.min(item.diff.patch.length, budget)
    chosen.push({ relPath: item.diff.relPath, fullPatch: item.diff.patch, length })
    total += length
  }

  // Redistribute leftover global budget across truncated files so core code
  // changes aren't needlessly cut off when total budget has headroom.
  if (!hasExplicitFileCap && total < maxTotalChars) {
    let remaining = maxTotalChars - total
    while (remaining > 0) {
      const pending = chosen.filter((entry) => entry.length < entry.fullPatch.length)
      if (pending.length === 0) break
      const share = Math.max(1, Math.floor(remaining / pending.length))
      for (const entry of pending) {
        if (remaining <= 0) break
        const extra = Math.min(entry.fullPatch.length - entry.length, share, remaining)
        entry.length += extra
        remaining -= extra
      }
    }
  }

  const selected: SelectedDiff[] = chosen.map((entry) => {
    const truncated = entry.length < entry.fullPatch.length
    return {
      relPath: entry.relPath,
      patch: truncated ? entry.fullPatch.slice(0, entry.length) : entry.fullPatch,
      truncated,
    }
  })
  return { selected, overflowPaths }
}

/** Status letter for a prompt listing (index letter wins, else worktree). */
function entryStatusLetter(entry: GitFileStatus): string {
  if (entry.x && entry.x !== ' ' && entry.x !== '?') return entry.x
  if (entry.y && entry.y !== ' ' && entry.y !== '?') return entry.y
  return entry.x !== ' ' ? entry.x : entry.y
}

/**
 * Builds the chat messages for commit-message generation. A non-empty custom
 * prompt replaces the default system instruction verbatim; the user message
 * carries the change overview, the selected key diffs and the overflow list.
 */
export function buildCommitMessagePrompt(
  context: CommitPromptContext,
  options: CommitMessageOptions = {},
): CommitPrompt {
  const custom = options.customPrompt?.trim()
  const system = custom ? custom : DEFAULT_COMMIT_SYSTEM_PROMPT

  const { selected, overflowPaths } = selectKeyDiffs(context.diffs, options)

  const lines: string[] = ['请根据以下 Git 变更生成一条提交信息。', '']
  lines.push(`变更文件（共 ${context.entries.length} 个）：`)
  for (const entry of context.entries) {
    lines.push(`- [${entryStatusLetter(entry)}] ${entry.relPath}`)
  }
  if (selected.length > 0) {
    lines.push('', '重点文件 diff：')
    for (const item of selected) {
      lines.push('', `文件：${item.relPath}${item.truncated ? '（diff 已截断）' : ''}`)
      lines.push(item.patch)
    }
  }
  if (overflowPaths.length > 0) {
    lines.push('', `以下文件未附带 diff（非重点或超出预算）：${overflowPaths.join(', ')}`)
  }
  lines.push('', '请只输出提交信息本身。')
  return { system, user: lines.join('\n') }
}

/** Removes a wrapping Markdown code fence if the model added one. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}
