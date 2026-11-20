import type { AppKernel, ContributionMap, PreviewProps, ProjectScope } from '@lite-ide/kernel'
import Check from 'lucide-solid/icons/check'
import ChevronRight from 'lucide-solid/icons/chevron-right'
import FileCode2 from 'lucide-solid/icons/file-code-corner'
import Folder from 'lucide-solid/icons/folder'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Lock from 'lucide-solid/icons/lock'
import Plus from 'lucide-solid/icons/plus'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Save from 'lucide-solid/icons/save'
import AlertTriangle from 'lucide-solid/icons/triangle-exclamation-point'
import X from 'lucide-solid/icons/x'
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  onCleanup,
  Show,
  type Component,
} from 'solid-js'
import { Dynamic } from 'solid-js/web'
import {
  requestCloseAllTabs,
  requestCloseOtherTabs,
  requestCloseTab,
  requestRevertFile,
  requestSaveFile,
  saveUntitledAs,
} from '../close-guards'
import { copyTextToClipboard } from '../clipboard'
import { EditorBufferKey, untitledDisplayNameOf } from '../editor-buffers'
import { formatBytes } from '../format'
import { joinNativePath } from '../paths'
import { ProjectSelectionKey } from '../services'
import { FileIcon } from './FileIcon'

export interface PreviewHostProps {
  kernel: AppKernel
  scope: ProjectScope
}

type PreviewerContribution = ContributionMap['previewer.provider']

const previewComponentCache = new Map<string, Component<PreviewProps>>()
const previewInflightCache = new Map<string, Promise<Component<PreviewProps>>>()

function loadPreviewComponent(provider: PreviewerContribution): Promise<Component<PreviewProps>> {
  const cached = previewComponentCache.get(provider.id)
  if (cached) return Promise.resolve(cached)

  const inflight = previewInflightCache.get(provider.id)
  if (inflight) return inflight

  const promise = provider
    .load()
    .then((mod) => {
      previewComponentCache.set(provider.id, mod.default)
      previewInflightCache.delete(provider.id)
      return mod.default
    })
    .catch((err) => {
      previewInflightCache.delete(provider.id)
      throw err
    })

  previewInflightCache.set(provider.id, promise)
  return promise
}

