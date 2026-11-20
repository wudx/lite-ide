import type { GitDiffFile, GitFileStatus } from '@lite-ide/protocol'

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

export const DEFAULT_COMMIT_SYSTEM_PROMPT = [
  '你是一名资深软件工程师，请根据提供的代码变更生成一条 Git 提交信息。',
  '要求：',
  '1. 首行使用 Conventional Commits 格式「type(scope): 描述」，type 从 feat/fix/docs/style/refactor/perf/test/build/ci/chore 中选择；描述简明扼要，结尾不加句号。',
  '2. 空一行后可用「- 」开头的要点列出主要改动，最多 5 条；改动很小时省略正文。',
  '3. 只输出提交信息本身，不要输出 Markdown 代码块、解释或任何额外内容。',
].join('\n')

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

/** Lockfiles, bundles and build output never carry useful commit context. */
const NOISE_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|packages\.lock\.json)$/i,
  /(^|\/)(node_modules|dist|build|out|coverage|\.vite|\.turbo|\.next)\//,
  /\.(min\.js|min\.css|map|snap|lock)$/i,
]

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
 * first (ties broken by patch size), each patch clamped to `maxFileChars`,
 * stopping once `maxFiles` or `maxTotalChars` is reached.
 */
export function selectKeyDiffs(
  diffs: GitDiffFile[],
  options: CommitMessageOptions = {},
): KeyDiffSelection {
  const maxFiles = options.maxFiles ?? 12
  const maxTotalChars = options.maxTotalChars ?? 12000
  const maxFileChars = options.maxFileChars ?? 2400

  const ranked = diffs
    .map((diff) => ({
      diff,
      score: fileImportanceScore(diff.relPath),
      size: diff.patch.length,
    }))
    .sort((a, b) => b.score - a.score || b.size - a.size)

  const selected: SelectedDiff[] = []
  const overflowPaths: string[] = []
  let total = 0
  for (const item of ranked) {
    if (item.score < 0 || selected.length >= maxFiles || total >= maxTotalChars) {
      overflowPaths.push(item.diff.relPath)
      continue
    }
    const budget = Math.min(maxFileChars, maxTotalChars - total)
    const truncated = item.diff.patch.length > budget
    const patch = truncated ? item.diff.patch.slice(0, budget) : item.diff.patch
    selected.push({ relPath: item.diff.relPath, patch, truncated })
    total += patch.length
  }
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
