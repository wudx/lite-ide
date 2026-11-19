import type { Plugin } from '@lite-ide/kernel'

export const previewFallbackPlugin: Plugin = {
  id: 'builtin.preview-fallback',
  name: 'Binary & Metadata Fallback Previewer',
  activate(ctx) {
    ctx.contribute('previewer.provider', {
      id: 'preview-fallback',
      label: 'Info',
      priority: 0,
      canHandle: () => true,
      load: () => import('./FallbackPreview'),
    })
  },
}