function parentFolderLabel(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

export function PreviewHost(props: PreviewHostProps) {
  const selection = props.scope.get(ProjectSelectionKey)
  const buffers = props.scope.tryGet(EditorBufferKey)
  const providers = props.kernel.contributions('previewer.provider')

  const duplicateTabNames = createMemo(() => {
    const counts = new Map<string, number>()
    for (const tab of selection.openTabs()) {
      counts.set(tab.name, (counts.get(tab.name) ?? 0) + 1)
    }
    const dups = new Set<string>()
    for (const [name, count] of counts) {
      if (count > 1) dups.add(name)
    }
    return dups
  })

  const currentBuffer = createMemo(() => {
    const path = selection.selectedPath()
    if (!path || !buffers) return undefined
    return buffers.getBuffer(path)
  })

  const pathSegments = createMemo(() => {
    const rel = selection.selectedPath()
    if (!rel) return []
    return rel.replace(/\\/g, '/').split('/').filter(Boolean)
  })

  const matchedProviders = createMemo(() => {
    const meta = selection.fileMeta()
    if (!meta) return []
    return providers()
      .filter((p) => p.canHandle(meta))
      .sort((a, b) => b.priority - a.priority)
  })

  const activeProvider = createMemo(() => {
    const list = matchedProviders()
    if (list.length === 0) return undefined
    const preferred = selection.preferredPreviewerId()
    if (preferred) {
      const explicit = list.find((p) => p.id === preferred)
      if (explicit) return explicit
    }
    return list[0]
  })

  const [loadedView, setLoadedView] = createSignal<{
    id: string
    component: Component<PreviewProps>
  } | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [tabMenu, setTabMenu] = createSignal<{
    relPath: string
    x: number
    y: number
  } | null>(null)
  const [saveAsName, setSaveAsName] = createSignal('')
  const [saveAsError, setSaveAsError] = createSignal<string | null>(null)
  const [savingUntitled, setSavingUntitled] = createSignal(false)
  // Live directory part of the typed save target, e.g. "src/components" from
  // "src/components/notes.md"; empty means the project root.
  const saveAsDir = createMemo(() => {
    const cleaned = saveAsName().trim().replace(/\\/g, '/')
    const idx = cleaned.lastIndexOf('/')
    return idx === -1 ? '' : cleaned.slice(0, idx)
  })
  let saveAsInput: HTMLInputElement | undefined
  let tabStrip: HTMLDivElement | undefined
  let loadSeq = 0

  const matchedLoadedView = createMemo(() => {
    const current = activeProvider()
    const loaded = loadedView()
    return current && loaded && loaded.id === current.id ? loaded : undefined
  })

  createEffect(() => {
    const menu = tabMenu()
    if (!menu) return

    const close = () => setTabMenu(null)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTabMenu(null)
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKeyDown)
    })
  })

  createEffect(() => {
    const target = selection.pendingSaveAs()
    if (!target) return

    setSaveAsName(untitledDisplayNameOf(target))
    setSaveAsError(selection.pendingSaveAsError())
    saveAsInput?.focus()
    saveAsInput?.select()
    const close = () => selection.cancelSaveAs()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        selection.cancelSaveAs()
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKeyDown)
    })
  })

  createEffect(() => {
    const provider = activeProvider()
    if (!provider) {
      loadSeq += 1
      setLoadedView(null)
      setLoadError(null)
      return
    }

    if (loadedView()?.id === provider.id) {
      setLoadError(null)
      return
    }

    const cached = previewComponentCache.get(provider.id)
    if (cached) {
      loadSeq += 1
      setLoadError(null)
      setLoadedView({ id: provider.id, component: cached })
      return
    }

    const seq = ++loadSeq
    setLoadError(null)
    void loadPreviewComponent(provider)
      .then((component) => {
        if (seq !== loadSeq) return
        setLoadedView({ id: provider.id, component })
      })
      .catch((err) => {
        if (seq !== loadSeq) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
  })

  // Reveal the active tab inside the scrollable tab strip. Newly opened tabs
  // are appended past the visible width, so scroll them into view whenever
  // the tab list or selection changes (open file, keyboard switch, close).
  createEffect(() => {
    selection.openTabs()
    if (!selection.selectedPath()) return
    const strip = tabStrip
    if (!strip) return
    const active = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!active) return
    const stripRect = strip.getBoundingClientRect()
    const tabRect = active.getBoundingClientRect()
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth'
    // When the active tab is the newest one at the strip's end, scroll fully
    // to the end instead of an exact offset: the tab can still grow after
    // this measurement (e.g. the unsaved-changes dot renders later), which
    // would leave its edge clipped just past the visible area.
    const activeIsLast = active === strip.lastElementChild
    if (tabRect.left < stripRect.left) {
      strip.scrollTo({ left: strip.scrollLeft + (tabRect.left - stripRect.left), behavior })
    } else if (tabRect.right > stripRect.right) {
      const left = activeIsLast
        ? strip.scrollWidth
        : strip.scrollLeft + (tabRect.right - stripRect.right)
      strip.scrollTo({ left, behavior })
    }
  })

  async function handleSaveCurrent() {
    const path = selection.selectedPath()
    if (!path) return
    await requestSaveFile(props.kernel, props.scope, path)
  }

  async function handleRevertCurrent() {
    const path = selection.selectedPath()
    if (!path) return
    await requestRevertFile(props.kernel, props.scope, path)
  }

  async function copyTabPath(relPath: string, relative: boolean) {
    const text = relative ? relPath : joinNativePath(props.scope.rootPath, relPath)
    await copyTextToClipboard(text)
  }

  function handleNewUntitled() {
    if (!buffers) return
    const buf = buffers.createUntitled()
    selection.openUntitledTab(buf.relPath, untitledDisplayNameOf(buf.relPath))
  }

  async function handleSaveUntitledAs() {
    const target = selection.pendingSaveAs()
    if (!target || savingUntitled()) return

    setSavingUntitled(true)
    setSaveAsError(null)
    const result = await saveUntitledAs(props.kernel, props.scope, target, saveAsName())
    setSavingUntitled(false)
    if (result.ok) {
      selection.cancelSaveAs()
    } else if (result.error) {
      setSaveAsError(result.error)
    }
  }

  return (
    <div class="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col rounded-xl bg-[var(--bg-editor)] panel-card relative">
      {/* Multi-file Editor Tab Bar (integrated document tabs) */}
      <Show when={selection.openTabs().length > 0}>
        <div class="h-[38px] shrink-0 flex items-end bg-[var(--bg-editor-chrome)] border-b border-[var(--border-subtle)] select-none">
          <div
            ref={(el) => (tabStrip = el)}
            role="tablist"
            aria-label="Editor tabs"
            class="flex-1 min-w-0 h-full px-2 pt-1.5 flex items-end gap-1 overflow-x-auto no-scrollbar"
          >
            <For each={selection.openTabs()}>
            {(tab) => {
              const isActive = () => selection.selectedPath() === tab.relPath
              const isDirty = () => buffers?.isDirty(tab.relPath) ?? false
              const disambiguate = () =>
                duplicateTabNames().has(tab.name) ? parentFolderLabel(tab.relPath) : ''
              return (
                <div
                  role="tab"
                  aria-selected={isActive()}
                  title={tab.relPath}
                  class={`group relative flex items-center gap-1.5 min-w-[96px] max-w-[220px] text-xs transition-colors duration-150 shrink-0 ${
                    isActive()
                      ? 'h-[32px] rounded-t-lg px-3 bg-[var(--bg-editor)] text-[var(--text-primary)] border-t border-x border-[var(--border-subtle)] -mb-px z-10 shadow-[var(--shadow-tab-doc)]'
                      : 'h-[29px] mb-[2px] rounded-lg px-2.5 bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                  onClick={() => void selection.selectFile(tab.relPath)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      void requestCloseTab(props.kernel, props.scope, tab.relPath)
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const maxX = typeof window !== 'undefined' ? window.innerWidth - 170 : e.clientX
                    const maxY = typeof window !== 'undefined' ? window.innerHeight - 250 : e.clientY
                    setTabMenu({
                      relPath: tab.relPath,
                      x: Math.max(8, Math.min(e.clientX, maxX)),
                      y: Math.max(8, Math.min(e.clientY, maxY)),
                    })
                  }}
                >
                  <FileIcon name={tab.name} isDir={false} />

                  <span
                    class={`truncate leading-normal ${
                      isDirty() || isActive() ? 'text-[var(--text-primary)] font-medium' : ''
                    }`}
                  >
                    {tab.name}
                  </span>

                  <Show when={disambiguate()}>
                    {(parent) => (
                      <span class="truncate text-[10px] text-[var(--text-muted)] leading-normal max-w-[80px]">
                        {parent()}
                      </span>
                    )}
                  </Show>

                  <div class="w-4 h-4 ml-auto flex items-center justify-center shrink-0">
                    <Show when={isDirty()}>
                      <span
                        title="Unsaved changes"
                        class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_8px_var(--accent)] group-hover:hidden"
                      />
                    </Show>
                    <button
                      type="button"
                      title="Close Tab (Ctrl+W)"
                      class={`p-0.5 rounded-md hover:bg-[var(--bg-hover-strong)] transition-all duration-150 ${
                        isDirty()
                          ? 'hidden group-hover:flex items-center justify-center'
                          : isActive()
                            ? 'opacity-65 hover:opacity-100'
                            : 'opacity-0 group-hover:opacity-80 hover:opacity-100'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void requestCloseTab(props.kernel, props.scope, tab.relPath)
                      }}
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )
            }}
            </For>
          </div>

          {/* New-file "+" button, kept outside the scrollable tab strip */}
          <div class="shrink-0 h-full flex items-center pb-0.5 pr-1.5">
            <button
              type="button"
              title="New Untitled File"
              class="p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150"
              onClick={() => handleNewUntitled()}
            >
              <Plus class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </Show>

      {/* Save-as popover for untitled buffers */}
      <Show when={selection.pendingSaveAs()}>
        {(target) => (
          <div
            class="absolute right-2 top-[42px] z-30 w-64 p-2 rounded-xl glass-surface animate-popover-in text-xs text-[var(--text-primary)]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void handleSaveUntitledAs()
              }}
            >
              <div class="px-0.5 pb-1.5 text-[10.5px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Save {untitledDisplayNameOf(target())}
              </div>
              <input
                ref={(el) => (saveAsInput = el)}
                value={saveAsName()}
                onInput={(e) => setSaveAsName(e.currentTarget.value)}
                placeholder="notes.md or src/notes.md"
                spellcheck={false}
                disabled={savingUntitled()}
                class="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent-border)] transition-colors disabled:opacity-60"
              />
              <div class="mt-1.5 px-0.5 min-h-[16px] flex items-center">
                <Show
                  when={saveAsError()}
                  fallback={
                    <span class="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] min-w-0">
                      <Folder class="w-3 h-3 shrink-0" />
                      <span class="truncate">
                        {saveAsDir() ? `${saveAsDir()}/` : 'Project root'}
                        <span class="opacity-60"> · Enter to save</span>
                      </span>
                    </span>
                  }
                >
                  {(err) => (
                    <span class="text-[10.5px] text-[var(--danger-text)] truncate">{err()}</span>
                  )}
                </Show>
              </div>
            </form>
          </div>
        )}
      </Show>

      {/* File breadcrumb, save controls & previewer mode switcher */}
      <Show when={selection.selectedPath()}>
        {(relPath) => (
          <div class="h-[34px] shrink-0 px-3.5 flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-transparent">
            <div class="flex items-center gap-2 min-w-0 text-xs">
              <nav aria-label="File path" class="flex items-center gap-1 min-w-0">
                <For each={pathSegments()}>
                  {(seg, idx) => {
                    const isLast = () => idx() === pathSegments().length - 1
                    return (
                      <>
                        <Show when={idx() > 0}>
                          <ChevronRight class="w-3 h-3 shrink-0 text-[var(--text-muted)]/60" />
                        </Show>
                        <span
                          title={relPath()}
                          class={`truncate leading-normal ${
                            isLast()
                              ? 'text-[var(--text-primary)] font-medium'
                              : 'text-[var(--text-muted)]'
                          }`}
                        >
                          {seg}
                        </span>
                      </>
                    )
                  }}
                </For>
              </nav>

              <Show when={selection.fileMeta()}>
                {(meta) => (
                  <span class="shrink-0 text-[11px] text-[var(--text-muted)] tabular-nums flex items-center gap-1.5">
                    <span class="opacity-45">·</span>
                    <span>{formatBytes(meta().size)}</span>
                  </span>
                )}
              </Show>

              <Show when={currentBuffer()}>
                {(buf) => (
                  <>
                    <Show when={buf().saving}>
                      <span class="shrink-0 px-2 py-0.5 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent)] text-[10.5px] font-medium">
                        Saving...
                      </span>
                    </Show>
                    <Show when={!buf().saving && buf().conflict === 'deleted'}>
                      <span class="shrink-0 px-2 py-0.5 rounded-full bg-[var(--danger-bg)] text-[var(--danger-text)] border border-[var(--danger-border)] text-[10.5px] font-medium">
                        Deleted on disk
                      </span>
                    </Show>
                    <Show when={!buf().saving && buf().conflict === 'modified'}>
                      <span class="shrink-0 px-2 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)] text-[10.5px] font-medium">
                        External change
                      </span>
                    </Show>
                    <Show when={!buf().saving && buf().conflict === 'none' && buf().dirty}>
                      <span class="shrink-0 px-2 py-0.5 rounded-full bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent)] text-[10.5px] font-medium">
                        Unsaved
                      </span>
                    </Show>
                    <Show when={buf().readOnly}>
                      <span
                        title={buf().readOnlyReason ?? 'Read-only file'}
                        class="shrink-0 px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--text-muted)] text-[10.5px] flex items-center gap-1"
                      >
                        <Lock class="w-2.5 h-2.5" />
                        <span>Read-Only</span>
                      </span>
                    </Show>
                  </>
                )}
              </Show>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <Show when={currentBuffer()}>
                {(buf) => (
                  <div class="flex items-center gap-1.5">
                    <Show when={buf().dirty && !buf().untitled}>
                      <button
                        type="button"
                        title="Revert unsaved changes"
                        class="px-2 py-1 rounded-md text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-1 transition-all duration-150"
                        onClick={() => void handleRevertCurrent()}
                      >
                        <RotateCcw class="w-3 h-3" />
                        <span>Revert</span>
                      </button>

                      <button
                        type="button"
                        disabled={buf().readOnly || buf().saving}
                        title="Save file (Ctrl+S)"
                        class="px-2.5 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-foreground)] shadow-[0_2px_10px_var(--accent-glow)] active:scale-[0.98] disabled:opacity-50 flex items-center gap-1 transition-all duration-150"
                        onClick={() => void handleSaveCurrent()}
                      >
                        <Show when={buf().saving} fallback={<Save class="w-3 h-3" />}>
                          <Loader2 class="w-3 h-3 animate-spin" />
                        </Show>
                        <span>Save</span>
                      </button>
                    </Show>

                    <Show
                      when={
                        !buf().dirty &&
                        !buf().readOnly &&
                        activeProvider()?.id === 'preview-code'
                      }
                    >
                      <span class="px-2 py-0.5 rounded-full text-[11px] text-[var(--text-muted)] flex items-center gap-1 select-none">
                        <Check class="w-3 h-3 text-[var(--success-text)]" />
                        <span>Saved</span>
                      </span>
                    </Show>
                  </div>
                )}
              </Show>

              <Show when={matchedProviders().length > 1}>
                <div class="flex items-center gap-0.5 shrink-0 bg-[var(--bg-inset)] p-0.5 rounded-lg border border-[var(--border-subtle)]">
                  <For each={matchedProviders()}>
                    {(provider) => {
                      const isCurrent = () => activeProvider()?.id === provider.id
                      return (
                        <button
                          type="button"
                          class={`px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-all duration-150 ${
                            isCurrent()
                              ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-panel)] shadow-sm'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
                          }`}
                          onClick={() => selection.setPreferredPreviewerId(provider.id)}
                        >
                          {provider.label}
                        </button>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>

      {/* Main preview / editor area */}
      <div class="flex-1 min-h-0 relative flex flex-col">
        <Show
          when={selection.selectedPath()}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-4 text-[var(--text-muted)] select-none px-6 text-center animate-fade-up">
              <div class="w-12 h-12 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-panel)] flex items-center justify-center">
                <FileCode2 class="w-5 h-5 text-[var(--accent)] opacity-85" />
              </div>
              <div class="space-y-1.5 max-w-sm">
                <p class="text-[13px] font-medium text-[var(--text-primary)]">
                  No file selected
                </p>
                <p class="text-xs text-[var(--text-secondary)]">
                  Choose a file from the explorer to start editing or previewing
                </p>
              </div>
              <div class="px-3 py-1 rounded-full bg-[var(--bg-inset)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-muted)] max-w-md truncate">
                {props.scope.rootPath}
              </div>
              <div class="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-1 text-[11px] text-[var(--text-muted)]">
                <span class="flex items-center gap-1.5">
                  <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-secondary)]">
                    Ctrl+B
                  </kbd>
                  <span>Sidebar</span>
                </span>
                <span class="flex items-center gap-1.5">
                  <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-secondary)]">
                    Ctrl+O
                  </kbd>
                  <span>Open Project</span>
                </span>
                <span class="flex items-center gap-1.5">
                  <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-secondary)]">
                    Ctrl+Tab
                  </kbd>
                  <span>Switch Project</span>
                </span>
              </div>
            </div>
          }
        >
          <Show when={selection.error()}>
            {(errMsg) => (
              <div class="m-4 p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs flex items-center gap-2">
                <AlertTriangle class="w-4 h-4 shrink-0 text-[var(--danger-icon)]" />
                <span>{errMsg()}</span>
              </div>
            )}
          </Show>

          <Show when={loadError()}>
            {(errMsg) => (
              <div class="m-4 p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs flex items-center gap-2">
                <AlertTriangle class="w-4 h-4 shrink-0 text-[var(--danger-icon)]" />
                <span>Failed to load view: {errMsg()}</span>
              </div>
            )}
          </Show>

          <Show when={selection.loading() && !selection.fileMeta()}>
            <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
              <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
              <span>Inspecting file...</span>
            </div>
          </Show>

          <Show when={selection.fileMeta()}>
            {(meta) => (
              <Show
                when={matchedLoadedView()}
                fallback={
                  <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
                    <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
                    <span>Loading editor...</span>
                  </div>
                }
              >
                {(view) => (
                  <ErrorBoundary
                    fallback={(err) => (
                      <div class="m-4 p-4 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs">
                        Editor view crashed: {err instanceof Error ? err.message : String(err)}
                      </div>
                    )}
                  >
                    <div class="flex-1 min-h-0 flex flex-col">
                      <Dynamic
                        component={view().component}
                        scope={props.scope}
                        file={meta()}
                      />
                    </div>
                  </ErrorBoundary>
                )}
              </Show>
            )}
          </Show>
        </Show>
      </div>

      {/* Tab Context Menu */}
      <Show when={tabMenu()}>
        {(menu) => (
          <div
            role="menu"
            class="fixed z-40 min-w-[160px] p-1.5 rounded-xl glass-surface animate-popover-in text-xs text-[var(--text-primary)]"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => {
                const target = menu().relPath
                setTabMenu(null)
                void requestCloseTab(props.kernel, props.scope, target)
              }}
            >
              Close
            </button>
            <button
              type="button"
              disabled={selection.openTabs().length <= 1}
              class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
              onClick={() => {
                const target = menu().relPath
                setTabMenu(null)
                void requestCloseOtherTabs(props.kernel, props.scope, target)
              }}
            >
              Close Others
            </button>
            <button
              type="button"
              class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => {
                setTabMenu(null)
                void requestCloseAllTabs(props.kernel, props.scope)
              }}
            >
              Close All
            </button>
            <div class="my-1 border-t border-[var(--border-subtle)]" />
            <button
              type="button"
              class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => {
                const target = menu().relPath
                setTabMenu(null)
                void copyTabPath(target, false)
              }}
            >
              Copy Path
            </button>
            <button
              type="button"
              class="w-full px-2.5 py-1.5 rounded-lg text-left hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => {
                const target = menu().relPath
                setTabMenu(null)
                void copyTabPath(target, true)
              }}
            >
              Copy Relative Path
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
