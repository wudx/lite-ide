import type { Plugin } from '@lite-ide/kernel'
// Bundle-format build: the preview component is statically imported so the
// CJS dist stays a single file (no rollup dynamic-import chunks).
import FallbackPreview from './FallbackPreview'
import './plugin.css'

export const previewFallbackPlugin: Plugin = {
  id: 'builtin.preview-fallback',
  name: 'Binary & Metadata Fallback Previewer',
  activate(ctx) {
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: {
        'previewFallback.label': '信息',
        'previewFallback.unknown': '未知',
        'previewFallback.binaryNotice': '二进制文件无法在文本预览器中显示',
        'previewFallback.metadataInspection': '文件元信息检查',
        'previewFallback.path': '路径',
        'previewFallback.size': '大小',
        'previewFallback.sizeBytes': '{formatted}（{raw} 字节）',
        'previewFallback.mimeType': 'MIME 类型',
        'previewFallback.encoding': '编码',
        'previewFallback.modified': '修改时间',
      },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: {
        'previewFallback.label': 'Info',
        'previewFallback.unknown': 'Unknown',
        'previewFallback.binaryNotice': 'Binary file cannot be displayed in the text previewer',
        'previewFallback.metadataInspection': 'File metadata inspection',
        'previewFallback.path': 'Path',
        'previewFallback.size': 'Size',
        'previewFallback.sizeBytes': '{formatted} ({raw} bytes)',
        'previewFallback.mimeType': 'MIME Type',
        'previewFallback.encoding': 'Encoding',
        'previewFallback.modified': 'Modified',
      },
    })

    ctx.contribute('previewer.provider', {
      id: 'preview-fallback',
      label: 'Info',
      labelKey: 'previewFallback.label',
      priority: 0,
      canHandle: () => true,
      load: () => Promise.resolve({ default: FallbackPreview }),
    })
  },
}

export default previewFallbackPlugin
