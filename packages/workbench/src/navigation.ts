import { createServiceKey } from '@lite-ide/kernel'
import { createSignal } from 'solid-js'
import { isUntitledPath } from './editor-buffers'
import type { ProjectSelectionService } from './services'
import type {
  SymbolDefinition,
  SymbolIndexService,
  SymbolOccurrence,
} from './symbol-index'

/**
 * Code navigation orchestration: bridges the active editor (cursor context,
 * reveal requests) with the project symbol index and the results panel.
 */

export interface EditorCursorInfo {
  relPath: string
  /** 1-based line of the cursor. */
  line: number
  /** 1-based column of the cursor. */
  column: number
  /** Identifier word under the cursor, or null on whitespace/punctuation. */
  word: string | null
}

export interface RevealLocationRequest {
  relPath: string
  line: number
  column: number
  /** Monotonic id so the editor consumes each reveal exactly once. */
  seq: number
}

export type NavigationPanelMode = 'definitions' | 'references' | 'implementations'

export type NavigationPanelNotice = 'noCursor' | null

export interface NavigationPanelState {
  mode: NavigationPanelMode
  symbol: string
  loading: boolean
  /** 'noCursor' renders the "put the cursor on a symbol" guidance. */
  notice: NavigationPanelNotice
  locations: SymbolOccurrence[]
}

export interface CodeNavigationService {
  readonly cursor: () => EditorCursorInfo | null
  setCursor(info: EditorCursorInfo | null): void
  readonly revealRequest: () => RevealLocationRequest | null
  /** Open `relPath` (if needed) and ask the editor to reveal line/column. */
  revealLocation(relPath: string, line: number, column?: number): Promise<void>
  /**
   * Highest reveal seq already applied by an editor. Consumption state lives
   * on the service (not the previewer component) so it survives previewer
   * unmount/remount cycles — a stale reveal must never re-fire.
   */
  readonly revealConsumedSeq: () => number
  markRevealConsumed(seq: number): void
  readonly panel: () => NavigationPanelState | null
  closePanel(): void
  /** F12 — jump straight when unique, otherwise list candidates in the panel. */
  gotoDefinition(): Promise<void>
  /** Shift+F12 — list every indexed occurrence of the cursor word. */
  findReferences(): Promise<void>
  /** Ctrl+F12 — resolve implementers/subclasses/impl blocks for the symbol. */
  gotoImplementation(): Promise<void>
}

export const CodeNavigationKey = createServiceKey<CodeNavigationService>(
  'workbench.codeNavigation',
)

function toOccurrence(def: SymbolDefinition): SymbolOccurrence {
  return {
    name: def.name,
    relPath: def.relPath,
    line: def.line,
    column: def.column,
    text: def.text,
    isDefinition: true,
    kind: def.kind,
  }
}

