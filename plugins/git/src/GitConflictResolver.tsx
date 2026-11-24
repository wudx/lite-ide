import type { ProjectScope } from '@lite-ide/kernel'
import { formatErrorMessage } from '@lite-ide/protocol'
import { getI18n, ProjectSelectionKey, WorkspaceBackendKey } from '@lite-ide/workbench'
import Check from 'lucide-solid/icons/check'
import Code from 'lucide-solid/icons/code'
import Loader2 from 'lucide-solid/icons/loader-circle'
import { createEffect, createMemo, createSignal, For, Show, type Component } from 'solid-js'
import {
  parseConflictFile,
  serializeResolvedDocument,
  type ConflictDocument,
  type ConflictHunk,
  type ConflictResolutionChoice,
} from './conflict-parse'
import { GitStoreKey } from './git-store'

export interface GitConflictResolverProps {
  scope: ProjectScope
  relPath: string
  isBinary?: boolean
}

const MAX_CONTEXT_PREVIEW_LINES = 3

export const GitConflictResolver: Component<GitConflictResolverProps> = (props) => {
  const store = props.scope.tryGet(GitStoreKey)
  const fs = props.scope.tryGet(WorkspaceBackendKey)
  const selection = props.scope.tryGet(ProjectSelectionKey)
  const i18n = getI18n(props.scope)

  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [content, setContent] = createSignal<string>('')
  const [encoding, setEncoding] = createSignal<string | undefined>(undefined)

  async function loadFile() {
    if (!fs || props.isBinary) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const payload = await fs.readText(props.scope.id, props.relPath)
      setContent(payload.content)
      setEncoding(payload.encoding)
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void props.relPath
    void props.isBinary
    void loadFile()
  })

  const doc = createMemo<ConflictDocument>(() => parseConflictFile(content()))

  async function writeContent(nextContent: string) {
    if (!fs) return
    setSaving(true)
    setError(null)
    try {
      await fs.writeText(props.scope.id, props.relPath, nextContent, encoding())
      setContent(nextContent)
    } catch (err) {
      setError(formatErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function resolveSingleHunk(hunk: ConflictHunk, choice: ConflictResolutionChoice) {
    const map = new Map<number, ConflictResolutionChoice>([[hunk.index, choice]])
    const next = serializeResolvedDocument(doc(), map)
    await writeContent(next)
  }

  async function resolveAllHunks(choice: ConflictResolutionChoice) {
    const currentDoc = doc()
    if (currentDoc.conflictCount === 0) return
    const map = new Map<number, ConflictResolutionChoice>()
    for (let i = 0; i < currentDoc.conflictCount; i += 1) {
      map.set(i, choice)
    }
    const next = serializeResolvedDocument(currentDoc, map)
    await writeContent(next)
  }

  async function markResolved() {
    if (!store) return
    await store.stage([props.relPath])
  }

  async function resolveSideWithGit(side: 'ours' | 'theirs') {
    if (!store) return
    await store.resolveConflict(props.relPath, side)
  }

  function openInCodeEditor() {
    void selection?.selectFile(props.relPath, { preferredPreviewerId: null })
  }

  const busy = () => saving() || (store?.mutating() ?? false)

  return (
    <div
      data-testid="git-conflict-resolver"
      class="flex-1 min-h-0 flex flex-col overflow-hidden bg-[var(--bg-canvas)]"
    >
      {/* Action bar */}
      <div class="shrink-0 flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <Show
          when={!props.isBinary && doc().conflictCount > 0}
          fallback={
            <span class="text-[11px] font-medium text-[var(--diff-add-text)] mr-auto">
              {props.isBinary
                ? i18n.t('git.diff.binary')
                : i18n.t('git.conflict.resolvedReady')}
            </span>
          }
        >
          <span class="text-[11px] font-medium text-[var(--text-primary)] mr-auto">
            {i18n.t('git.conflict.count', { count: doc().conflictCount })}
          </span>
          <button
            type="button"
            disabled={busy()}
            data-testid="git-conflict-all-ours"
            class="px-2 py-1 rounded-md text-[11px] border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-40 transition-colors"
            onClick={() => void resolveAllHunks('ours')}
          >
            {i18n.t('git.conflict.acceptAllCurrent')}
          </button>
          <button
            type="button"
            disabled={busy()}
            data-testid="git-conflict-all-theirs"
            class="px-2 py-1 rounded-md text-[11px] border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-40 transition-colors"
            onClick={() => void resolveAllHunks('theirs')}
          >
            {i18n.t('git.conflict.acceptAllIncoming')}
          </button>
        </Show>

        <Show when={selection && !props.isBinary}>
          <button
            type="button"
            data-testid="git-conflict-open-editor"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-[var(--border-subtle)] bg-[var(--bg-inset)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            onClick={openInCodeEditor}
          >
            <Code class="w-3 h-3" />
            <span>{i18n.t('git.conflict.openEditor')}</span>
          </button>
        </Show>

        <Show when={store && doc().conflictCount === 0 && !props.isBinary}>
          <button
            type="button"
            disabled={busy()}
            data-testid="git-conflict-mark-resolved"
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-[var(--accent)] text-[var(--accent-contrast,#fff)] hover:opacity-90 disabled:opacity-40 transition-opacity"
            onClick={() => void markResolved()}
          >
            <Check class="w-3 h-3" />
            <span>{i18n.t('git.conflict.markResolved')}</span>
          </button>
        </Show>
      </div>

      <Show when={error()}>
        {(msg) => (
          <div class="mx-3 mt-2 px-2.5 py-1.5 rounded-lg text-[11px] text-[var(--danger-text)] bg-[var(--danger-bg)] border border-[var(--danger-border)] break-words">
            {msg()}
          </div>
        )}
      </Show>

      <Show
        when={!loading()}
        fallback={
          <div class="flex-1 flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)]">
            <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
            <span>{i18n.t('git.diff.loading')}</span>
          </div>
        }
      >
        <Show
          when={!props.isBinary && doc().conflictCount > 0}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <p class="max-w-md text-xs text-[var(--text-secondary)] leading-relaxed">
                {i18n.t('git.conflict.noMarkersHint')}
              </p>
              <div class="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  disabled={busy()}
                  data-testid="git-conflict-side-ours"
                  class="px-3 py-1.5 rounded-lg text-xs border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-40 transition-colors"
                  onClick={() => void resolveSideWithGit('ours')}
                >
                  {i18n.t('git.conflict.acceptCurrent')}
                </button>
                <button
                  type="button"
                  disabled={busy()}
                  data-testid="git-conflict-side-theirs"
                  class="px-3 py-1.5 rounded-lg text-xs border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[var(--text-primary)] disabled:opacity-40 transition-colors"
                  onClick={() => void resolveSideWithGit('theirs')}
                >
                  {i18n.t('git.conflict.acceptIncoming')}
                </button>
                <button
                  type="button"
                  disabled={busy()}
                  data-testid="git-conflict-stage-direct"
                  class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-[var(--accent-contrast,#fff)] hover:opacity-90 disabled:opacity-40 transition-opacity"
                  onClick={() => void markResolved()}
                >
                  <Check class="w-3.5 h-3.5" />
                  <span>{i18n.t('git.conflict.markResolved')}</span>
                </button>
              </div>
            </div>
          }
        >
          <div class="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 font-mono text-[12px] leading-[1.5]">
            <For each={doc().segments}>
              {(segment) => {
                if (segment.kind === 'context') {
                  const total = segment.lines.length
                  const isCollapsed = total > MAX_CONTEXT_PREVIEW_LINES * 2
                  const previewLines = isCollapsed
                    ? [
                        ...segment.lines.slice(0, MAX_CONTEXT_PREVIEW_LINES),
                        `··· (${total - MAX_CONTEXT_PREVIEW_LINES * 2} lines) ···`,
                        ...segment.lines.slice(-MAX_CONTEXT_PREVIEW_LINES),
                      ]
                    : segment.lines
                  if (previewLines.every((l) => l.trim() === '')) return null
                  return (
                    <pre class="px-2 py-0.5 text-[11px] text-[var(--text-muted)] overflow-x-auto whitespace-pre select-text">
                      {previewLines.join('\n')}
                    </pre>
                  )
                }

                return (
                  <div
                    data-git-conflict-hunk={segment.index}
                    class="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-surface)] overflow-hidden shadow-xs"
                  >
                    {/* Hunk header */}
                    <div class="flex flex-wrap items-center gap-1.5 px-3 py-1.5 bg-[var(--bg-inset)] border-b border-[var(--border-subtle)] font-sans text-[11px]">
                      <span class="font-medium text-[var(--text-primary)] mr-auto">
                        {i18n.t('git.conflict.hunkTitle', { index: segment.index + 1 })}
                        <span class="ml-1.5 font-normal text-[10px] text-[var(--text-muted)]">
                          L{segment.startLine}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={busy()}
                        data-git-conflict-accept="ours"
                        class="px-2 py-0.5 rounded bg-[var(--diff-add-bg)] text-[var(--diff-add-text)] hover:opacity-85 disabled:opacity-40 transition-opacity"
                        onClick={() => void resolveSingleHunk(segment, 'ours')}
                      >
                        {i18n.t('git.conflict.acceptCurrent')}
                      </button>
                      <button
                        type="button"
                        disabled={busy()}
                        data-git-conflict-accept="theirs"
                        class="px-2 py-0.5 rounded bg-[var(--accent-subtle,var(--bg-hover))] text-[var(--accent)] hover:opacity-85 disabled:opacity-40 transition-opacity"
                        onClick={() => void resolveSingleHunk(segment, 'theirs')}
                      >
                        {i18n.t('git.conflict.acceptIncoming')}
                      </button>
                      <button
                        type="button"
                        disabled={busy()}
                        data-git-conflict-accept="both"
                        class="px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-primary)] hover:opacity-85 disabled:opacity-40 transition-opacity"
                        onClick={() => void resolveSingleHunk(segment, 'both')}
                      >
                        {i18n.t('git.conflict.acceptBoth')}
                      </button>
                    </div>

                    {/* Current (Ours) */}
                    <div class="border-b border-[var(--border-subtle)]">
                      <div class="px-3 py-0.5 font-sans text-[10px] font-medium bg-[var(--diff-add-bg)] text-[var(--diff-add-text)]">
                        {i18n.t('git.conflict.currentLabel')} ({segment.oursLabel})
                      </div>
                      <pre class="px-3 py-1.5 bg-[var(--diff-add-bg)]/40 text-[var(--text-primary)] overflow-x-auto whitespace-pre">
                        {segment.oursLines.join('\n') || ' '}
                      </pre>
                    </div>

                    {/* Common ancestor (diff3, optional) */}
                    <Show when={segment.baseLines}>
                      {(base) => (
                        <div class="border-b border-[var(--border-subtle)]">
                          <div class="px-3 py-0.5 font-sans text-[10px] font-medium bg-[var(--bg-inset)] text-[var(--text-muted)]">
                            {i18n.t('git.conflict.baseLabel')}
                          </div>
                          <pre class="px-3 py-1.5 bg-[var(--bg-inset)]/60 text-[var(--text-secondary)] overflow-x-auto whitespace-pre">
                            {base().join('\n') || ' '}
                          </pre>
                        </div>
                      )}
                    </Show>

                    {/* Incoming (Theirs) */}
                    <div>
                      <div class="px-3 py-0.5 font-sans text-[10px] font-medium bg-[var(--bg-hover)] text-[var(--accent)]">
                        {i18n.t('git.conflict.incomingLabel')} ({segment.theirsLabel || 'incoming'})
                      </div>
                      <pre class="px-3 py-1.5 bg-[var(--bg-hover)]/40 text-[var(--text-primary)] overflow-x-auto whitespace-pre">
                        {segment.theirsLines.join('\n') || ' '}
                      </pre>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export default GitConflictResolver
