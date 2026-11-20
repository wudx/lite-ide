import type { Plugin } from '@lite-ide/kernel'

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

export const previewMarkdownPlugin: Plugin = {
  id: 'builtin.preview-markdown',
  name: 'Markdown Previewer',
  activate(ctx) {
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: {
        'previewMarkdown.label': 'Markdown',
        'previewMarkdown.renderFailed': '渲染 Markdown 失败：{message}',
        'previewMarkdown.loading': '正在加载 Markdown…',
      },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: {
        'previewMarkdown.label': 'Markdown',
        'previewMarkdown.renderFailed': 'Failed to render Markdown: {message}',
        'previewMarkdown.loading': 'Loading Markdown...',
      },
    })

    ctx.contribute('previewer.provider', {
      id: 'preview-markdown',
      label: 'Markdown',
      labelKey: 'previewMarkdown.label',
      priority: 50,
      canHandle: (file) => !file.isBinary && MARKDOWN_EXTS.has(file.ext),
      load: () => import('./MarkdownPreview'),
    })
  },
}
