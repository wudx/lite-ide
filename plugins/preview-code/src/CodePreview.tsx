import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  HighlightStyle,
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
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { PreviewProps } from '@lite-ide/kernel'
import {
  CodeNavigationKey,
  DEFAULT_BUFFER_MAX_BYTES,
  EditorBufferKey,
  formatBytes,
  getI18n,
  ProjectSelectionKey,
  ThemeStateKey,
  type DocumentBuffer,
  type RevealLocationRequest,
  type ThemeAppearance,
} from '@lite-ide/workbench'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Lock from 'lucide-solid/icons/lock'
import Search from 'lucide-solid/icons/search'
import AlertTriangle from 'lucide-solid/icons/triangle-exclamation-point'
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from 'solid-js'
import { CodeEditorCacheKey } from './editor-cache'
import { CODEMIRROR_ZH_CN_PHRASES } from './i18n'
import { CodeStatsKey } from './stats'

const EXTENDED_MAX_BYTES = 10 * 1024 * 1024

// Module-level Compartment singletons remain valid across EditorState cache restores.
const languageCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
const listenerCompartment = new Compartment()
const themeCompartment = new Compartment()
const phrasesCompartment = new Compartment()

// Navigation reveal highlight: flashes the target line after a jump
// (F12 / references panel row) and auto-clears shortly afterwards.
const flashLineEffect = StateEffect.define<number>()
const clearFlashEffect = StateEffect.define<null>()

const flashLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(flashLineEffect)) {
        const pos = Math.min(Math.max(0, effect.value), tr.state.doc.length)
        const line = tr.state.doc.lineAt(pos)
        value = Decoration.set([Decoration.line({ class: 'cm-flashLine' }).range(line.from)])
      } else if (effect.is(clearFlashEffect)) {
        value = Decoration.none
      }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const ideDarkHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#c49bff' },
  { tag: [tags.modifier, tags.self], color: '#d4b8ff' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#e6ebf5' },
  { tag: [tags.variableName], color: '#dce2ee' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#7aa2ff' },
  { tag: [tags.propertyName, tags.attributeName], color: '#8ec5fc' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#7dd3fc' },
  { tag: [tags.tagName], color: '#f38ba8' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit], color: '#f4b17a' },
  { tag: [tags.string, tags.docString, tags.attributeValue], color: '#8be0a4' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: '#f9e2af' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#8b95aa' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#60697c', fontStyle: 'italic' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: '#a5b4fc' },
  { tag: [tags.heading], color: '#93b4ff', fontWeight: '600' },
  { tag: [tags.strong], fontWeight: '600', color: '#f4f6fb' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: '#7aa2ff', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#f87171' },
])

const ideLightHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#7c3aed' },
  { tag: [tags.modifier, tags.self], color: '#6d28d9' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#181c25' },
  { tag: [tags.variableName], color: '#1e2433' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#2563eb' },
  { tag: [tags.propertyName, tags.attributeName], color: '#0369a1' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#0284c7' },
  { tag: [tags.tagName], color: '#e11d48' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit], color: '#c2410c' },
  { tag: [tags.string, tags.docString, tags.attributeValue], color: '#15803d' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: '#b45309' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#64748b' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#8b95a7', fontStyle: 'italic' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: '#4f46e5' },
  { tag: [tags.heading], color: '#2563eb', fontWeight: '600' },
  { tag: [tags.strong], fontWeight: '600', color: '#0f172a' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: '#2563eb', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#dc2626' },
])

// Canonical Solarized Light syntax palette: green keywords, cyan strings,
// blue functions, yellow types, base01/base00 plain text on base3 parchment.
const ideSolarizedHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: '#859900' },
  { tag: [tags.modifier, tags.self], color: '#b58900' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#073642' },
  { tag: [tags.variableName], color: '#586e75' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#268bd2' },
  { tag: [tags.propertyName, tags.attributeName], color: '#268bd2' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#b58900' },
  { tag: [tags.tagName], color: '#268bd2' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit], color: '#d33682' },
  { tag: [tags.string, tags.docString, tags.attributeValue], color: '#2aa198' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: '#cb4b16' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: '#657b83' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: '#93a1a1', fontStyle: 'italic' },
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: '#6c71c4' },
  { tag: [tags.heading], color: '#268bd2', fontWeight: '600' },
  { tag: [tags.strong], fontWeight: '600', color: '#073642' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: '#268bd2', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#dc322f' },
])

const baseThemeStyles = {
  '&': {
    height: '100%',
    fontSize: '13px',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-editor)',
  },
  '.cm-content': {
    padding: '12px 0',
    caretColor: 'var(--accent)',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily:
      'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
    lineHeight: '1.65',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-editor)',
    borderRight: 'none',
    paddingRight: '8px',
    paddingLeft: '4px',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '34px',
    padding: '0 6px 0 8px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-line.cm-flashLine': {
    backgroundColor: 'var(--accent-soft)',
    transition: 'background-color 0.25s ease',
  },
  '&.cm-ctrlNav .cm-content': {
    cursor: 'pointer',
  },
  '&.cm-focused .cm-cursor, &.cm-focused .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '1.5px',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-editor-chrome)',
    color: 'var(--text-primary)',
    borderBottom: '1px solid var(--border-subtle)',
  },
}

const ideDarkTheme = EditorView.theme(
  {
    ...baseThemeStyles,
    '.cm-gutters': {
      ...baseThemeStyles['.cm-gutters'],
      color: '#4d5466',
    },
    '.cm-activeLineGutter': {
      ...baseThemeStyles['.cm-activeLineGutter'],
      color: '#c2cad8',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.026)',
    },
    // Match the specificity of CodeMirror's default focused-selection rule
    // (&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground)
    // or the default colors win — same applies to the light/solarized themes below.
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(122, 162, 255, 0.22)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(122, 162, 255, 0.14)',
      borderRadius: '3px',
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(122, 162, 255, 0.2)',
      outline: '1px solid rgba(122, 162, 255, 0.35)',
      borderRadius: '3px',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(244, 177, 122, 0.18)',
      outline: '1px solid rgba(244, 177, 122, 0.35)',
      borderRadius: '3px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(122, 162, 255, 0.3)',
      outline: '1px solid rgba(122, 162, 255, 0.55)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgba(255, 255, 255, 0.06)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      color: 'var(--text-secondary)',
      borderRadius: '5px',
      padding: '0 6px',
      margin: '0 4px',
    },
    '.cm-tooltip': {
      backgroundColor: '#1b1e28',
      border: '1px solid var(--border-strong)',
      borderRadius: '8px',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
    },
  },
  { dark: true },
)

