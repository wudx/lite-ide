import type { Plugin } from '@lite-ide/kernel'
import { CodeStatusBarItem } from './CodeStatusBarItem'
import { CodeStatsKey, createCodeStatsService } from './stats'

export const previewCodePlugin: Plugin = {
  id: 'builtin.preview-code',
  name: 'Code & Text Previewer',
  activate(ctx) {
    ctx.onProjectOpen((scope) => {
      scope.provide(CodeStatsKey, createCodeStatsService())
    })

    ctx.contribute('previewer.provider', {
      id: 'preview-code',
      label: 'Code',
      priority: 10,
      canHandle: (file) => !file.isBinary,
      load: () => import('./CodePreview'),
    })

    ctx.contribute('statusbar.item', {
      id: 'preview-code.stats',
      align: 'right',
      order: 100,
      component: CodeStatusBarItem,
    })
  },
}
