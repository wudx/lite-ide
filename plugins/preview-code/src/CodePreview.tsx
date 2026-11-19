import { defaultKeymap } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  LanguageDescription,
  syntaxHighlighting,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, openSearchPanel as openCM, search, searchKeymap } from '@codemirror/search'
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
} from '@codemirror/view'
import type { PreviewProps } from '@lite-ide/kernel'
import type { TextPayload } from '@lite-ide/protocol'
import { formatBytes, WorkspaceBackendKey } from '@lite-ide/workbench'
import { AlertTriangle, Loader2, Search } from 'lucide-solid'
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { CodeStatsKey } from './stats'

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const EXTENDED_MAX_BYTES = 10 * 1024 * 1024

const ideTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--bg-editor)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
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

export default function CodePreview(props: PreviewProps) {
  const backend = props.scope.get(WorkspaceBackendKey)
  const codeStats = props.scope.tryGet(CodeStatsKey)

  const [payload, setPayload] = createSignal<TextPayload | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [maxBytes, setMaxBytes] = createSignal(DEFAULT_MAX_BYTES)
  const [langLabel, setLangLabel] = createSignal('Plain Text')

  let containerEl: HTMLDivElement | undefined
  let view: EditorView | undefined
  const languageCompartment = new Compartment()

  const baseExtensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    foldGutter(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    ideTheme,
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([...searchKeymap, ...defaultKeymap, ...foldKeymap]),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    languageCompartment.of([]),
  ]

  let readSeq = 0
  let langSeq = 0

  onMount(() => {
    if (!containerEl) return
    view = new EditorView({
      parent: containerEl,
      state: EditorState.create({
        doc: '',
        extensions: baseExtensions,
      }),
    })
  })

  onCleanup(() => {
    codeStats?.setStats(null)
    view?.destroy()
    view = undefined
  })

  // Reset byte cap when switching to another file.
  createEffect(
    on(
      () => props.file.relPath,
      () => {
        setMaxBytes(DEFAULT_MAX_BYTES)
      },
    ),
  )

  createEffect(() => {
    const file = props.file
    const limit = maxBytes()
    const seq = ++readSeq
    const currentLangSeq = ++langSeq

    setLoading(true)
    setError(null)

    const matchedLang = LanguageDescription.matchFilename(languages, file.name)
    setLangLabel(matchedLang?.name ?? (file.ext ? file.ext.toUpperCase() : 'Plain Text'))

    void backend
      .readText(props.scope.id, file.relPath, limit)
      .then((res) => {
        if (seq !== readSeq) return
        setPayload(res)
        setLoading(false)

        codeStats?.setStats({
          language: matchedLang?.name ?? (file.ext ? file.ext.toUpperCase() : 'Plain Text'),
          lineCount: res.lineCount,
          encoding: res.encoding,
          size: res.totalBytes,
        })

        if (view) {
          const nextState = EditorState.create({
            doc: res.content,
            extensions: baseExtensions,
          })
          view.setState(nextState)

          if (matchedLang) {
            void matchedLang
              .load()
              .then((support) => {
                if (currentLangSeq !== langSeq || !view) return
                view.dispatch({
                  effects: languageCompartment.reconfigure(support),
                })
              })
              .catch(() => {
                // Keep plain text highlight if a grammar fails to load.
              })
          }
        }
      })
      .catch((err) => {
        if (seq !== readSeq) return
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  })

  function openSearchPanel() {
    if (!view) return
    view.focus()
    openCM(view)
  }

  return (
    <div class="flex-1 min-h-0 flex flex-col relative">
      {/* Truncation banner for very large files */}
      <Show when={payload()?.truncated}>
        {(isTruncated) => (
          <Show when={isTruncated() && payload()}>
            {(data) => (
              <div class="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 flex items-center justify-between gap-3 text-xs text-amber-200">
                <div class="flex items-center gap-2">
                  <AlertTriangle class="w-3.5 h-3.5 shrink-0 text-amber-400" />
                  <span>
                    Showing first {formatBytes(data().loadedBytes)} of {formatBytes(data().totalBytes)}.
                  </span>
                </div>
                <Show when={maxBytes() < EXTENDED_MAX_BYTES}>
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium transition-colors"
                    onClick={() => setMaxBytes(EXTENDED_MAX_BYTES)}
                  >
                    Load up to 10 MB
                  </button>
                </Show>
              </div>
            )}
          </Show>
        )}
      </Show>

      {/* Subtle top-right search button & language indicator */}
      <div class="absolute top-2 right-4 z-10 flex items-center gap-1.5">
        <button
          type="button"
          title="Find in file (Ctrl+F)"
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

      <Show when={loading() && !payload()}>
        <div class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[var(--bg-editor)]/80 text-xs text-[var(--text-secondary)]">
          <Loader2 class="w-4 h-4 animate-spin" />
          <span>Reading {props.file.name}...</span>
        </div>
      </Show>

      <div ref={containerEl} class="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
