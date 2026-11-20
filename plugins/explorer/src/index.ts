import type { Plugin } from '@lite-ide/kernel'
import { ProjectFsEventsKey, WorkspaceBackendKey } from '@lite-ide/workbench'
import FolderTree from 'lucide-solid/icons/folder-tree'
import { ExcludeSettings } from './ExcludeSettings'
import { createExplorerExcludeService, ExplorerExcludeStateKey } from './exclude-patterns'
import { ExplorerView } from './ExplorerView'
import { createFileTreeStore, FileTreeStoreKey } from './tree-store'

// 公共面仅暴露排除状态服务（供其他插件读取/联动）；glob 实现细节留在模块内部。
export {
  createExplorerExcludeService,
  ExplorerExcludeStateKey,
  type ExplorerExcludeService,
} from './exclude-patterns'
export { createFileTreeStore, FileTreeStoreKey, type FileTreeStore, type FlatTreeNode } from './tree-store'
export { ExplorerView } from './ExplorerView'

export const explorerPlugin: Plugin = {
  id: 'builtin.explorer',
  name: 'File Explorer',
  activate(ctx) {
    const backend = ctx.get(WorkspaceBackendKey)
    // 排除规则为全局设置（跨项目共享），故提供在内核层；设置分区与文件树共享同一实例。
    const excludes = createExplorerExcludeService()
    ctx.provide(ExplorerExcludeStateKey, excludes)

    ctx.contribute('settings.section', {
      id: 'explorer.files',
      title: '资源管理器',
      order: 10,
      component: ExcludeSettings,
    })

    ctx.onProjectOpen((scope) => {
      const store = createFileTreeStore(scope.id, backend, { excludes })
      scope.provide(FileTreeStoreKey, store)

      const fsEvents = scope.tryGet(ProjectFsEventsKey)
      if (fsEvents) {
        return fsEvents.on('delta', (delta) => {
          void store.handleFsDelta(delta)
        })
      }
    })

    ctx.contribute('sidebar.view', {
      id: 'explorer',
      title: 'Explorer',
      order: 10,
      icon: FolderTree,
      component: ExplorerView,
    })
  },
}
