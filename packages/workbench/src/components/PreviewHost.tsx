import type { AppKernel, ContributionMap, PreviewProps, ProjectScope } from '@lite-ide/kernel'
import { FileCode2, AlertTriangle, Loader2 } from 'lucide-solid'
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Show, type Component } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { formatBytes } from '../format'
import { ProjectSelectionKey } from '../services'

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

export function PreviewHost(props: PreviewHostProps) {
  const selection = props.scope.get(ProjectSelectionKey)
  const providers = props.kernel.contributions('previewer.provider')

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
  let loadSeq = 0

  const matchedLoadedView = createMemo(() => {
    const current = activeProvider()
    const loaded = loadedView()
    return current && loaded && loaded.id === current.id ? loaded : undefined
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

  return (
    <div class="flex-1 min-w-0 flex flex-col bg-[var(--bg-editor)]">
      {/* File breadcrumb & previewer mode switcher */}
      <Show when={selection.selectedPath()}>
        {(relPath) => (
          <div class="h-[34px] shrink-0 px-3 flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/50">
            <div class="flex items-center gap-2 min-w-0 text-xs">
              <span class="truncate font-mono text-[var(--text-primary)]">{relPath()}</span>
              <Show when={selection.fileMeta()}>
                {(meta) => (
                  <span class="shrink-0 text-[11px] text-[var(--text-muted)]">
                    {formatBytes(meta().size)}
                  </span>
                )}
              </Show>
            </div>

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
        )}
      </Show>

      {/* Main preview area */}
      <div class="flex-1 min-h-0 relative flex flex-col">
        <Show
          when={selection.selectedPath()}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)] select-none px-6 text-center">
              <FileCode2 class="w-10 h-10 opacity-30" />
              <p class="text-sm text-[var(--text-secondary)]">Select a file from the explorer to preview</p>
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
                <span>Failed to load previewer: {errMsg()}</span>
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
                    <span>Loading previewer...</span>
                  </div>
                }
              >
                {(view) => (
                  <ErrorBoundary
                    fallback={(err) => (
                      <div class="m-4 p-4 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs">
                        Previewer crashed: {err instanceof Error ? err.message : String(err)}
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
    </div>
  )
}
