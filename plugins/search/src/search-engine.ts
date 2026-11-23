import { baseNameOf, globToRegExp } from '@lite-ide/workbench'

export const SEARCH_MAX_FILE_BYTES = 1024 * 1024
export const SEARCH_MAX_FILES = 5000
export const SEARCH_MAX_MATCHES = 5000

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tiff',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus',
  'mp4', 'webm', 'mov', 'avi', 'mkv',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'pdb', 'wasm',
  'pdf', 'xlsx', 'xls', 'xlsm', 'docx', 'pptx', 'bin',
])

export interface SearchQueryOptions {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

export interface CompiledSearchPattern {
  readonly regex: RegExp
  readonly useRegex: boolean
  readonly caseSensitive: boolean
}

export interface SearchMatch {
  readonly id: string
  readonly relPath: string
  /** 1-based line number */
  readonly line: number
  /** 1-based column */
  readonly column: number
  /** Matched text length (UTF-16 code units) */
  readonly length: number
  readonly matchText: string
  readonly lineText: string
  /** 0-based start offset inside lineText */
  readonly lineOffset: number
  /** Capture array (`[match, group1, ...]`) recorded for regex matches. */
  readonly captures?: readonly string[]
  /** Named capture groups recorded for regex matches. */
  readonly groups?: Readonly<Record<string, string>>
}

export interface FileSearchResult {
  readonly relPath: string
  readonly name: string
  readonly dir: string
  readonly matches: readonly SearchMatch[]
}

export interface FilterRule {
  matches(relPath: string): boolean
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isLikelyBinaryPath(relPath: string): boolean {
  const name = baseNameOf(relPath)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export function hasNullByte(content: string): boolean {
  const limit = Math.min(content.length, 8192)
  for (let i = 0; i < limit; i += 1) {
    if (content.charCodeAt(i) === 0) return true
  }
  return false
}

export function compileSearchPattern(
  options: SearchQueryOptions,
): { ok: true; pattern: CompiledSearchPattern } | { ok: false; error: string } | null {
  if (!options.query) return null

  let source = options.useRegex ? options.query : escapeRegExp(options.query)
  if (options.wholeWord) {
    if (options.useRegex) {
      source = `\\b(?:${source})\\b`
    } else {
      const prefix = /^\w/.test(options.query) ? '(?<!\\w)' : ''
      const suffix = /\w$/.test(options.query) ? '(?!\\w)' : ''
      source = `${prefix}${source}${suffix}`
    }
  }

  const globalFlags = options.caseSensitive ? 'g' : 'gi'
  try {
    return {
      ok: true,
      pattern: {
        regex: new RegExp(source, globalFlags),
        useRegex: options.useRegex,
        caseSensitive: options.caseSensitive,
      },
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function parseFilterPatterns(raw: string): FilterRule[] {
  const parts = raw
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''))
    .filter(Boolean)

  const rules: FilterRule[] = []
  for (const part of parts) {
    const hasGlob = part.includes('*') || part.includes('?')
    const dirTrailing = part.endsWith('/')
    const clean = dirTrailing ? part.slice(0, -1) : part
    if (!clean) continue

    if (!hasGlob) {
      if (dirTrailing || clean.includes('/')) {
        const lower = clean.toLowerCase()
        const prefix = `${lower}/`
        rules.push({
          matches(relPath) {
            const p = relPath.toLowerCase()
            return p === lower || p.startsWith(prefix)
          },
        })
      } else {
        const lower = clean.toLowerCase()
        const prefix = `${lower}/`
        rules.push({
          matches(relPath) {
            const p = relPath.toLowerCase()
            const base = baseNameOf(p)
            return p === lower || p.startsWith(prefix) || base === lower
          },
        })
      }
      continue
    }

    const body = dirTrailing ? `${clean}/**` : clean
    const regex = globToRegExp(body, 'i')
    const pathScoped = body.includes('/')
    rules.push({
      matches(relPath) {
        return pathScoped ? regex.test(relPath) : regex.test(baseNameOf(relPath))
      },
    })
  }
  return rules
}

export function shouldIncludeRelPath(
  relPath: string,
  includeRules: readonly FilterRule[],
  excludeRules: readonly FilterRule[],
): boolean {
  if (includeRules.length > 0 && !includeRules.some((rule) => rule.matches(relPath))) {
    return false
  }
  if (excludeRules.some((rule) => rule.matches(relPath))) {
    return false
  }
  return true
}

interface LineSlice {
  text: string
  eol: string
}

function splitLinesPreservingEol(content: string): LineSlice[] {
  const slices: LineSlice[] = []
  let start = 0
  for (let i = 0; i < content.length; i += 1) {
    const ch = content.charCodeAt(i)
    if (ch === 13 /* \r */) {
      const eol = content.charCodeAt(i + 1) === 10 /* \n */ ? '\r\n' : '\r'
      slices.push({ text: content.slice(start, i), eol })
      if (eol.length === 2) i += 1
      start = i + 1
    } else if (ch === 10 /* \n */) {
      slices.push({ text: content.slice(start, i), eol: '\n' })
      start = i + 1
    }
  }
  if (start <= content.length) {
    slices.push({ text: content.slice(start), eol: '' })
  }
  return slices
}

export function searchFileContent(
  relPath: string,
  content: string,
  compiled: CompiledSearchPattern,
  remainingBudget = SEARCH_MAX_MATCHES,
): SearchMatch[] {
  if (remainingBudget <= 0 || !content || hasNullByte(content)) return []

  const matches: SearchMatch[] = []
  const lines = splitLinesPreservingEol(content)

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i]!.text
    if (!lineText) continue
    const line = i + 1
    compiled.regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = compiled.regex.exec(lineText)) !== null) {
      const matchText = match[0]
      if (matchText.length === 0) {
        // Avoid infinite loops on zero-width matches such as `a*` or `^`.
        compiled.regex.lastIndex = match.index + 1
        continue
      }
      matches.push({
        id: `${relPath}:${line}:${match.index + 1}`,
        relPath,
        line,
        column: match.index + 1,
        length: matchText.length,
        matchText,
        lineText,
        lineOffset: match.index,
        ...(compiled.useRegex
          ? {
              captures: Array.from(match, (item) => item ?? ''),
              ...(match.groups ? { groups: { ...match.groups } } : {}),
            }
          : {}),
      })
      if (matches.length >= remainingBudget) {
        return matches
      }
    }
  }

