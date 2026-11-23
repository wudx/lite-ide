import { createServiceKey } from '@lite-ide/kernel'
import type { FsDelta, WorkspaceBackend } from '@lite-ide/protocol'
import {
  baseNameOf,
  buildFileIndex,
  parentDirOf,
  WALK_CONCURRENCY,
  type CodeNavigationService,
  type ConfirmDialogService,
  type EditorBufferService,
  type ProjectSelectionService,
  type TranslateFn,
} from '@lite-ide/workbench'
import { batch, createSignal, type Accessor } from 'solid-js'
import {
  compileSearchPattern,
  countLines,
  isLikelyBinaryPath,
  parseFilterPatterns,
  replaceAllInContent,
  replaceSingleMatchInContent,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES,
  searchFileContent,
  shouldIncludeRelPath,
  type CompiledSearchPattern,
  type FileSearchResult,
  type SearchMatch,
} from './search-engine'

const MAX_CONTENT_CACHE_CHARS = 15 * 1024 * 1024
const SEARCH_DEBOUNCE_MS = 180

interface CachedFileText {
  content: string
  encoding: string
}

export interface SearchFocusRequest {
  seq: number
  target: 'search' | 'replace'
}

export interface SearchStoreDeps {
  backend: WorkspaceBackend
  selection?: ProjectSelectionService
  buffers?: EditorBufferService
  navigation?: CodeNavigationService
  dialogs?: ConfirmDialogService
  t: TranslateFn
}

export interface SearchStore {
  readonly query: Accessor<string>
  readonly replaceText: Accessor<string>
  readonly replaceExpanded: Accessor<boolean>
  readonly filtersExpanded: Accessor<boolean>
  readonly caseSensitive: Accessor<boolean>
  readonly wholeWord: Accessor<boolean>
  readonly useRegex: Accessor<boolean>
  readonly useIgnoreFiles: Accessor<boolean>
  readonly filesToInclude: Accessor<string>
  readonly filesToExclude: Accessor<string>
  readonly results: Accessor<readonly FileSearchResult[]>
  readonly totalMatches: Accessor<number>
  readonly totalFiles: Accessor<number>
  readonly truncated: Accessor<boolean>
  readonly searching: Accessor<boolean>
  readonly replacing: Accessor<boolean>
  readonly error: Accessor<string | null>
  readonly hasSearched: Accessor<boolean>
  readonly collapsedFiles: Accessor<ReadonlySet<string>>
  readonly scrollOffset: Accessor<number>
  readonly focusRequest: Accessor<SearchFocusRequest | null>
  readonly compiledPattern: Accessor<CompiledSearchPattern | null>

  setQuery(value: string): void
  setReplaceText(value: string): void
  setReplaceExpanded(expanded: boolean): void
  toggleReplaceExpanded(): void
  setFiltersExpanded(expanded: boolean): void
  toggleFiltersExpanded(): void
  toggleCaseSensitive(): void
  toggleWholeWord(): void
  toggleUseRegex(): void
  toggleUseIgnoreFiles(): void
  setFilesToInclude(value: string): void
  setFilesToExclude(value: string): void
  setScrollOffset(offset: number): void
  requestFocus(target: 'search' | 'replace'): void
  toggleFileCollapsed(relPath: string): void
  collapseAll(): void
  expandAll(): void
  clearSearch(): void
  runSearchNow(): Promise<void>
  openMatch(match: SearchMatch): Promise<void>
  replaceMatch(match: SearchMatch): Promise<void>
  replaceInFile(relPath: string): Promise<void>
  replaceAll(): Promise<void>
  handleFsDelta(delta: FsDelta): void
  dispose(): void
}

export const SearchStoreKey = createServiceKey<SearchStore>('plugin.search.store')

