import type { AppKernel, ContributionMap, PreviewProps, ProjectScope } from '@lite-ide/kernel'
import Check from 'lucide-solid/icons/check'
import FileCode2 from 'lucide-solid/icons/file-code-corner'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Lock from 'lucide-solid/icons/lock'
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
} from '../close-guards'
import { EditorBufferKey } from '../editor-buffers'
import { formatBytes } from '../format'
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

  return (
    <div class="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col bg-[var(--bg-editor)] relative">
      {/* Multi-file Editor Tab Bar */}
      <Show when={selection.openTabs().length > 0}>
        <div
          role="tablist"
          class="h-[34px] shrink-0 flex items-stretch bg-[var(--bg-titlebar)] border-b border-[var(--border-subtle)] overflow-x-auto no-scrollbar select-none"
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
                  class={`group relative flex items-center gap-1.5 px-2.5 min-w-[96px] max-w-[220px] border-r border-[var(--border-subtle)] cursor-pointer text-xs transition-colors shrink-0 ${
                    isActive()
                      ? 'bg-[var(--bg-editor)] text-[var(--text-primary)]'
                      : 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
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
                    const maxY = typeof window !== 'undefined' ? window.innerHeight - 120 : e.clientY
                    setTabMenu({
                      relPath: tab.relPath,
                      x: Math.max(8, Math.min(e.clientX, maxX)),
                      y: Math.max(8, Math.min(e.clientY, maxY)),
                    })
                  }}
                >
                  <Show when={isActive()}>
                    <span class="absolute top-0 left-0 right-0 h-[2px] bg-[var(--accent)]" />
                  </Show>

                  <FileIcon name={tab.name} isDir={false} />

                  <span
                    class={`truncate leading-normal ${
                      isDirty() ? 'text-[var(--text-primary)] font-medium' : ''
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
                        class="w-2 h-2 rounded-full bg-[var(--accent)] group-hover:hidden"
                      />
                    </Show>
                    <button
                      type="button"
                      title="Close Tab (Ctrl+W)"
                      class={`p-0.5 rounded hover:bg-[var(--bg-active)] transition-opacity ${
                        isDirty()
                          ? 'hidden group-hover:flex items-center justify-center'
                          : isActive()
                            ? 'opacity-75 hover:opacity-100'
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
      </Show>

      {/* File breadcrumb, save controls & previewer mode switcher */}
      <Show when={selection.selectedPath()}>
        {(relPath) => (
          <div class="h-[32px] shrink-0 px-3 flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/50">
            <div class="flex items-center gap-2 min-w-0 text-xs">
              <span class="truncate font-mono text-[var(--text-primary)] leading-normal">
                {relPath()}
              </span>
              <Show when={selection.fileMeta()}>
                {(meta) => (
                  <span class="shrink-0 text-[11px] text-[var(--text-muted)]">
                    {formatBytes(meta().size)}
                  </span>
                )}
              </Show>

              <Show when={currentBuffer()}>
                {(buf) => (
                  <>
                    <Show when={buf().saving}>
                      <span class="shrink-0 px-1.5 py-0.5 rounded bg-[var(--bg-active)] text-[var(--accent)] text-[10px] font-medium">
                        Saving...
                      </span>
                    </Show>
                    <Show when={!buf().saving && buf().conflict === 'deleted'}>
                      <span class="shrink-0 px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 text-[10px] font-medium">
                        Deleted on disk
                      </span>
                    </Show>
                    <Show when={!buf().saving && buf().conflict === 'modified'}>
                      <span class="shrink-0 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-medium">
                        External change
                      </span>
                    </Show>
                    <Show when={!buf().saving && buf().conflict === 'none' && buf().dirty}>
                      <span class="shrink-0 px-1.5 py-0.5 rounded bg-[var(--bg-active)] text-[var(--accent)] text-[10px] font-medium">
                        Unsaved
                      </span>
                    </Show>
                    <Show when={buf().readOnly}>
                      <span
                        title={buf().readOnlyReason ?? 'Read-only file'}
                        class="shrink-0 px-1.5 py-0.5 rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-muted)] text-[10px] flex items-center gap-1"
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
                  <div class="flex items-center gap-1">
                    <Show when={buf().dirty}>
                      <button
                        type="button"
                        title="Revert unsaved changes"
                        class="px-2 py-0.5 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-1 transition-colors"
                        onClick={() => void handleRevertCurrent()}
                      >
                        <RotateCcw class="w-3 h-3" />
                        <span>Revert</span>
                      </button>

                      <button
                        type="button"
                        disabled={buf().readOnly || buf().saving}
                        title="Save file (Ctrl+S)"
                        class="px-2 py-0.5 rounded text-[11px] font-medium bg-[var(--accent)] text-slate-950 hover:brightness-110 disabled:opacity-50 flex items-center gap-1 transition-colors"
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
                      <span class="px-2 py-0.5 rounded text-[11px] text-[var(--text-muted)] flex items-center gap-1 select-none">
                        <Check class="w-3 h-3 text-emerald-400/80" />
                        <span>Saved</span>
                      </span>
                    </Show>
                  </div>
                )}
              </Show>

              <Show when={matchedProviders().length > 1}>
                <div class="flex items-center gap-1 shrink-0 bg-[var(--bg-app)] p-0.5 rounded border border-[var(--border-subtle)]">
                  <For each={matchedProviders()}>
                    {(provider) => {
                      const isCurrent = () => activeProvider()?.id === provider.id
                      return (
                        <button
                          type="button"
                          class={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                            isCurrent()
                              ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
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
            <div class="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)] select-none px-6 text-center">
              <FileCode2 class="w-10 h-10 opacity-30" />
              <p class="text-sm text-[var(--text-secondary)]">Select a file from the explorer to edit or preview</p>
              <p class="text-xs opacity-70">{props.scope.rootPath}</p>
            </div>
          }
        >
          <Show when={selection.error()}>
            {(errMsg) => (
              <div class="m-4 p-3 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs flex items-center gap-2">
                <AlertTriangle class="w-4 h-4 shrink-0" />
                <span>{errMsg()}</span>
              </div>
            )}
          </Show>

          <Show when={loadError()}>
            {(errMsg) => (
              <div class="m-4 p-3 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs flex items-center gap-2">
                <AlertTriangle class="w-4 h-4 shrink-0" />
                <span>Failed to load view: {errMsg()}</span>
              </div>
            )}
          </Show>

          <Show when={selection.loading() && !selection.fileMeta()}>
            <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
              <Loader2 class="w-4 h-4 animate-spin" />
              <span>Inspecting file...</span>
            </div>
          </Show>

          <Show when={selection.fileMeta()}>
            {(meta) => (
              <Show
                when={matchedLoadedView()}
                fallback={
                  <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
                    <Loader2 class="w-4 h-4 animate-spin" />
                    <span>Loading editor...</span>
                  </div>
                }
              >
                {(view) => (
                  <ErrorBoundary
                    fallback={(err) => (
                      <div class="m-4 p-4 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs">
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
            class="fixed z-40 min-w-[152px] py-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-xl text-xs text-[var(--text-primary)]"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="w-full px-3 py-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors"
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
              class="w-full px-3 py-1.5 text-left hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
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
              class="w-full px-3 py-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => {
                setTabMenu(null)
                void requestCloseAllTabs(props.kernel, props.scope)
              }}
            >
              Close All
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
