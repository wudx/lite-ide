import type { Plugin } from '@lite-ide/kernel'
import { createDefaultGitBackend } from '@lite-ide/protocol'
import { ProjectFsEventsKey } from '@lite-ide/workbench'
import GitBranch from 'lucide-solid/icons/git-branch'
import { GitView } from './GitView'
import { GitStatusBarItem } from './GitStatusBarItem'
import { createGitStore, GitBackendKey, GitStoreKey } from './git-store'

export {
  createGitStore,
  GitBackendKey,
  GitStoreKey,
  hasStagedChanges,
  hasUnstagedChanges,
  isStageableEntry,
  isUnmergedEntry,
  isUntrackedEntry,
  statusLetter,
  unstagePathsForEntry,
  type GitStore,
} from './git-store'
export {
  buildGitTree,
  flattenGitTree,
  type GitTreeDirNode,
  type GitTreeRoot,
  type GitTreeRow,
} from './git-tree'
export { GitView } from './GitView'
export { GitStatusBarItem } from './GitStatusBarItem'

export const gitPlugin: Plugin = {
  id: 'builtin.git',
  name: 'Git',
  activate(ctx) {
    // One backend instance per kernel; per-project stores wrap it with scope ids.
    ctx.provide(GitBackendKey, createDefaultGitBackend())

    ctx.onProjectOpen((scope) => {
      const backend = ctx.get(GitBackendKey)
      const store = createGitStore(scope.id, backend)
      scope.provide(GitStoreKey, store)

      // Load immediately so the statusbar branch indicator works without the
      // Git sidebar view having been opened first.
      void store.refresh()

      const fsEvents = scope.tryGet(ProjectFsEventsKey)
      const fsSubscription = fsEvents?.on('delta', (delta) => {
        store.handleFsDelta(delta)
      })
      if (fsSubscription) {
        return {
          dispose() {
            fsSubscription.dispose()
            store.dispose()
          },
        }
      }
      return {
        dispose() {
          store.dispose()
        },
      }
    })

    ctx.contribute('sidebar.view', {
      id: 'git',
      title: 'Git',
      order: 20,
      icon: GitBranch,
      component: GitView,
    })

    ctx.contribute('statusbar.item', {
      id: 'git.branch',
      align: 'right',
      order: 10,
      component: GitStatusBarItem,
    })
  },
}
