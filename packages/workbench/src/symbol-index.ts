import { createServiceKey } from '@lite-ide/kernel'
import type { WorkspaceBackend } from '@lite-ide/protocol'
import { createSignal } from 'solid-js'
import { buildFileIndex, WALK_CONCURRENCY } from './quick-open'

/**
 * Lightweight, regex-based project symbol index powering the code navigation
 * actions (go to definition / find references / go to implementation). It is
 * intentionally heuristic — no language server — so resolution works offline
 * for any workspace the file walker can reach.
 */

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'trait'
  | 'struct'
  | 'enum'
  | 'function'
  | 'method'
  | 'type'
  | 'const'
  | 'variable'
  | 'module'
  | 'impl'
  | 'macro'

export interface SymbolDefinition {
  name: string
  kind: SymbolKind
  relPath: string
  /** 1-based line number of the definition. */
  line: number
  /** 1-based column of the name token. */
  column: number
  /** Trimmed source line, for display in pickers. */
  text: string
}

export interface SymbolOccurrence {
  name: string
  relPath: string
  line: number
  column: number
  text: string
  /** True when this occurrence is a known definition site of the symbol. */
  isDefinition: boolean
  kind: SymbolKind | null
}

export type SymbolIndexStatus = 'idle' | 'indexing' | 'ready' | 'error'

interface IndexedFile {
  relPath: string
  language: SymbolLanguage
  content: string
  /** Character offset of every line start; index 0 is line 1. */
  lineStarts: number[]
}

interface SymbolIndexData {
  files: Map<string, IndexedFile>
  defs: Map<string, SymbolDefinition[]>
}

interface DefinitionRule {
  kind: SymbolKind
  /** Capture group 1 must be the symbol name; matched per source line. */
  regex: RegExp
  keywords?: ReadonlySet<string>
}

/** Compile a definition rule; the `d` flag exposes the name's exact column. */
function defRule(kind: SymbolKind, source: string, keywords?: ReadonlySet<string>): DefinitionRule {
  return { kind, regex: new RegExp(source, 'd'), keywords }
}

type SymbolLanguage = 'js' | 'rust' | 'python' | 'go' | 'brace'

const JS_NAME = '[A-Za-z_$][\\w$]*'
const WORD_NAME = '[A-Za-z_]\\w*'

/** Identifiers that look like definitions but are plain statements. */
const JS_METHOD_BLACKLIST = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else',
  'do', 'new', 'delete', 'typeof', 'await', 'yield', 'super', 'this',
  'export', 'import', 'with', 'try', 'void', 'instanceof', 'in', 'of',
])

