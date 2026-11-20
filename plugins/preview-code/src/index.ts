import { DisposableStore, type Plugin } from '@lite-ide/kernel'
import { EditorBufferKey } from '@lite-ide/workbench'
import { CodeStatusBarItem } from './CodeStatusBarItem'
import { CodeEditorCacheKey, createCodeEditorCacheService } from './editor-cache'
import { PREVIEW_CODE_EN_US, PREVIEW_CODE_ZH_CN } from './i18n'
import { CodeStatsKey, createCodeStatsService } from './stats'

export const previewCodePlugin: Plugin = {
  id: 'builtin.preview-code',
  name: 'Code & Text Editor',
  activate(ctx) {
    ctx.contribute('i18n', { locale: 'zh-CN', messages: PREVIEW_CODE_ZH_CN })
    ctx.contribute('i18n', { locale: 'en-US', messages: PREVIEW_CODE_EN_US })

    ctx.onProjectOpen((scope) => {
      const store = new DisposableStore()
      const editorCache = createCodeEditorCacheService()
      scope.provide(CodeStatsKey, createCodeStatsService())
      scope.provide(CodeEditorCacheKey, editorCache)

      const buffers = scope.tryGet(EditorBufferKey)
      if (buffers) {
        store.add(
          buffers.events.on('discarded', ({ relPath }) => {
            editorCache.delete(relPath)
          }),
        )
        store.add(
          buffers.events.on('renamed', ({ oldRelPath, newRelPath, isDir }) => {
            editorCache.renamePaths(oldRelPath, newRelPath, isDir)
          }),
        )
        store.add(
          buffers.events.on('removed', ({ relPath, isDir }) => {
            editorCache.removePaths(relPath, isDir)
          }),
        )
      }

      store.add({
        dispose() {
          editorCache.clear()
        },
      })

      return store
    })

    ctx.contribute('previewer.provider', {
      id: 'preview-code',
      label: 'Code',
      labelKey: 'previewCode.label',
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
