import type { Plugin } from '@lite-ide/kernel'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])

export const previewImagePlugin: Plugin = {
  id: 'builtin.preview-image',
  name: 'Image Previewer',
  activate(ctx) {
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: {
        'previewImage.label': '图片',
        'previewImage.loadError': '无法加载图片：{path}',
        'previewImage.zoomOut': '缩小',
        'previewImage.zoomIn': '放大',
        'previewImage.fit': '适应',
        'previewImage.fitToViewport': '适应窗口',
        'previewImage.resetPan': '重置平移',
      },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: {
        'previewImage.label': 'Image',
        'previewImage.loadError': 'Unable to load image: {path}',
        'previewImage.zoomOut': 'Zoom Out',
        'previewImage.zoomIn': 'Zoom In',
        'previewImage.fit': 'Fit',
        'previewImage.fitToViewport': 'Fit to Viewport',
        'previewImage.resetPan': 'Reset Pan',
      },
    })

    ctx.contribute('previewer.provider', {
      id: 'preview-image',
      label: 'Image',
      labelKey: 'previewImage.label',
      priority: 60,
      canHandle: (file) => IMAGE_EXTS.has(file.ext),
      load: () => import('./ImagePreview'),
    })
  },
}