const ideLightTheme = EditorView.theme(
  {
    ...baseThemeStyles,
    '.cm-gutters': {
      ...baseThemeStyles['.cm-gutters'],
      color: '#9ca3af',
    },
    '.cm-activeLineGutter': {
      ...baseThemeStyles['.cm-activeLineGutter'],
      color: '#1f2937',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(15, 23, 42, 0.032)',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(59, 111, 246, 0.16)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(59, 111, 246, 0.11)',
      borderRadius: '3px',
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(59, 111, 246, 0.14)',
      outline: '1px solid rgba(59, 111, 246, 0.35)',
      borderRadius: '3px',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(245, 158, 11, 0.22)',
      outline: '1px solid rgba(217, 119, 6, 0.38)',
      borderRadius: '3px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(59, 111, 246, 0.24)',
      outline: '1px solid rgba(59, 111, 246, 0.5)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgba(15, 23, 42, 0.05)',
      border: '1px solid rgba(15, 23, 42, 0.12)',
      color: 'var(--text-secondary)',
      borderRadius: '5px',
      padding: '0 6px',
      margin: '0 4px',
    },
    '.cm-tooltip': {
      backgroundColor: '#ffffff',
      border: '1px solid var(--border-strong)',
      borderRadius: '8px',
      boxShadow: '0 10px 28px rgba(15, 23, 42, 0.12)',
    },
  },
  { dark: false },
)

const ideSolarizedTheme = EditorView.theme(
  {
    ...baseThemeStyles,
    '.cm-gutters': {
      ...baseThemeStyles['.cm-gutters'],
      color: '#93a1a1',
    },
    '.cm-activeLineGutter': {
      ...baseThemeStyles['.cm-activeLineGutter'],
      color: '#073642',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(7, 54, 66, 0.055)',
    },
    // VSCode editor.selectionBackground in Solarized Light is solid base2 #EEE8D5.
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(238, 232, 213, 0.9)',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(238, 232, 213, 0.9)',
      borderRadius: '3px',
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(38, 139, 210, 0.15)',
      outline: '1px solid rgba(38, 139, 210, 0.38)',
      borderRadius: '3px',
    },
    '.cm-searchMatch': {
      backgroundColor: 'rgba(181, 137, 0, 0.20)',
      outline: '1px solid rgba(181, 137, 0, 0.38)',
      borderRadius: '3px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'rgba(38, 139, 210, 0.26)',
      outline: '1px solid rgba(38, 139, 210, 0.52)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgba(7, 54, 66, 0.06)',
      border: '1px solid rgba(7, 54, 66, 0.14)',
      color: 'var(--text-secondary)',
      borderRadius: '5px',
      padding: '0 6px',
      margin: '0 4px',
    },
    '.cm-tooltip': {
      backgroundColor: '#fdf6e3',
      border: '1px solid var(--border-strong)',
      borderRadius: '8px',
      boxShadow: '0 10px 28px rgba(7, 54, 66, 0.14)',
    },
  },
  { dark: false },
)