const DEFINITION_RULES: Record<SymbolLanguage, DefinitionRule[]> = {
  js: [
    defRule('function', `\\bfunction\\s*\\*?\\s*(${JS_NAME})`),
    defRule('class', `\\bclass\\s+(${JS_NAME})`),
    defRule('interface', `\\binterface\\s+(${JS_NAME})`),
    defRule('type', `\\btype\\s+(${JS_NAME})\\s*[=<]`),
    defRule('enum', `\\benum\\s+(${JS_NAME})`),
    defRule('variable', `\\b(?:const|let|var)\\s+(${JS_NAME})\\s*[:=]`),
    // Indented `name(args) {` class/object-literal methods. Args must stay
    // quote/paren-free to reject call expressions like `describe('x', () => {`.
    defRule(
      'method',
      `^[ \\t]+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*` +
        `(${JS_NAME})\\s*(?:<[^<>=]*>)?\\s*\\(([^()'\`"]*)\\)\\s*(?::[^{;]+)?\\{`,
      JS_METHOD_BLACKLIST,
    ),
  ],
  rust: [
    defRule('function', `\\bfn\\s+(${WORD_NAME})`),
    defRule('struct', `\\bstruct\\s+(${WORD_NAME})`),
    defRule('enum', `\\benum\\s+(${WORD_NAME})`),
    defRule('trait', `\\btrait\\s+(${WORD_NAME})`),
    defRule('impl', `\\bimpl(?:<[^>]*>)?\\s+(${WORD_NAME})`),
    defRule('const', `\\b(?:pub\\s+)?(?:const|static)\\s+(?:mut\\s+)?(${WORD_NAME})`),
    defRule('module', `\\bmod\\s+(${WORD_NAME})`),
    defRule('type', `\\btype\\s+(${WORD_NAME})\\s*[=;]`),
    defRule('macro', `\\bmacro_rules!\\s+(${WORD_NAME})`),
  ],
  python: [
    defRule('function', `\\bdef\\s+(${WORD_NAME})`),
    defRule('class', `\\bclass\\s+(${WORD_NAME})`),
    // Module-level assignment `NAME = ...` (must start at column 0).
    defRule('variable', `^(${WORD_NAME})\\s*(?::[^=\\n]+)?=[^=]`),
  ],
  go: [
    defRule('function', `\\bfunc\\s+(?:\\([^)]*\\)\\s*)?(${WORD_NAME})`),
    defRule('struct', `\\btype\\s+(${WORD_NAME})\\s+struct\\b`),
    defRule('interface', `\\btype\\s+(${WORD_NAME})\\s+interface\\b`),
    defRule('const', `\\bconst\\s+(${WORD_NAME})`),
    defRule('variable', `\\bvar\\s+(${WORD_NAME})`),
  ],
  brace: [
    defRule('class', `\\bclass\\s+(${WORD_NAME})`),
    defRule('interface', `\\binterface\\s+(${WORD_NAME})`),
    defRule('struct', `\\bstruct\\s+(${WORD_NAME})`),
    defRule('enum', `\\benum\\s+(${WORD_NAME})`),
    defRule('trait', `\\btrait\\s+(${WORD_NAME})`),
    // C-family / Java-ish member functions: `RetType name(args) {`.
    defRule(
      'method',
      `^[ \\t]+(?:[\\w:<>,\\[\\]\\s&*]+\\s+)?(${WORD_NAME})\\s*\\([^;{]*\\)\\s*(?:const\\s*)?\\{`,
      new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'typeof', 'sizeof']),
    ),
    defRule('function', `\\bdef\\s+(${WORD_NAME})`),
  ],
}

const LANGUAGE_BY_EXT: Record<string, SymbolLanguage> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  vue: 'js', svelte: 'js',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'brace', kt: 'brace', kts: 'brace', cs: 'brace', swift: 'brace',
  scala: 'brace', php: 'brace', dart: 'brace',
  c: 'brace', h: 'brace', cpp: 'brace', hpp: 'brace', cc: 'brace', cxx: 'brace', rb: 'brace',
}

const HASH_COMMENT_LANGUAGES = new Set<SymbolLanguage>(['python'])

/** Hard caps so a pathological tree can never hang or bloat the index. */
export const SYMBOL_INDEX_MAX_FILES = 5000
export const SYMBOL_INDEX_MAX_FILE_BYTES = 1024 * 1024
export const SYMBOL_INDEX_MAX_TOTAL_BYTES = 16 * 1024 * 1024
/** Upper bound for one find-references scan result. */
export const SYMBOL_INDEX_MAX_OCCURRENCES = 2000

