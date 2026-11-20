import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import {
  highlightSelectionMatches,
  openSearchPanel as openCM,
  search,
  searchKeymap,
} from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view'
import type { PreviewProps } from '@lite-ide/kernel'
import {
  DEFAULT_BUFFER_MAX_BYTES,
  EditorBufferKey,
  formatBytes,
  ProjectSelectionKey,
  type DocumentBuffer,
} from '@lite-ide/workbench'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Lock from 'lucide-solid/icons/lock'
import Search from 'lucide-solid/icons/search'
import AlertTriangle from 'lucide-solid/icons/triangle-exclamation-point'
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from 'solid-js'
import { CodeEditorCacheKey } from './editor-cache'
import { CodeStatsKey } from './stats'

const EXTENDED_MAX_BYTES = 10 * 1024 * 1024

// Module-level Compartment singletons remain valid across EditorState cache restores.
const languageCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const listenerCompartment = new Compartment()

const ideTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--bg-editor)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily:
      'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-editor)',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-primary)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border-subtle)',
  },
})

function computeCursorPosition(state: EditorState): { line: number; column: number } {
  const head = state.selection.main.head
  const lineInfo = state.doc.lineAt(head)
  return {
    line: lineInfo.number,
    column: head - lineInfo.from + 1,
  }
}

function buildEditorExtensions(readOnly: boolean, listenerExt: Extension): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    ideTheme,
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([indentWithTab, ...searchKeymap, ...historyKeymap, ...defaultKeymap, ...foldKeymap]),
    readOnlyCompartment.of([
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
    ]),
    listenerCompartment.of(listenerExt),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    languageCompartment.of([]),
  ]
}

