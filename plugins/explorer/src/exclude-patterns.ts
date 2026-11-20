import { createServiceKey } from '@lite-ide/kernel'
import { createMemo, createSignal, type Accessor } from 'solid-js'

/** 参与排除匹配的最小条目形态（DirEntry 的子集，便于单测构造）。 */
export interface ExcludableEntry {
  name: string
  relPath: string
  isDir: boolean
}

export interface ExcludeRule {
  /** 原始模式（已 trim） */
  readonly pattern: string
  readonly regex: RegExp
  /** 以 `/` 结尾的模式仅匹配目录 */
  readonly dirOnly: boolean
  /** 含 `/` 的模式按相对路径匹配，否则按文件名匹配任意层级 */
  readonly pathScoped: boolean
}

export interface ExplorerExcludeService {
  /** 已清洗（trim、去空、去重）的排除模式，响应式更新 */
  readonly patterns: Accessor<readonly string[]>
  /** 覆盖式写入并持久化；传入原始文本行即可，内部负责清洗 */
  setPatterns(raw: readonly string[]): void
  readonly rules: Accessor<readonly ExcludeRule[]>
  matches(entry: ExcludableEntry): boolean
}

export const ExplorerExcludeStateKey = createServiceKey<ExplorerExcludeService>(
  'plugin.explorer.excludeState',
)

export const EXCLUDE_STORAGE_KEY = 'lite-ide.explorer.exclude.v1'

/**
 * glob 模式 → 全串匹配正则：
 * - 以 `**` 开头并后接目录分隔符时，前缀可匹配零层或多层目录（`temp` 与 `a/b/temp` 均命中）
 * - `**` 跨目录段、`*` 单段内任意字符、`?` 单字符；其余字符按字面量转义
 * - 不含 `/` 的模式对文件名匹配，含 `/` 的模式对 relPath（`/` 分隔）匹配
 */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

export function compileExcludeRule(pattern: string): ExcludeRule {
  const dirOnly = pattern.endsWith('/')
  let body = dirOnly ? pattern.slice(0, -1) : pattern
  // 前导 `/` 为根目录锚定（gitignore 惯例）：`/build` 只隐藏根下的 build。
  const rootAnchored = body.startsWith('/')
  if (rootAnchored) body = body.slice(1)
  return {
    pattern,
    regex: globToRegExp(body),
    dirOnly,
    pathScoped: rootAnchored || body.includes('/'),
  }
}

/** 逐条 trim、丢弃空行并按出现顺序去重。 */
export function sanitizeExcludePatterns(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    const pattern = item.trim()
    if (!pattern || seen.has(pattern)) continue
    seen.add(pattern)
    result.push(pattern)
  }
  return result
}

function readStoredPatterns(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const stored = localStorage.getItem(EXCLUDE_STORAGE_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return sanitizeExcludePatterns(parsed.filter((p): p is string => typeof p === 'string'))
  } catch {
    return []
  }
}

function persistPatterns(patterns: readonly string[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(EXCLUDE_STORAGE_KEY, JSON.stringify(patterns))
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

/** 全局（跨项目共享）的文件树排除规则状态，由 explorer 插件在内核层提供。 */
export function createExplorerExcludeService(): ExplorerExcludeService {
  const [patterns, setPatternsSignal] = createSignal<readonly string[]>(readStoredPatterns())
  const rules = createMemo(() => patterns().map(compileExcludeRule))

  return {
    patterns,
    rules,
    setPatterns(raw) {
      const cleaned = sanitizeExcludePatterns(raw)
      setPatternsSignal(cleaned)
      persistPatterns(cleaned)
    },
    matches(entry) {
      const relPath = entry.relPath.replace(/\\/g, '/')
      for (const rule of rules()) {
        if (rule.dirOnly && !entry.isDir) continue
        const target = rule.pathScoped ? relPath : entry.name
        if (rule.regex.test(target)) return true
      }
      return false
    },
  }
}
