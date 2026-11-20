import type { Plugin } from '@lite-ide/kernel'
import { ProjectFsEventsKey, WorkspaceBackendKey } from '@lite-ide/workbench'
import FolderTree from 'lucide-solid/icons/folder-tree'
import { ExplorerView } from './ExplorerView'
import { createFileTreeStore, FileTreeStoreKey } from './tree-store'

export { createFileTreeStore, FileTreeStoreKey, type FileTreeStore, type FlatTreeNode } from './tree-store'
export { ExplorerView } from './ExplorerView'

export const explorerPlugin: Plugin = {
  id: 'builtin.explorer',
  name: 'File Explorer',
  activate(ctx) {
    const backend = ctx.get(WorkspaceBackendKey)

    ctx.onProjectOpen((scope) => {
      const store = createFileTreeStore(scope.id, backend)
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