export function createNavigationService(
  selection: ProjectSelectionService,
  index: SymbolIndexService,
): CodeNavigationService {
  const [cursor, setCursor] = createSignal<EditorCursorInfo | null>(null)
  const [revealRequest, setRevealRequest] = createSignal<RevealLocationRequest | null>(null)
  const [panel, setPanel] = createSignal<NavigationPanelState | null>(null)
  const [revealConsumedSeq, setRevealConsumedSeq] = createSignal(-1)
  let revealSeq = 0
  let actionSeq = 0

  function openLoading(mode: NavigationPanelMode, symbol: string): number {
    const seq = ++actionSeq
    setPanel({ mode, symbol, loading: true, notice: null, locations: [] })
    return seq
  }

  function publishIfCurrent(
    seq: number,
    state: NavigationPanelState | null,
  ): void {
    if (seq !== actionSeq) return
    setPanel(state)
  }

  async function revealLocation(relPath: string, line: number, column = 1): Promise<void> {
    if (isUntitledPath(relPath)) return
    await selection.selectFile(relPath)
    setRevealRequest({ relPath, line, column, seq: ++revealSeq })
  }

  /** Sort occurrences: cursor's file first, then by line within each file. */
  function sortForCursor(
    occurrences: SymbolOccurrence[],
    relPath: string,
  ): SymbolOccurrence[] {
    return [...occurrences].sort(
      (a, b) =>
        Number(a.relPath === relPath ? 0 : 1) - Number(b.relPath === relPath ? 0 : 1) ||
        a.relPath.localeCompare(b.relPath) ||
        a.line - b.line ||
        a.column - b.column,
    )
  }

  function cursorWord(): { info: EditorCursorInfo; word: string } | null {
    const info = cursor()
    if (!info || !info.word) return null
    return { info, word: info.word }
  }

  async function gotoDefinition(): Promise<void> {
    const ctx = cursorWord()
    if (!ctx) {
      setPanel({
        mode: 'definitions',
        symbol: '',
        loading: false,
        notice: 'noCursor',
        locations: [],
      })
      return
    }
    const { info, word } = ctx

    // Claim the action slot so a slow resolution cannot overwrite the result
    // of a newer navigation action. Show a loading panel only while the index
    // is still being built (first use); a warm index resolves instantly.
    const seq = ++actionSeq
    if (index.status() !== 'ready') {
      setPanel({ mode: 'definitions', symbol: word, loading: true, notice: null, locations: [] })
    }

    try {
      const defs = await index.definitions(word)
      if (seq !== actionSeq) return
      // Prefer the cursor's own file, drop `impl` blocks (their targets are
      // better jump sites) and never jump from a definition straight back to
      // itself while other candidates exist.
      const sameFile = defs.filter((d) => d.relPath === info.relPath)
      const pool = sameFile.length > 0 ? sameFile : defs
      const notSelf = pool.filter(
        (d) => !(d.relPath === info.relPath && d.line === info.line),
      )
      const candidates = notSelf.length > 0 ? notSelf : pool
      const nonImpl = candidates.filter((d) => d.kind !== 'impl')

      const target =
        nonImpl.length === 1 ? nonImpl[0] : candidates.length === 1 ? candidates[0] : null
      if (target) {
        actionSeq += 1
        setPanel(null)
        await revealLocation(target.relPath, target.line, target.column)
        return
      }

      setPanel({
        mode: 'definitions',
        symbol: word,
        loading: false,
        notice: null,
        locations: sortForCursor(defs.map(toOccurrence), info.relPath),
      })
    } catch {
      if (seq !== actionSeq) return
      setPanel({
        mode: 'definitions',
        symbol: word,
        loading: false,
        notice: null,
        locations: [],
      })
    }
  }

  async function findReferences(): Promise<void> {
    const ctx = cursorWord()
    if (!ctx) {
      setPanel({
        mode: 'references',
        symbol: '',
        loading: false,
        notice: 'noCursor',
        locations: [],
      })
      return
    }
    const { info, word } = ctx

    const seq = openLoading('references', word)
    try {
      const occurrences = await index.occurrences(word)
      publishIfCurrent(seq, {
        mode: 'references',
        symbol: word,
        loading: false,
        notice: null,
        locations: sortForCursor(occurrences, info.relPath),
      })
    } catch {
      publishIfCurrent(seq, {
        mode: 'references',
        symbol: word,
        loading: false,
        notice: null,
        locations: [],
      })
    }
  }

  async function gotoImplementation(): Promise<void> {
    const ctx = cursorWord()
    if (!ctx) {
      setPanel({
        mode: 'implementations',
        symbol: '',
        loading: false,
        notice: 'noCursor',
        locations: [],
      })
      return
    }
    const { info, word } = ctx

    const seq = openLoading('implementations', word)
    try {
      const defs = await index.definitions(word)
      const atCursor =
        defs.find((d) => d.relPath === info.relPath && d.line === info.line) ??
        defs.find((d) => d.relPath === info.relPath) ??
        defs[0]
      let impls = await index.implementations(word, atCursor?.kind)

      if (impls.length === 0) {
        // Pragmatic fallback: same-name definitions elsewhere stand in for
        // implementations (e.g. trait method ↔ its impl methods in Rust).
        impls = defs.filter((d) => !(d.relPath === info.relPath && d.line === info.line))
      }

      if (impls.length === 1) {
        actionSeq += 1
        setPanel(null)
        await revealLocation(impls[0].relPath, impls[0].line, impls[0].column)
        return
      }

      publishIfCurrent(seq, {
        mode: 'implementations',
        symbol: word,
        loading: false,
        notice: null,
        locations: sortForCursor(impls.map(toOccurrence), info.relPath),
      })
    } catch {
      publishIfCurrent(seq, {
        mode: 'implementations',
        symbol: word,
        loading: false,
        notice: null,
        locations: [],
      })
    }
  }

  return {
    cursor,
    setCursor,
    revealRequest,
    revealLocation,
    revealConsumedSeq,
    markRevealConsumed(seq: number) {
      // Monotonic: an older reveal consumed after a newer one stays consumed.
      if (seq > revealConsumedSeq()) setRevealConsumedSeq(seq)
    },
    panel,
    closePanel() {
      setPanel(null)
    },
    gotoDefinition,
    findReferences,
    gotoImplementation,
  }
}