  return matches
}

/**
 * Expand JS replacement pattern tokens (`$$`, `$&`, ``$` ``, `$'`, `$n`, `$<name>`)
 * using pre-captured match context so lookbehind/lookahead/word-boundary regexes
 * evaluate identically to matching against the full line.
 */
function expandRegexReplacement(
  matchText: string,
  lineText: string,
  matchIndex: number,
  captures: readonly string[] | undefined,
  groups: Readonly<Record<string, string>> | undefined,
  replaceText: string,
): string {
  let out = ''
  for (let i = 0; i < replaceText.length; i += 1) {
    const ch = replaceText[i]!
    if (ch !== '$' || i + 1 >= replaceText.length) {
      out += ch
      continue
    }
    const next = replaceText[i + 1]!
    if (next === '$') {
      out += '$'
      i += 1
    } else if (next === '&') {
      out += matchText
      i += 1
    } else if (next === '`') {
      out += lineText.slice(0, matchIndex)
      i += 1
    } else if (next === "'") {
      out += lineText.slice(matchIndex + matchText.length)
      i += 1
    } else if (next === '<' && groups) {
      const closeIdx = replaceText.indexOf('>', i + 2)
      if (closeIdx > i + 2) {
        const name = replaceText.slice(i + 2, closeIdx)
        if (Object.prototype.hasOwnProperty.call(groups, name)) {
          out += groups[name] ?? ''
          i = closeIdx
          continue
        }
      }
      out += '$'
    } else if (next >= '0' && next <= '9' && captures) {
      const d2 = replaceText[i + 2]
      if (d2 !== undefined && d2 >= '0' && d2 <= '9') {
        const idx2 = Number(next + d2)
        if (idx2 >= 1 && idx2 < captures.length) {
          out += captures[idx2] ?? ''
          i += 2
          continue
        }
      }
      const idx1 = Number(next)
      if (idx1 >= 1 && idx1 < captures.length) {
        out += captures[idx1] ?? ''
        i += 1
      } else {
        out += '$'
      }
    } else {
      out += '$'
    }
  }
  return out
}

export function computeReplacementPreview(
  match: Pick<SearchMatch, 'matchText' | 'lineText' | 'lineOffset' | 'captures' | 'groups'>,
  replaceText: string,
  compiled: Pick<CompiledSearchPattern, 'useRegex'>,
): string {
  if (!compiled.useRegex) return replaceText
  return expandRegexReplacement(
    match.matchText,
    match.lineText,
    match.lineOffset,
    match.captures,
    match.groups,
    replaceText,
  )
}

export function replaceAllInContent(
  content: string,
  compiled: CompiledSearchPattern,
  replaceText: string,
): { nextContent: string; count: number } {
  if (!content) return { nextContent: content, count: 0 }

  const lines = splitLinesPreservingEol(content)
  let count = 0
  const out: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const { text, eol } = lines[i]!
    if (!text) {
      out.push(text + eol)
      continue
    }
    compiled.regex.lastIndex = 0
    let cursor = 0
    let rebuilt = ''
    let lineChanged = false
    let match: RegExpExecArray | null
    while ((match = compiled.regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        compiled.regex.lastIndex = match.index + 1
        continue
      }
      rebuilt += text.slice(cursor, match.index)
      const replacement = compiled.useRegex
        ? expandRegexReplacement(
            match[0],
            text,
            match.index,
            Array.from(match, (item) => item ?? ''),
            match.groups,
            replaceText,
          )
        : replaceText
      rebuilt += replacement
      cursor = match.index + match[0].length
      count += 1
      lineChanged = true
    }
    if (lineChanged) {
      rebuilt += text.slice(cursor)
      out.push(rebuilt + eol)
    } else {
      out.push(text + eol)
    }
  }

  return {
    nextContent: count > 0 ? out.join('') : content,
    count,
  }
}

export function replaceSingleMatchInContent(
  content: string,
  target: SearchMatch,
  compiled: Pick<CompiledSearchPattern, 'useRegex'>,
  replaceText: string,
): string | null {
  const lines = splitLinesPreservingEol(content)
  const slice = lines[target.line - 1]
  if (!slice) return null

  const actual = slice.text.slice(target.lineOffset, target.lineOffset + target.length)
  if (actual !== target.matchText) return null

  const replacement = computeReplacementPreview(
    {
      matchText: target.matchText,
      lineText: slice.text,
      lineOffset: target.lineOffset,
      captures: target.captures,
      groups: target.groups,
    },
    replaceText,
    compiled,
  )
  const updatedLine =
    slice.text.slice(0, target.lineOffset) +
    replacement +
    slice.text.slice(target.lineOffset + target.length)

  lines[target.line - 1] = { text: updatedLine, eol: slice.eol }
  return lines.map((s) => s.text + s.eol).join('')
}

export function countLines(content: string): number {
  if (!content) return 0
  let count = 1
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) count += 1
  }
  return count
}