function extOf(relPath: string): string {
  const name = relPath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function languageOfRelPath(relPath: string): SymbolLanguage | null {
  return LANGUAGE_BY_EXT[extOf(relPath)] ?? null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function computeLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineNumberOf(file: IndexedFile, offset: number): number {
  // Binary search for the last line start <= offset.
  let lo = 0
  let hi = file.lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (file.lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function lineTextOf(file: IndexedFile, line: number): string {
  const from = file.lineStarts[line - 1] ?? 0
  const to = file.lineStarts[line] ?? file.content.length
  return file.content.slice(from, to).trim()
}

/**
 * Extract definition candidates from one file's content. Lines inside block
 * comments (`/* … *\/`) and full-line comments are skipped; matches inside
 * string literals are not (accepted heuristic trade-off).
 */
export function extractDefinitions(
  relPath: string,
  language: SymbolLanguage,
  content: string,
): SymbolDefinition[] {
  const rules = DEFINITION_RULES[language]
  if (!rules) return []

  const defs: SymbolDefinition[] = []
  const lines = content.split('\n')
  let inBlockComment = false

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const trimmed = raw.trimStart()

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (HASH_COMMENT_LANGUAGES.has(language) && trimmed.startsWith('#')) continue

    for (const rule of rules) {
      const match = raw.match(rule.regex)
      if (!match || !match[1]) continue
      const name = match[1]
      if (rule.keywords?.has(name)) continue
      // Prefer the `d`-flag group index (exact); fall back to a substring
      // search for environments without indices support.
      const groupStart = match.indices?.[1]?.[0]
      const column = (groupStart ?? (match.index ?? 0) + match[0].indexOf(name)) + 1
      defs.push({ name, kind: rule.kind, relPath, line: i + 1, column, text: trimmed })
    }
  }
  return defs
}

interface ScanMatch {
  line: number
  column: number
  groups: string[]
}

/** Run a global regex over an indexed file, reporting line/column per match. */
function scanFile(file: IndexedFile, regex: RegExp): ScanMatch[] {
  const out: ScanMatch[] = []
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(file.content))) {
    const offset = match.index ?? 0
    const line = lineNumberOf(file, offset)
    out.push({ line, column: offset + 1, groups: [...match] })
    if (match[0].length === 0) regex.lastIndex += 1
  }
  return out
}

function lastPathSegment(name: string): string {
  const idx = name.lastIndexOf('::')
  return idx === -1 ? name : name.slice(idx + 2)
}

/** `class Foo extends Bar` / `class Foo implements Bar, Baz` (JS family). */
const CLASS_EXTENDS_RE = new RegExp(`\\bclass\\s+(${JS_NAME})\\s+extends\\s+(${JS_NAME}(?:\\.${JS_NAME})*)`, 'g')
const CLASS_IMPLEMENTS_RE = new RegExp(`\\bclass\\s+(${JS_NAME})[^{]*?\\bimplements\\s+([^{]+?)\\{`, 'g')
/** `impl [generics] Trait for Type` (Rust). */
const IMPL_FOR_RE = new RegExp(`\\bimpl(?:<[^>]*>)?\\s+(${WORD_NAME}(?:::${WORD_NAME})*)\\s+for\\s+(${WORD_NAME}(?:::${WORD_NAME})*)`, 'g')

function findDefinitionInFile(
  data: SymbolIndexData,
  relPath: string,
  name: string,
  kinds: readonly SymbolKind[],
): SymbolDefinition | undefined {
  return data.defs.get(name)?.find((d) => d.relPath === relPath && kinds.includes(d.kind))
}

function syntheticDefinition(
  file: IndexedFile,
  match: ScanMatch,
  name: string,
  kind: SymbolKind,
  column: number,
): SymbolDefinition {
  return {
    name,
    kind,
    relPath: file.relPath,
    line: match.line,
    column,
    text: lineTextOf(file, match.line),
  }
}

/**
 * Resolve implementation candidates for a symbol by kind:
 * - interface → implementing classes (`implements X`);
 * - class → subclasses (`extends X`);
 * - trait (Rust) → types with `impl Trait for Type`;
 * - struct/enum (Rust) → their `impl … for Type` blocks.
 */
export function findImplementations(
  data: SymbolIndexData,
  name: string,
  kindHint: SymbolKind | null | undefined,
): SymbolDefinition[] {
  const defs = data.defs.get(name) ?? []
  const kind = kindHint ?? defs[0]?.kind
  const out: SymbolDefinition[] = []

  const pushUnique = (def: SymbolDefinition) => {
    if (!out.some((d) => d.relPath === def.relPath && d.line === def.line)) out.push(def)
  }

  for (const file of data.files.values()) {
    if (kind === 'interface' && (file.language === 'js' || file.language === 'brace')) {
      for (const match of scanFile(file, CLASS_IMPLEMENTS_RE)) {
        const implemented = match.groups[2]?.split(',') ?? []
        const hit = implemented.some((entry) => {
          const base = entry.trim().split('<')[0].trim().split('.').pop() ?? ''
          return base === name
        })
        if (!hit) continue
        const className = match.groups[1]
        pushUnique(
          findDefinitionInFile(data, file.relPath, className, ['class']) ??
            syntheticDefinition(file, match, className, 'class', match.column),
        )
      }
    }
    if (kind === 'class' && (file.language === 'js' || file.language === 'brace')) {
      for (const match of scanFile(file, CLASS_EXTENDS_RE)) {
        const base = (match.groups[2] ?? '').split('.').pop() ?? ''
        if (base !== name) continue
        const className = match.groups[1]
        pushUnique(
          findDefinitionInFile(data, file.relPath, className, ['class']) ??
            syntheticDefinition(file, match, className, 'class', match.column),
        )
      }
    }
    if ((kind === 'trait' || kind === 'struct' || kind === 'enum') && file.language === 'rust') {
      for (const match of scanFile(file, IMPL_FOR_RE)) {
        const trait = lastPathSegment(match.groups[1] ?? '')
        const type = lastPathSegment(match.groups[2] ?? '')
        if (kind === 'trait' && trait === name) {
          // The implementing type: prefer its struct/enum definition site.
          pushUnique(
            findDefinitionInFile(data, file.relPath, type, ['struct', 'enum']) ??
              syntheticDefinition(file, match, type, 'impl', match.column),
          )
        } else if ((kind === 'struct' || kind === 'enum') && type === name) {
          pushUnique(
            syntheticDefinition(file, match, trait, 'impl', match.column),
          )
        }
      }
    }
  }

  return out
}

export interface CreateSymbolIndexOptions {
  /**
   * Returns in-memory editor content for a path when available (dirty buffers
   * keep positions in sync with what the user sees). Null falls back to disk.
   * Note: newly typed symbols only become searchable after the index is
   * invalidated (fs delta) — i.e. after the file is saved.
   */
  getContentOverride?: (relPath: string) => string | null
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export interface SymbolIndexService {
  readonly status: () => SymbolIndexStatus
  readonly error: () => string | null
  /** Drop the cached index (e.g. on fs changes); rebuilt on the next query. */
  invalidate(): void
  definitions(name: string): Promise<SymbolDefinition[]>
  /** All case-sensitive word occurrences of `name`, definitions flagged. */
  occurrences(name: string): Promise<SymbolOccurrence[]>
  implementations(name: string, kindHint?: SymbolKind | null): Promise<SymbolDefinition[]>
}

export const SymbolIndexKey = createServiceKey<SymbolIndexService>('workbench.symbolIndex')

export function createSymbolIndexService(
  backend: WorkspaceBackend,
  projectId: string,
  options: CreateSymbolIndexOptions = {},
): SymbolIndexService {
  const maxFiles = options.maxFiles ?? SYMBOL_INDEX_MAX_FILES
  const maxFileBytes = options.maxFileBytes ?? SYMBOL_INDEX_MAX_FILE_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? SYMBOL_INDEX_MAX_TOTAL_BYTES

  const [status, setStatus] = createSignal<SymbolIndexStatus>('idle')
  const [error, setError] = createSignal<string | null>(null)

  let generation = 0
  let cached: SymbolIndexData | null = null
  let inflight: Promise<SymbolIndexData> | null = null

  async function readContent(relPath: string): Promise<string | null> {
    const override = options.getContentOverride?.(relPath)
    // Editor buffer content mirrors what the user sees (including unsaved
    // edits); cap it like a disk read so one huge buffer cannot dominate.
    if (override !== null && override !== undefined) return override.slice(0, maxFileBytes)
    try {
      const payload = await backend.readText(projectId, relPath, maxFileBytes)
      return payload.content
    } catch {
      return null
    }
  }

  async function buildIndex(): Promise<SymbolIndexData> {
    const { files: walked } = await buildFileIndex(backend, projectId)
    const candidates = walked
      .filter((f) => languageOfRelPath(f.relPath) !== null)
      .slice(0, maxFiles)

    const files = new Map<string, IndexedFile>()
    const defs = new Map<string, SymbolDefinition[]>()
    let totalBytes = 0

    for (let i = 0; i < candidates.length; i += WALK_CONCURRENCY) {
      const batch = candidates.slice(i, i + WALK_CONCURRENCY)
      const contents = await Promise.all(batch.map((f) => readContent(f.relPath)))

      for (let j = 0; j < batch.length; j += 1) {
        const relPath = batch[j].relPath
        const content = contents[j]
        if (content === null) continue
        if (totalBytes + content.length > maxTotalBytes) continue

        const language = languageOfRelPath(relPath)!
        const file: IndexedFile = {
          relPath,
          language,
          content,
          lineStarts: computeLineStarts(content),
        }
        files.set(relPath, file)
        totalBytes += content.length

        for (const def of extractDefinitions(relPath, language, content)) {
          const list = defs.get(def.name)
          if (list) list.push(def)
          else defs.set(def.name, [def])
        }
      }
    }

    return { files, defs }
  }

  async function ensureIndex(): Promise<SymbolIndexData> {
    if (cached) return cached

    // invalidate() bumps the generation; a finished build from a stale
    // generation is discarded and rebuilt. After three stale rounds (heavy
    // concurrent fs churn) one final uncached build is served as-is.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observedGeneration = generation
      if (!inflight) {
        setStatus('indexing')
        setError(null)
        inflight = buildIndex().finally(() => {
          inflight = null
        })
      }
      let data: SymbolIndexData
      try {
        data = await inflight
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (observedGeneration === generation) {
          setStatus('error')
          setError(message)
        }
        throw err
      }
      if (observedGeneration === generation) {
        cached = data
        setStatus('ready')
        setError(null)
        return data
      }
    }
    // Heavy concurrent churn: serve the newest data without caching it.
    const data = await buildIndex()
    setStatus('ready')
    setError(null)
    return data
  }

  function definitionListOf(data: SymbolIndexData, name: string): SymbolDefinition[] {
    return data.defs.get(name) ?? []
  }

  return {
    status,
    error,

    invalidate() {
      generation += 1
      cached = null
      inflight = null
      setStatus('idle')
      setError(null)
    },

    async definitions(name) {
      const data = await ensureIndex()
      return definitionListOf(data, name)
    },

    async occurrences(name) {
      const data = await ensureIndex()
      const results: SymbolOccurrence[] = []
      const regex = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g')

      for (const file of data.files.values()) {
        regex.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = regex.exec(file.content))) {
          const offset = match.index ?? 0
          const line = lineNumberOf(file, offset)
          const column = offset - file.lineStarts[line - 1] + 1
          const def = definitionListOf(data, name).find(
            (d) => d.relPath === file.relPath && d.line === line && d.column === column,
          )
          results.push({
            name,
            relPath: file.relPath,
            line,
            column,
            text: lineTextOf(file, line),
            isDefinition: Boolean(def),
            kind: def?.kind ?? null,
          })
          if (results.length >= SYMBOL_INDEX_MAX_OCCURRENCES) return results
        }
      }
      return results
    },

    async implementations(name, kindHint) {
      const data = await ensureIndex()
      return findImplementations(data, name, kindHint)
    },
  }
}
