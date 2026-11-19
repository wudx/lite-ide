import type { Plugin } from '@lite-ide/kernel'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])

export const previewImagePlugin: Plugin = {
  id: 'builtin.preview-image',
  name: 'Image Previewer',
  activate(ctx) {
    ctx.contribute('previewer.provider', {
      id: 'preview-image',
      label: 'Image',
      priority: 60,
      canHandle: (file) => IMAGE_EXTS.has(file.ext),
      load: () => import('./ImagePreview'),
    })
  },
}