function getEditorThemeExtension(themeId: string, appearance: ThemeAppearance): Extension {
  // Solarized 拥有专属 CodeMirror 配色；其余浅色主题（含插件贡献主题）
  // 共享标准浅色配色，深色主题同理。
  if (themeId === 'solarized-light') {
    return [
      syntaxHighlighting(ideSolarizedHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ideSolarizedTheme,
    ]
  }
  if (appearance === 'light') {
    return [
      syntaxHighlighting(ideLightHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      ideLightTheme,
    ]
  }
  return [
    syntaxHighlighting(ideDarkHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ideDarkTheme,
  ]
}

function computeCursorPosition(state: EditorState): { line: number; column: number } {
  const head = state.selection.main.head
  const lineInfo = state.doc.lineAt(head)
  return {
    line: lineInfo.number,
    column: head - lineInfo.from + 1,
  }
}

function getPhrasesExtension(locale: string): Extension {
  return locale === 'zh-CN' ? EditorState.phrases.of(CODEMIRROR_ZH_CN_PHRASES) : []
}

function buildEditorExtensions(
  readOnly: boolean,
  listenerExt: Extension,
  themeId: string,
  appearance: ThemeAppearance,
  locale: string,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    flashLineField,
    themeCompartment.of(getEditorThemeExtension(themeId, appearance)),
    phrasesCompartment.of(getPhrasesExtension(locale)),
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
  const themeState = props.scope.tryGet(ThemeStateKey)
  const i18n = getI18n(props.scope)
  const codeStats = props.scope.tryGet(CodeStatsKey)
  const editorCache = props.scope.tryGet(CodeEditorCacheKey)
  const navigation = props.scope.tryGet(CodeNavigationKey)

  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [maxBytes, setMaxBytes] = createSignal(DEFAULT_BUFFER_MAX_BYTES)
  const [langLabel, setLangLabel] = createSignal('Plain Text')

  const activeBuffer = createMemo(() => buffers.getBuffer(props.file.relPath))
  const activeDiskRevision = createMemo(() => activeBuffer()?.diskRevision ?? -1)
  const currentTheme = (): string => themeState?.theme() ?? 'dark'
  const currentAppearance = (): ThemeAppearance => themeState?.appearance() ?? 'dark'

  let containerEl: HTMLDivElement | undefined
  let view: EditorView | undefined
  let mountedRelPath: string | null = null
  let mountedDiskRevision = -1
  let mountedMaxBytes = DEFAULT_BUFFER_MAX_BYTES
  let isApplyingExternal = false
  let readSeq = 0
  let langSeq = 0
  let flashTimer: ReturnType<typeof setTimeout> | undefined

  /** Jump to a navigation location: place the cursor, center the line, flash. */
  function performReveal(request: RevealLocationRequest) {
    if (!view || !request) return
    const doc = view.state.doc
    const lineNo = Math.min(Math.max(1, request.line), doc.lines)
    const line = doc.line(lineNo)
    const column = Math.min(Math.max(1, request.column), Math.max(1, line.length))
    const pos = line.from + column - 1

    view.dispatch({
      selection: { anchor: pos },
      effects: [
        EditorView.scrollIntoView(pos, { y: 'center' }),
        flashLineEffect.of(line.from),
      ],
    })

    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = undefined
      view?.dispatch({ effects: clearFlashEffect.of(null) })
    }, 1600)
  }

  /** Consume a pending reveal that matches the currently mounted buffer. */
  function consumePendingReveal() {
    if (!navigation || !view) return
    const request = navigation.revealRequest()
    if (!request) return
    if (request.relPath !== mountedRelPath) return
    // Consumption state lives on the service, surviving previewer remounts:
    // a reveal applied once (possibly minutes ago) must never re-fire.
    if (request.seq <= navigation.revealConsumedSeq()) return
    navigation.markRevealConsumed(request.seq)
    performReveal(request)
  }

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

  /** Publish the editor cursor (line/column/word) to the navigation service. */
  function reportCursor(relPath: string) {
    if (!navigation || !view) return
    const head = view.state.selection.main.head
    const lineInfo = view.state.doc.lineAt(head)
    const word = view.state.wordAt(head)
    navigation.setCursor({
      relPath,
      line: lineInfo.number,
      column: head - lineInfo.from + 1,
      word: word ? view.state.sliceDoc(word.from, word.to) : null,
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
        reportCursor(relPath)
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
    const mode = untrack(currentTheme)
    const appearance = untrack(currentAppearance)
    const currentLocale = untrack(() => i18n.locale())

    mountedRelPath = buf.relPath
    mountedDiskRevision = buf.diskRevision
    mountedMaxBytes = buf.maxBytes

    // A pending reveal for the incoming buffer takes over scrolling (its
    // scrollIntoView below must win). Restoring the cached scroll in a rAF
    // would otherwise fire one frame later and yank the view back to the
    // file's previous position, hiding the jump target on long files.
    const pendingReveal = navigation?.revealRequest()
    const revealTakesScroll = Boolean(
      pendingReveal &&
        pendingReveal.relPath === buf.relPath &&
        pendingReveal.seq > (navigation?.revealConsumedSeq() ?? -1),
    )

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
            themeCompartment.reconfigure(getEditorThemeExtension(mode, appearance)),
            phrasesCompartment.reconfigure(getPhrasesExtension(currentLocale)),
          ],
        })
        if (!revealTakesScroll) {
          const targetScrollTop = cached.scrollTop
          const targetScrollLeft = cached.scrollLeft
          // The reveal request may arrive AFTER this frame is queued (the
          // buffer was already loaded, so applyBufferToView runs during
          // selectFile's await, before revealLocation sets the request).
          // Skip the restore if a reveal was consumed in the meantime — its
          // scrollIntoView must win over the cached scroll.
          const consumedAtQueue = navigation?.revealConsumedSeq() ?? -1
          requestAnimationFrame(() => {
            if (
              view &&
              mountedRelPath === buf.relPath &&
              (navigation?.revealConsumedSeq() ?? -1) === consumedAtQueue
            ) {
              view.scrollDOM.scrollTop = targetScrollTop
              view.scrollDOM.scrollLeft = targetScrollLeft
            }
          })
        }
      } else {
        const nextState = EditorState.create({
          doc: buf.content,
          extensions: buildEditorExtensions(
            buf.readOnly,
            listenerExt,
            mode,
            appearance,
            currentLocale,
          ),
        })
        view.setState(nextState)
        applyLanguageSupport(buf.relPath, fileName, fileExt)
      }
    } finally {
      isApplyingExternal = false
    }

    updateStatsFromView(buf.relPath, label)
    // setState() swaps the document without running the update listener, so
    // the navigation cursor must be re-published for the newly mounted file.
    reportCursor(buf.relPath)
    // A reveal for a newly mounted buffer (opened by a navigation jump) cannot
    // be handled by the reactive effect below — mountedRelPath is not reactive
    // — so consume it right after the buffer lands in the editor.
    consumePendingReveal()
  }

  // Ctrl/Cmd held over the editor hints jumpability with a pointer cursor.
  function updateCtrlNavClass(held: boolean) {
    if (view) view.dom.classList.toggle('cm-ctrlNav', held)
  }

  // Ctrl/Cmd+click on an identifier jumps to its definition (VSCode-style).
  function handleNavigationMouseDown(e: MouseEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || !view || !navigation) return
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos === null) return
    const word = view.state.wordAt(pos)
    if (!word) return
    e.preventDefault()
    e.stopPropagation()
    view.focus()
    const relPath = mountedRelPath
    if (!relPath) return
    const lineInfo = view.state.doc.lineAt(word.from)
    navigation.setCursor({
      relPath,
      line: lineInfo.number,
      column: word.from - lineInfo.from + 1,
      word: view.state.sliceDoc(word.from, word.to),
    })
    void navigation.gotoDefinition()
  }

  onMount(() => {
    if (!containerEl) return
    view = new EditorView({
      parent: containerEl,
      state: EditorState.create({
        doc: '',
        extensions: buildEditorExtensions(
          true,
          [],
          untrack(currentTheme),
          untrack(currentAppearance),
          untrack(() => i18n.locale()),
        ),
      }),
    })
    // Capture phase: intercept before CodeMirror's own selection handling.
    view.dom.addEventListener('mousedown', handleNavigationMouseDown, true)
    window.addEventListener('keydown', handleCtrlTrackKeyDown, true)
    window.addEventListener('keyup', handleCtrlTrackKeyUp, true)
    window.addEventListener('blur', handleCtrlTrackBlur)
  })

  function handleCtrlTrackKeyDown(e: KeyboardEvent) {
    if (e.key === 'Control' || e.key === 'Meta') updateCtrlNavClass(true)
  }

  function handleCtrlTrackKeyUp(e: KeyboardEvent) {
    if (e.key === 'Control' || e.key === 'Meta') updateCtrlNavClass(false)
  }

  function handleCtrlTrackBlur() {
    updateCtrlNavClass(false)
  }

  onCleanup(() => {
    if (view) view.dom.removeEventListener('mousedown', handleNavigationMouseDown, true)
    window.removeEventListener('keydown', handleCtrlTrackKeyDown, true)
    window.removeEventListener('keyup', handleCtrlTrackKeyUp, true)
    window.removeEventListener('blur', handleCtrlTrackBlur)
    if (flashTimer) clearTimeout(flashTimer)
    navigation?.setCursor(null)
    saveMountedToCache()
    codeStats?.setStats(null)
    view?.destroy()
    view = undefined
    mountedRelPath = null
  })

  // Keep CodeMirror theme & highlight palette synced with workbench theme.
  createEffect(() => {
    const mode = currentTheme()
    const appearance = currentAppearance()
    if (!view) return
    isApplyingExternal = true
    try {
      view.dispatch({
        effects: themeCompartment.reconfigure(getEditorThemeExtension(mode, appearance)),
      })
    } finally {
      isApplyingExternal = false
    }
  })

  // Keep CodeMirror UI phrases synced with workbench locale.
  createEffect(() => {
    const loc = i18n.locale()
    if (!view) return
    isApplyingExternal = true
    try {
      view.dispatch({
        effects: phrasesCompartment.reconfigure(getPhrasesExtension(loc)),
      })
    } finally {
      isApplyingExternal = false
    }
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

  // Consume navigation reveal requests targeting the mounted buffer. Runs on
  // both the request and buffer identity changes: a reveal for an already
  // mounted file must fire, and a buffer swap re-checks any pending reveal
  // (applyBufferToView also consumes it for paths the effect never sees).
  createEffect(() => {
    const request = navigation?.revealRequest()
    const buf = activeBuffer()
    if (!request || !buf || !navigation) return
    if (request.relPath !== buf.relPath) return
    if (request.seq <= navigation.revealConsumedSeq()) return
    // Buffer content may still be loading; applyBufferToView will consume it.
    if (buf.relPath !== mountedRelPath) return
    navigation.markRevealConsumed(request.seq)
    performReveal(request)
  })

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
          <div class="px-3.5 py-2 bg-[var(--danger-bg)] border-b border-[var(--danger-border)] flex items-center justify-between gap-3 text-xs text-[var(--danger-text)]">
            <div class="flex items-center gap-2 min-w-0">
              <AlertTriangle class="w-3.5 h-3.5 shrink-0 text-[var(--danger-icon)]" />
              <span class="truncate">{i18n.t('previewCode.saveFailed', { message: errMsg() })}</span>
            </div>
            <button
              type="button"
              class="px-2.5 py-1 rounded-md bg-[var(--danger-btn-bg)] hover:bg-[var(--danger-btn-hover)] text-[var(--danger-text)] font-medium transition-colors shrink-0"
              onClick={() => {
                const buf = activeBuffer()
                if (!buf) return
                void (buf.conflict !== 'none'
                  ? buffers.overwriteConflict(buf.relPath)
                  : buffers.saveBuffer(buf.relPath))
              }}
            >
              {i18n.t('previewCode.retry')}
            </button>
          </div>
        )}
      </Show>

      {/* External disk change / deletion conflict banner */}
      <Show when={activeBuffer() && activeBuffer()!.conflict !== 'none'}>
        <Show when={activeBuffer()}>
          {(buf) => (
            <div class="px-3.5 py-2 bg-[var(--warning-bg)] border-b border-[var(--warning-border)] flex items-center justify-between gap-3 text-xs text-[var(--warning-text)]">
              <div class="flex items-center gap-2 min-w-0">
                <AlertTriangle class="w-3.5 h-3.5 shrink-0 text-[var(--warning-icon)]" />
                <span class="truncate">
                  {buf().conflict === 'deleted'
                    ? i18n.t('previewCode.conflictDeleted')
                    : i18n.t('previewCode.conflictModified')}
                </span>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <Show when={buf().conflict === 'modified'}>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-md bg-[var(--warning-btn-bg)] hover:bg-[var(--warning-btn-hover)] text-[var(--warning-text)] font-medium transition-colors"
                    onClick={() => void buffers.reloadBuffer(buf().relPath)}
                  >
                    {i18n.t('previewCode.reloadFromDisk')}
                  </button>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-md bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-medium transition-colors"
                    onClick={() => void buffers.overwriteConflict(buf().relPath)}
                  >
                    {i18n.t('previewCode.overwriteDisk')}
                  </button>
                  <button
                    type="button"
                    class="px-2 py-1 rounded-md hover:bg-[var(--warning-btn-bg)] text-[var(--warning-text)] transition-colors"
                    onClick={() => buffers.dismissConflict(buf().relPath)}
                  >
                    {i18n.t('previewCode.dismiss')}
                  </button>
                </Show>

                <Show when={buf().conflict === 'deleted'}>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-md bg-[var(--warning-btn-bg)] hover:bg-[var(--warning-btn-hover)] text-[var(--warning-text)] font-medium transition-colors"
                    onClick={() => void buffers.overwriteConflict(buf().relPath)}
                  >
                    {i18n.t('previewCode.recreateSave')}
                  </button>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-md bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-[var(--text-primary)] transition-colors"
                    onClick={() => {
                      const path = buf().relPath
                      buffers.discardBuffer(path)
                      void selection?.closeTab(path)
                    }}
                  >
                    {i18n.t('previewCode.closeTab')}
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
            <div class="px-3.5 py-2 bg-[var(--warning-bg)] border-b border-[var(--warning-border)] flex items-center justify-between gap-3 text-xs text-[var(--warning-text)]">
              <div class="flex items-center gap-2 min-w-0">
                <Lock class="w-3.5 h-3.5 shrink-0 text-[var(--warning-icon)]" />
                <span class="truncate">
                  {buf().truncated
                    ? i18n.t('previewCode.truncatedBanner', {
                        loaded: formatBytes(buf().loadedBytes),
                        total: formatBytes(buf().totalBytes),
                      })
                    : buf().encoding
                      ? i18n.t('previewCode.unsupportedEncoding', { encoding: buf().encoding })
                      : (buf().readOnlyReason ?? i18n.t('previewCode.readOnlyDefault'))}
                </span>
              </div>
              <Show when={buf().truncated && buf().maxBytes < EXTENDED_MAX_BYTES}>
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-md bg-[var(--warning-btn-bg)] hover:bg-[var(--warning-btn-hover)] text-[var(--warning-text)] font-medium transition-colors shrink-0"
                  onClick={handleLoadExtended}
                >
                  {i18n.t('previewCode.loadUpTo10Mb')}
                </button>
              </Show>
            </div>
          )}
        </Show>
      </Show>

      {/* Floating glass pill: search & language indicator */}
      <div class="absolute bottom-3.5 right-4 z-10 flex items-center">
        <button
          type="button"
          title={`${i18n.t('previewCode.findReplaceTitle')}\n${i18n.t('previewCode.navHint')}`}
          class="glass-pill rounded-full px-3 py-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-border)] flex items-center gap-1.5 transition-all duration-150 active:scale-[0.98]"
          onClick={openSearchPanel}
        >
          <Search class="w-3 h-3 text-[var(--accent)]" />
          <span class="font-medium">
            {langLabel() === 'Plain Text' ? i18n.t('previewCode.plainText') : langLabel()}
          </span>
          <span class="text-[10px] font-mono text-[var(--text-muted)] pl-1.5 border-l border-[var(--divider)]">
            Ctrl+F
          </span>
        </button>
      </div>

      <Show when={error()}>
        {(msg) => (
          <div class="m-4 p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs">
            {i18n.t('previewCode.readFailed', { message: msg() })}
          </div>
        )}
      </Show>

      <Show when={loading() && !activeBuffer()}>
        <div class="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[var(--bg-editor)]/80 backdrop-blur-[2px] text-xs text-[var(--text-secondary)]">
          <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
          <span>{i18n.t('previewCode.reading', { name: props.file.name })}</span>
        </div>
      </Show>

      <div ref={containerEl} class="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
