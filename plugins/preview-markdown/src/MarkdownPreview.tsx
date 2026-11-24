import type { PreviewProps } from '@lite-ide/kernel'
import { getWorkspaceFileUrl } from '@lite-ide/protocol'
import {
  EditorBufferKey,
  getI18n,
  ProjectSelectionKey,
  WorkspaceBackendKey,
} from '@lite-ide/workbench'
import DOMPurify from 'dompurify'
import Loader2 from 'lucide-solid/icons/loader-circle'
import MarkdownIt from 'markdown-it'
import { createEffect, createMemo, createSignal, Show } from 'solid-js'

function isExternalOrSpecialHref(raw: string): boolean {
  return /^(https?:|mailto:|tel:|data:|blob:|workspace:|#)/i.test(raw.trim())
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
  const i18n = getI18n(props.scope)

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
      html: true,
      linkify: true,
      typographer: true,
    })

    const unsafeHtml = md.render(raw)
    const fragment = DOMPurify.sanitize(unsafeHtml, {
      RETURN_DOM_FRAGMENT: true,
      ADD_ATTR: ['target', 'rel', 'data-rel-href'],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|tel|data|blob|workspace):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    })

    for (const img of fragment.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src')
      if (src && !isExternalOrSpecialHref(src)) {
        const rel = resolveRelativePath(currentRel, src)
        img.setAttribute('src', getWorkspaceFileUrl(props.scope.id, rel, backend))
      }
    }

    for (const anchor of fragment.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href')
      if (href && !isExternalOrSpecialHref(href)) {
        const rel = resolveRelativePath(currentRel, href)
        anchor.setAttribute('data-rel-href', rel)
        anchor.setAttribute('href', `#${encodeURIComponent(rel)}`)
      } else if (href && /^https?:/i.test(href)) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer')
      }
    }

    const container = document.createElement('div')
    container.appendChild(fragment)
    return container.innerHTML
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
            {i18n.t('previewMarkdown.renderFailed', { message: msg() })}
          </div>
        )}
      </Show>

      <Show when={loading() && !markdownText()}>
        <div class="flex items-center justify-center gap-2 py-12 text-xs text-[var(--text-secondary)]">
          <Loader2 class="w-4 h-4 animate-spin text-[var(--accent)]" />
          <span>{i18n.t('previewMarkdown.loading')}</span>
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