export default function CodePreview(props: PreviewProps) {
  const buffers = props.scope.get(EditorBufferKey)
  const selection = props.scope.tryGet(ProjectSelectionKey)
  const codeStats = props.scope.tryGet(CodeStatsKey)
  const editorCache = props.scope.tryGet(CodeEditorCacheKey)

  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [maxBytes, setMaxBytes] = createSignal(DEFAULT_BUFFER_MAX_BYTES)
  const [langLabel, setLangLabel] = createSignal('Plain Text')

  const activeBuffer = createMemo(() => buffers.getBuffer(props.file.relPath))
  const activeDiskRevision = createMemo(() => activeBuffer()?.diskRevision ?? -1)

  let containerEl: HTMLDivElement | undefined
  let view: EditorView | undefined
  let mountedRelPath: string | null = null
  let mountedDiskRevision = -1
  let mountedMaxBytes = DEFAULT_BUFFER_MAX_BYTES
  let isApplyingExternal = false
  let readSeq = 0
  let langSeq = 0

  function saveMountedToCache() {
    if (!view || !mountedRelPath || !editorCache) return
    if (!buffers.hasBuffer(mountedRelPath)) return
    editorCache.set(mountedRelPath, {
      state: view.state,
      scrollTop: view.scrollDOM.scrollTop,
      scrollLeft: view.scrollDOM.scrollLeft,
      diskRevision: mountedDiskRevision,
    })
  }

  function updateStatsFromView(relPath: string, language: string) {
    if (!codeStats || !view) return
    const buf = untrack(() => buffers.getBuffer(relPath))
    const pos = computeCursorPosition(view.state)
    codeStats.setStats({
      language,
      lineCount: view.state.doc.lines,
      line: pos.line,
      column: pos.column,
      dirty: buf?.dirty ?? false,
      readOnly: buf?.readOnly ?? false,
      encoding: buf?.encoding ?? 'utf-8',
      size: buf?.totalBytes ?? 0,
    })
  }

  function createUpdateListener(relPath: string, language: string): Extension {
    return EditorView.updateListener.of((update: ViewUpdate) => {
      if (isApplyingExternal || mountedRelPath !== relPath) return
      if (update.docChanged) {
        buffers.updateContent(relPath, update.state.doc.toString(), update.state.doc.lines)
      }
      if (update.docChanged || update.selectionSet) {
        updateStatsFromView(relPath, language)
      }
    })
  }

  function applyLanguageSupport(relPath: string, fileName: string, fileExt: string) {
    const matchedLang = LanguageDescription.matchFilename(languages, fileName)
    const label = matchedLang?.name ?? (fileExt ? fileExt.toUpperCase() : 'Plain Text')
    setLangLabel(label)

    const currentLangSeq = ++langSeq
    if (!matchedLang) {
      if (view && mountedRelPath === relPath) {
        view.dispatch({
          effects: languageCompartment.reconfigure([]),
        })
      }
      return label
    }

    void matchedLang
      .load()
      .then((support) => {
        if (currentLangSeq !== langSeq || !view || mountedRelPath !== relPath) return
        view.dispatch({
          effects: languageCompartment.reconfigure(support),
        })
      })
      .catch(() => {
        // Keep plain text highlight if a grammar fails to load.
      })

    return label
  }

  function applyBufferToView(buf: DocumentBuffer, fileName: string, fileExt: string) {
    if (!view) return

    if (mountedRelPath && mountedRelPath !== buf.relPath) {
      saveMountedToCache()
    }

    const matchedLang = LanguageDescription.matchFilename(languages, fileName)
    const label = matchedLang?.name ?? (fileExt ? fileExt.toUpperCase() : 'Plain Text')
    setLangLabel(label)

    const listenerExt = createUpdateListener(buf.relPath, label)
    const cached = editorCache?.get(buf.relPath)
    const canRestoreCached =
      Boolean(cached) &&
      cached!.diskRevision === buf.diskRevision &&
      cached!.state.doc.toString() === buf.content

    mountedRelPath = buf.relPath
    mountedDiskRevision = buf.diskRevision
    mountedMaxBytes = buf.maxBytes

    isApplyingExternal = true
    try {
      if (canRestoreCached && cached) {
        view.setState(cached.state)
        view.dispatch({
          effects: [
            readOnlyCompartment.reconfigure([
              EditorState.readOnly.of(buf.readOnly),
              EditorView.editable.of(!buf.readOnly),
            ]),
            listenerCompartment.reconfigure(listenerExt),
          ],
        })
        const targetScrollTop = cached.scrollTop
        const targetScrollLeft = cached.scrollLeft
        requestAnimationFrame(() => {
          if (view && mountedRelPath === buf.relPath) {
            view.scrollDOM.scrollTop = targetScrollTop
            view.scrollDOM.scrollLeft = targetScrollLeft
          }
        })
      } else {
        const nextState = EditorState.create({
          doc: buf.content,
          extensions: buildEditorExtensions(buf.readOnly, listenerExt),
        })
        view.setState(nextState)
        applyLanguageSupport(buf.relPath, fileName, fileExt)
      }
    } finally {
      isApplyingExternal = false
    }

    updateStatsFromView(buf.relPath, label)
  }

  onMount(() => {
    if (!containerEl) return
    view = new EditorView({
      parent: containerEl,
      state: EditorState.create({
        doc: '',
        extensions: buildEditorExtensions(true, []),
      }),
    })
  })

  onCleanup(() => {
    saveMountedToCache()
    codeStats?.setStats(null)
    view?.destroy()
    view = undefined
    mountedRelPath = null
  })

  // Restore or reset byte cap when switching files.
  createEffect(
    on(
      () => props.file.relPath,
      (relPath) => {
        const existing = untrack(() => buffers.getBuffer(relPath))
        setMaxBytes(existing ? existing.maxBytes : DEFAULT_BUFFER_MAX_BYTES)
      },
    ),
  )

  createEffect(() => {
    const relPath = props.file.relPath
    const limit = maxBytes()
    const diskRev = activeDiskRevision()
    const selected = selection ? selection.selectedPath() : relPath
    const staticFile = untrack(() => ({
      name: props.file.name,
      ext: props.file.ext,
      modifiedMs: props.file.modifiedMs,
    }))

    if (selected !== relPath) {
      readSeq += 1
      return
    }

    if (
      mountedRelPath === relPath &&
      mountedDiskRevision === diskRev &&
      diskRev >= 0 &&
      limit <= mountedMaxBytes
    ) {
      readSeq += 1
      return
    }

    const existing = untrack(() => activeBuffer())
    if (existing && existing.diskRevision === diskRev && limit <= existing.maxBytes) {
      readSeq += 1
      setLoading(false)
      setError(null)
      applyBufferToView(existing, staticFile.name, staticFile.ext)
      return
    }

    const seq = ++readSeq
    setLoading(true)
    setError(null)

    void buffers
      .ensureLoaded(relPath, limit, staticFile.modifiedMs)
      .then((buf) => {
        if (seq !== readSeq || untrack(() => props.file.relPath) !== relPath) return
        setLoading(false)
        applyBufferToView(buf, staticFile.name, staticFile.ext)
      })
      .catch((err) => {
        if (seq !== readSeq || untrack(() => props.file.relPath) !== relPath) return
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  })

  // Keep CodeMirror editable flag & status bar metadata synced with buffer flags.
  createEffect(() => {
    const buf = activeBuffer()
    if (!buf || mountedRelPath !== buf.relPath || !view) return
    const ro = buf.readOnly
    const dirty = buf.dirty
    const encoding = buf.encoding
    const size = buf.totalBytes

    isApplyingExternal = true
    try {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure([
          EditorState.readOnly.of(ro),
          EditorView.editable.of(!ro),
        ]),
      })
    } finally {
      isApplyingExternal = false
    }

    if (codeStats) {
      const pos = computeCursorPosition(view.state)
      codeStats.setStats({
        language: untrack(() => langLabel()),
        lineCount: view.state.doc.lines,
        line: pos.line,
        column: pos.column,
        dirty,
        readOnly: ro,
        encoding,
        size,
      })
    }
  })

  function openSearchPanel() {
    if (!view) return
    view.focus()
    openCM(view)
  }

  function handleLoadExtended() {
    const buf = activeBuffer()
    if (!buf) return
    setMaxBytes(EXTENDED_MAX_BYTES)
    void buffers.reloadBuffer(buf.relPath, EXTENDED_MAX_BYTES)
  }

  return (
    <div class="flex-1 min-h-0 flex flex-col relative">
      {/* Save failure banner */}
      <Show when={activeBuffer()?.saveError}>
        {(errMsg) => (
          <div class="px-3 py-1.5 bg-red-500/12 border-b border-red-500/30 flex items-center justify-between gap-3 text-xs text-red-200">
            <div class="flex items-center gap-2 min-w-0">
              <AlertTriangle class="w-3.5 h-3.5 shrink-0 text-red-400" />
              <span class="truncate">Save failed: {errMsg()}</span>
            </div>
            <button
              type="button"
              class="px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-100 font-medium transition-colors shrink-0"
              onClick={() => {
                const buf = activeBuffer()
                if (!buf) return
                void (buf.conflict !== 'none'
                  ? buffers.overwriteConflict(buf.relPath)
                  : buffers.saveBuffer(buf.relPath))
              }}
            >
              Retry
            </button>
          </div>
        )}
      </Show>

      {/* External disk change / deletion conflict banner */}
      <Show when={activeBuffer() && activeBuffer()!.conflict !== 'none'}>
        <Show when={activeBuffer()}>
          {(buf) => (
            <div class="px-3 py-1.5 bg-amber-500/12 border-b border-amber-500/30 flex items-center justify-between gap-3 text-xs text-amber-100">
              <div class="flex items-center gap-2 min-w-0">
                <AlertTriangle class="w-3.5 h-3.5 shrink-0 text-amber-400" />
                <span class="truncate">
                  {buf().conflict === 'deleted'
                    ? 'This file was deleted on disk. Your unsaved edits remain in memory.'
                    : 'This file was modified on disk outside LiteIDE. Your unsaved edits are preserved.'}
                </span>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <Show when={buf().conflict === 'modified'}>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium transition-colors"
                    onClick={() => void buffers.reloadBuffer(buf().relPath)}
                  >
                    Reload from Disk
                  </button>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-medium transition-colors"
                    onClick={() => void buffers.overwriteConflict(buf().relPath)}
                  >
                    Overwrite Disk
                  </button>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded hover:bg-amber-500/20 text-amber-200/80 transition-colors"
                    onClick={() => buffers.dismissConflict(buf().relPath)}
                  >
                    Dismiss
                  </button>
                </Show>

                <Show when={buf().conflict === 'deleted'}>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium transition-colors"
                    onClick={() => void buffers.overwriteConflict(buf().relPath)}
                  >
                    Recreate & Save
                  </button>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[var(--text-primary)] transition-colors"
                    onClick={() => {
                      const path = buf().relPath
                      buffers.discardBuffer(path)
                      void selection?.closeTab(path)
                    }}
                  >
                    Close Tab
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </Show>

      {/* Truncation / Read-only protection banner */}
      <Show when={activeBuffer()?.readOnly}>
        <Show when={activeBuffer()}>
          {(buf) => (
            <div class="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/25 flex items-center justify-between gap-3 text-xs text-amber-200">
              <div class="flex items-center gap-2 min-w-0">
                <Lock class="w-3.5 h-3.5 shrink-0 text-amber-400" />
                <span class="truncate">
                  {buf().truncated
                    ? `Showing first ${formatBytes(buf().loadedBytes)} of ${formatBytes(buf().totalBytes)} (Read-Only).`
                    : (buf().readOnlyReason ?? 'Read-only file.')}
                </span>
              </div>
              <Show when={buf().truncated && buf().maxBytes < EXTENDED_MAX_BYTES}>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium transition-colors shrink-0"
                  onClick={handleLoadExtended}
                >
                  Load up to 10 MB
                </button>
              </Show>
            </div>
          )}
        </Show>
      </Show>

      {/* Subtle bottom-right search & language indicator */}
      <div class="absolute bottom-3 right-5 z-10 flex items-center gap-1.5">
        <button
          type="button"
          title="Find & Replace (Ctrl+F / Ctrl+H)"
          class="px-2 py-1 rounded bg-[var(--bg-surface)]/90 border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 shadow-sm backdrop-blur"
          onClick={openSearchPanel}
        >
          <Search class="w-3 h-3" />
          <span>{langLabel()}</span>
        </button>
      </div>

      <Show when={error()}>
        {(msg) => (
          <div class="m-4 p-3 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs">
            Failed to read file: {msg()}
          </div>
        )}
      </Show>

      <Show when={loading() && !activeBuffer()}>
        <div class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[var(--bg-editor)]/80 text-xs text-[var(--text-secondary)]">
          <Loader2 class="w-4 h-4 animate-spin" />
          <span>Reading {props.file.name}...</span>
        </div>
      </Show>

      <div ref={containerEl} class="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
