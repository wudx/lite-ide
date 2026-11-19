import type { Plugin } from '@lite-ide/kernel'

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])

export const previewMarkdownPlugin: Plugin = {
  id: 'builtin.preview-markdown',
  name: 'Markdown Previewer',
  activate(ctx) {
    ctx.contribute('previewer.provider', {
      id: 'preview-markdown',
      label: 'Markdown',
      priority: 50,
      canHandle: (file) => !file.isBinary && MARKDOWN_EXTS.has(file.ext),
      load: () => import('./MarkdownPreview'),
    })
  },
}