export function createSearchStore(projectId: string, deps: SearchStoreDeps): SearchStore {
  const [query, setQuerySignal] = createSignal('')
  const [replaceText, setReplaceTextSignal] = createSignal('')
  const [replaceExpanded, setReplaceExpandedSignal] = createSignal(false)
  const [filtersExpanded, setFiltersExpandedSignal] = createSignal(false)
  const [caseSensitive, setCaseSensitiveSignal] = createSignal(false)
  const [wholeWord, setWholeWordSignal] = createSignal(false)
  const [useRegex, setUseRegexSignal] = createSignal(false)
  const [useIgnoreFiles, setUseIgnoreFilesSignal] = createSignal(true)
  const [filesToInclude, setFilesToIncludeSignal] = createSignal('')
  const [filesToExclude, setFilesToExcludeSignal] = createSignal('')

  const [results, setResults] = createSignal<readonly FileSearchResult[]>([])
  const [totalMatches, setTotalMatches] = createSignal(0)
  const [totalFiles, setTotalFiles] = createSignal(0)
  const [truncated, setTruncated] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  const [replacing, setReplacing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [hasSearched, setHasSearched] = createSignal(false)
  const [collapsedFiles, setCollapsedFiles] = createSignal<ReadonlySet<string>>(new Set())
  const [scrollOffset, setScrollOffsetSignal] = createSignal(0)
  const [focusRequest, setFocusRequest] = createSignal<SearchFocusRequest | null>(null)
  const [compiledPattern, setCompiledPattern] = createSignal<CompiledSearchPattern | null>(null)

  let searchSeq = 0
  let focusSeq = 0
  let disposed = false
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let cachedFileList: { useIgnore: boolean; files: string[] } | null = null
  const contentCache = new Map<string, CachedFileText>()
  let contentCacheChars = 0

  function setCachedContent(relPath: string, entry: CachedFileText) {
    const existing = contentCache.get(relPath)
    if (existing) {
      contentCacheChars -= existing.content.length
      contentCache.delete(relPath)
    }
    if (entry.content.length > SEARCH_MAX_FILE_BYTES) return
    while (contentCacheChars + entry.content.length > MAX_CONTENT_CACHE_CHARS && contentCache.size > 0) {
      const oldestKey = contentCache.keys().next().value
      if (oldestKey === undefined) break
      const oldest = contentCache.get(oldestKey)
      if (oldest) contentCacheChars -= oldest.content.length
      contentCache.delete(oldestKey)
    }
    contentCache.set(relPath, entry)
    contentCacheChars += entry.content.length
  }

  function clearDebounce() {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }

  function scheduleSearch() {
    clearDebounce()
    if (!query()) {
      resetResultsState()
      return
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void runSearchNow()
    }, SEARCH_DEBOUNCE_MS)
  }

  function resetResultsState() {
    searchSeq += 1
    batch(() => {
      setResults([])
      setTotalMatches(0)
      setTotalFiles(0)
      setTruncated(false)
      setSearching(false)
      setError(null)
      setHasSearched(false)
      setCompiledPattern(null)
    })
  }

  async function readFileForSearch(relPath: string): Promise<CachedFileText | null> {
    const openBuf = deps.buffers?.getBuffer(relPath)
    if (openBuf) {
      return { content: openBuf.content, encoding: openBuf.encoding }
    }
    const cached = contentCache.get(relPath)
    if (cached) return cached
    try {
      const payload = await deps.backend.readText(projectId, relPath, SEARCH_MAX_FILE_BYTES)
      if (payload.truncated) return null
      const entry = { content: payload.content, encoding: payload.encoding }
      setCachedContent(relPath, entry)
      return entry
    } catch {
      return null
    }
  }

  /**
   * Read the authoritative text before mutating: open buffer when mounted, or
   * direct disk read (bypassing `contentCache` so external edits aren't lost).
   */
  async function readFileForMutation(relPath: string): Promise<CachedFileText | null> {
    const openBuf = deps.buffers?.getBuffer(relPath)
    if (openBuf) {
      if (openBuf.readOnly) return null
      return { content: openBuf.content, encoding: openBuf.encoding }
    }
    const payload = await deps.backend.readText(projectId, relPath, SEARCH_MAX_FILE_BYTES)
    if (payload.truncated) return null
    return { content: payload.content, encoding: payload.encoding }
  }

  async function getWorkspaceFiles(ignoreFlag: boolean): Promise<string[]> {
    if (cachedFileList && cachedFileList.useIgnore === ignoreFlag) {
      return cachedFileList.files
    }
    const { files: entries, failedDirCount } = await buildFileIndex(deps.backend, projectId, {
      includeIgnored: !ignoreFlag,
      maxFiles: SEARCH_MAX_FILES,
    })
    const files = entries
      .filter((e) => !isLikelyBinaryPath(e.relPath) && (e.size ?? 0) <= SEARCH_MAX_FILE_BYTES)
      .map((e) => e.relPath)
      .sort((a, b) => a.localeCompare(b))
    // Leave incomplete trees uncached so transient directory errors retry next time.
    if (failedDirCount === 0) {
      cachedFileList = { useIgnore: ignoreFlag, files }
    }
    return files
  }

  async function runSearchNow(): Promise<void> {
    clearDebounce()
    const compiled = compileSearchPattern({
      query: query(),
      caseSensitive: caseSensitive(),
      wholeWord: wholeWord(),
      useRegex: useRegex(),
    })

    if (!compiled) {
      resetResultsState()
      return
    }

    if (!compiled.ok) {
      searchSeq += 1
      batch(() => {
        setCompiledPattern(null)
        setError(deps.t('search.invalidRegex', { message: compiled.error }))
        setSearching(false)
        setResults([])
        setTotalMatches(0)
        setTotalFiles(0)
        setTruncated(false)
        setHasSearched(true)
      })
      return
    }

    const seq = ++searchSeq
    const pattern = compiled.pattern
    const includeRules = parseFilterPatterns(filesToInclude())
    const excludeRules = parseFilterPatterns(filesToExclude())
    const ignoreFlag = useIgnoreFiles()

    batch(() => {
      setCompiledPattern(pattern)
      setError(null)
      setSearching(true)
    })

    try {
      const allFiles = await getWorkspaceFiles(ignoreFlag)
      if (disposed || seq !== searchSeq) return

      const candidateFiles = allFiles.filter((relPath) =>
        shouldIncludeRelPath(relPath, includeRules, excludeRules),
      )

      const matchedFiles: FileSearchResult[] = []
      let matchTotal = 0
      let wasTruncated = false

      for (let i = 0; i < candidateFiles.length; i += WALK_CONCURRENCY) {
        if (disposed || seq !== searchSeq) return
        const chunk = candidateFiles.slice(i, i + WALK_CONCURRENCY)
        const loaded = await Promise.all(chunk.map((relPath) => readFileForSearch(relPath)))
        if (disposed || seq !== searchSeq) return

        for (let j = 0; j < chunk.length; j += 1) {
          const relPath = chunk[j]!
          const fileData = loaded[j]
          if (!fileData) continue

          const budget = SEARCH_MAX_MATCHES - matchTotal
          if (budget <= 0) {
            wasTruncated = true
            break
          }

          const matches = searchFileContent(relPath, fileData.content, pattern, budget)
          if (matches.length > 0) {
            matchedFiles.push({
              relPath,
              name: baseNameOf(relPath),
              dir: parentDirOf(relPath),
              matches,
            })
            matchTotal += matches.length
            if (matchTotal >= SEARCH_MAX_MATCHES) {
              wasTruncated = true
              break
            }
          }
        }
        if (wasTruncated) break
      }

      if (disposed || seq !== searchSeq) return
      batch(() => {
        setResults(matchedFiles)
        setTotalMatches(matchTotal)
        setTotalFiles(matchedFiles.length)
        setTruncated(wasTruncated)
        setSearching(false)
        setHasSearched(true)
        setCollapsedFiles(new Set<string>())
      })
    } catch (err) {
      if (disposed || seq !== searchSeq) return
      batch(() => {
        setSearching(false)
        setError(err instanceof Error ? err.message : String(err))
        setHasSearched(true)
      })
    }
  }

  async function writeUpdatedFile(
    relPath: string,
    nextContent: string,
    encoding: string,
  ): Promise<boolean> {
    const openBuf = deps.buffers?.getBuffer(relPath)
    if (openBuf) {
      if (openBuf.readOnly) return false
      const ok = await deps.buffers!.applyContent(
        relPath,
        nextContent,
        countLines(nextContent),
        { save: !openBuf.dirty },
      )
      if (ok) {
        setCachedContent(relPath, { content: nextContent, encoding: openBuf.encoding })
      }
      return ok
    }

    const res = await deps.backend.writeText(projectId, relPath, nextContent, encoding || undefined)
    setCachedContent(relPath, { content: nextContent, encoding: res.meta.encoding || encoding })
    return true
  }

  function updateSingleFileMatches(relPath: string, nextContent: string, pattern: CompiledSearchPattern) {
    const nextMatches = searchFileContent(relPath, nextContent, pattern, SEARCH_MAX_MATCHES)
    const prevList = results()
    const nextList: FileSearchResult[] = []
    let nextMatchCount = 0

    for (const file of prevList) {
      if (file.relPath === relPath) {
        if (nextMatches.length > 0) {
          nextList.push({
            relPath: file.relPath,
            name: file.name,
            dir: file.dir,
            matches: nextMatches,
          })
          nextMatchCount += nextMatches.length
        }
      } else {
        nextList.push(file)
        nextMatchCount += file.matches.length
      }
    }

    batch(() => {
      setResults(nextList)
      setTotalFiles(nextList.length)
      setTotalMatches(nextMatchCount)
    })
  }

  async function replaceMatch(match: SearchMatch): Promise<void> {
    const pattern = compiledPattern()
    if (!pattern || replacing() || disposed) return

    const opSeq = ++searchSeq
    setError(null)
    setReplacing(true)
    try {
      const fileData = await readFileForMutation(match.relPath)
      if (disposed || opSeq !== searchSeq) return
      if (!fileData) {
        setError(deps.t('search.replaceFailed', { path: match.relPath }))
        return
      }
      const nextContent = replaceSingleMatchInContent(
        fileData.content,
        match,
        pattern,
        replaceText(),
      )
      if (nextContent === null) {
        await runSearchNow()
        return
      }
      const ok = await writeUpdatedFile(match.relPath, nextContent, fileData.encoding)
      if (disposed || opSeq !== searchSeq) return
      if (!ok) {
        setError(deps.t('search.replaceFailed', { path: match.relPath }))
        return
      }
      updateSingleFileMatches(match.relPath, nextContent, pattern)
    } catch (err) {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setReplacing(false)
    }
  }

  async function replaceInFile(relPath: string): Promise<void> {
    const pattern = compiledPattern()
    if (!pattern || replacing() || disposed) return

    const opSeq = ++searchSeq
    setError(null)
    setReplacing(true)
    try {
      const fileData = await readFileForMutation(relPath)
      if (disposed || opSeq !== searchSeq) return
      if (!fileData) {
        setError(deps.t('search.replaceFailed', { path: relPath }))
        return
      }
      const { nextContent, count } = replaceAllInContent(fileData.content, pattern, replaceText())
      if (count === 0) {
        updateSingleFileMatches(relPath, fileData.content, pattern)
        return
      }
      const ok = await writeUpdatedFile(relPath, nextContent, fileData.encoding)
      if (disposed || opSeq !== searchSeq) return
      if (!ok) {
        setError(deps.t('search.replaceFailed', { path: relPath }))
        return
      }
      updateSingleFileMatches(relPath, nextContent, pattern)
    } catch (err) {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setReplacing(false)
    }
  }

  async function replaceAll(): Promise<void> {
    const pattern = compiledPattern()
    const currentResults = results()
    if (!pattern || currentResults.length === 0 || replacing() || disposed) return

    const snapshotSeq = searchSeq
    const fileCount = totalFiles()
    const matchCount = totalMatches()
    const replacement = replaceText()

    if (deps.dialogs) {
      const action = await deps.dialogs.confirm({
        title: deps.t('search.confirmReplaceAllTitle'),
        message: deps.t('search.confirmReplaceAllMessage', {
          files: fileCount,
          matches: matchCount,
          replacement,
        }),
        actions: [
          {
            id: 'replace',
            label: deps.t('search.confirmReplaceAllAction'),
            variant: 'primary',
          },
          {
            id: 'cancel',
            label: deps.t('common.cancel'),
            variant: 'secondary',
          },
        ],
        cancelId: 'cancel',
      })
      if (action !== 'replace' || disposed || snapshotSeq !== searchSeq) return
    }

    const opSeq = ++searchSeq
    setError(null)
    setReplacing(true)
    try {
      for (const file of currentResults) {
        if (disposed || opSeq !== searchSeq) return
        const fileData = await readFileForMutation(file.relPath)
        if (disposed || opSeq !== searchSeq) return
        if (!fileData) {
          setError(deps.t('search.replaceFailed', { path: file.relPath }))
          return
        }
        const { nextContent, count } = replaceAllInContent(fileData.content, pattern, replacement)
        if (count === 0) continue
        const ok = await writeUpdatedFile(file.relPath, nextContent, fileData.encoding)
        if (disposed || opSeq !== searchSeq) return
        if (!ok) {
          setError(deps.t('search.replaceFailed', { path: file.relPath }))
          return
        }
      }
      await runSearchNow()
    } catch (err) {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setReplacing(false)
    }
  }

  return {
    query,
    replaceText,
    replaceExpanded,
    filtersExpanded,
    caseSensitive,
    wholeWord,
    useRegex,
    useIgnoreFiles,
    filesToInclude,
    filesToExclude,
    results,
    totalMatches,
    totalFiles,
    truncated,
    searching,
    replacing,
    error,
    hasSearched,
    collapsedFiles,
    scrollOffset,
    focusRequest,
    compiledPattern,

    setQuery(value: string) {
      setQuerySignal(value)
      scheduleSearch()
    },

    setReplaceText(value: string) {
      setReplaceTextSignal(value)
    },

    setReplaceExpanded(expanded: boolean) {
      setReplaceExpandedSignal(expanded)
    },

    toggleReplaceExpanded() {
      setReplaceExpandedSignal((v) => !v)
    },

    setFiltersExpanded(expanded: boolean) {
      setFiltersExpandedSignal(expanded)
    },

    toggleFiltersExpanded() {
      setFiltersExpandedSignal((v) => !v)
    },

    toggleCaseSensitive() {
      setCaseSensitiveSignal((v) => !v)
      if (query()) void runSearchNow()
    },

    toggleWholeWord() {
      setWholeWordSignal((v) => !v)
      if (query()) void runSearchNow()
    },

    toggleUseRegex() {
      setUseRegexSignal((v) => !v)
      if (query()) void runSearchNow()
    },

    toggleUseIgnoreFiles() {
      setUseIgnoreFilesSignal((v) => !v)
      cachedFileList = null
      if (query()) void runSearchNow()
    },

    setFilesToInclude(value: string) {
      setFilesToIncludeSignal(value)
      if (query()) scheduleSearch()
    },

    setFilesToExclude(value: string) {
      setFilesToExcludeSignal(value)
      if (query()) scheduleSearch()
    },

    setScrollOffset(offset: number) {
      setScrollOffsetSignal(offset)
    },

    requestFocus(target: 'search' | 'replace') {
      setFocusRequest({ seq: ++focusSeq, target })
    },

    toggleFileCollapsed(relPath: string) {
      setCollapsedFiles((prev) => {
        const next = new Set(prev)
        if (next.has(relPath)) next.delete(relPath)
        else next.add(relPath)
        return next
      })
    },

    collapseAll() {
      setCollapsedFiles(new Set(results().map((f) => f.relPath)))
    },

    expandAll() {
      setCollapsedFiles(new Set<string>())
    },

    clearSearch() {
      clearDebounce()
      setQuerySignal('')
      resetResultsState()
    },

    runSearchNow,

    async openMatch(match: SearchMatch) {
      if (deps.navigation) {
        await deps.navigation.revealLocation(match.relPath, match.line, match.column)
        return
      }
      await deps.selection?.selectFile(match.relPath)
    },

    replaceMatch,
    replaceInFile,
    replaceAll,

    handleFsDelta(delta: FsDelta) {
      if (delta.overflow) {
        cachedFileList = null
        contentCache.clear()
        contentCacheChars = 0
        return
      }
      if (delta.affectedDirs.length > 0 || delta.affectedPaths.length > 0) {
        cachedFileList = null
      }
      for (const path of delta.affectedPaths) {
        const existing = contentCache.get(path)
        if (existing) {
          contentCacheChars -= existing.content.length
          contentCache.delete(path)
        }
      }
    },

    dispose() {
      disposed = true
      clearDebounce()
      searchSeq += 1
      cachedFileList = null
      contentCache.clear()
      contentCacheChars = 0
    },
  }
}
