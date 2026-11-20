import type { PreviewProps } from '@lite-ide/kernel'
import { getWorkspaceFileUrl } from '@lite-ide/protocol'
import { EditorBufferKey, ProjectSelectionKey, WorkspaceBackendKey } from '@lite-ide/workbench'
import DOMPurify from 'dompurify'
import Loader2 from 'lucide-solid/icons/loader-circle'
import MarkdownIt from 'markdown-it'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'

function isExternalOrSpecialHref(raw: string): boolean {
  return /^(https?:|mailto:|tel:|data:|blob:|#)/i.test(raw.trim())
}

function resolveRelativePath(currentFileRel: string, targetHref: string): string {
  const cleanHref = targetHref.split('#')[0].split('?')[0].replace(/\\/g, '/')
  const baseParts = currentFileRel.replace(/\\/g, '/').split('/')
  baseParts.pop() // directory containing current markdown file

  const segments = cleanHref.startsWith('/')
    ? cleanHref.slice(1).split('/')
    : [...baseParts, ...cleanHref.split('/')]

  const resolved: string[] = []
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      resolved.pop()
    } else {
      resolved.push(seg)
    }
  }
  return resolved.join('/')
}

export default function MarkdownPreview(props: PreviewProps) {
  const backend = props.scope.get(WorkspaceBackendKey)
  const selection = props.scope.get(ProjectSelectionKey)
  const buffers = props.scope.tryGet(EditorBufferKey)

  const [diskText, setDiskText] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let readSeq = 0

  const activeBuffer = createMemo(() => buffers?.getBuffer(props.file.relPath))

  createEffect(() => {
    const buf = activeBuffer()
    if (buf) {
      setLoading(false)
      setError(null)
      return
    }

    const relPath = props.file.relPath
    const _modifiedMs = props.file.modifiedMs
    const seq = ++readSeq
    setLoading(true)
    setError(null)

    void backend
      .readText(props.scope.id, relPath)
      .then((res) => {
        if (seq !== readSeq) return
        setDiskText(res.content)
        setLoading(false)
      })
      .catch((err) => {
        if (seq !== readSeq) return
        setLoading(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  })

  const markdownText = createMemo(() => activeBuffer()?.content ?? diskText())

  const renderedHtml = createMemo(() => {
    const raw = markdownText()
    if (!raw) return ''

    const currentRel = props.file.relPath
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
    })

    const defaultImageRule =
      md.renderer.rules.image ??
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      const src = token.attrGet('src')
      if (src && !isExternalOrSpecialHref(src)) {
        const rel = resolveRelativePath(currentRel, src)
        token.attrSet('src', getWorkspaceFileUrl(props.scope.id, rel, backend))
      }
      return defaultImageRule(tokens, idx, options, env, self)
    }

    const defaultLinkOpen =
      md.renderer.rules.link_open ??
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      const href = token.attrGet('href')
      if (href && !isExternalOrSpecialHref(href)) {
        const rel = resolveRelativePath(currentRel, href)
        token.attrSet('data-rel-href', rel)
        token.attrSet('href', `#${encodeURIComponent(rel)}`)
      } else if (href && /^https?:/i.test(href)) {
        token.attrSet('target', '_blank')
        token.attrSet('rel', 'noopener noreferrer')
      }
      return defaultLinkOpen(tokens, idx, options, env, self)
    }

    const unsafeHtml = md.render(raw)
    return DOMPurify.sanitize(unsafeHtml, {
      ADD_ATTR: ['target', 'rel', 'data-rel-href'],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|tel|data|blob|workspace):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    })
  })

  function handleContainerClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest('a')
    if (!anchor) return
    const relTarget = anchor.getAttribute('data-rel-href')
    if (relTarget) {
      e.preventDefault()
      void selection.selectFile(relTarget)
    }
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-10 py-8">
      <Show when={error()}>
        {(msg) => (
          <div class="p-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)] text-xs">
            Failed to render Markdown: {msg()}
          </div>
        )}
      </Show>

      <Show when={loading() && !markdownText()}>
        <div class="flex items-center justify-center gap-2 py-12 text-xs text-[var(--text-secondary)]">
          <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
          <span>Loading Markdown...</span>
        </div>
      </Show>

      <article
        class="markdown-body max-w-[780px] mx-auto"
        innerHTML={renderedHtml()}
        onClick={handleContainerClick}
      />
    </div>
  )
}
