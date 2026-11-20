import type { Plugin } from '@lite-ide/kernel'
import { createDefaultGitBackend } from '@lite-ide/protocol'
import { getI18n, ProjectFsEventsKey } from '@lite-ide/workbench'
import GitBranch from 'lucide-solid/icons/git-branch'
import { GitView } from './GitView'
import { GitStatusBarItem } from './GitStatusBarItem'
import { createGitStore, GitBackendKey, GIT_DIFF_PREVIEWER_ID, GitStoreKey } from './git-store'
import { GIT_EN_US, GIT_ZH_CN } from './i18n'

export {
  createGitStore,
  GitBackendKey,
  GitStoreKey,
  GIT_DIFF_PREVIEWER_ID,
  hasStagedChanges,
  hasUnstagedChanges,
  isStageableEntry,
  isUnmergedEntry,
  isUntrackedEntry,
  statusLetter,
  unstagePathsForEntry,
  type GitDiffFocus,
  type GitDiffSection,
  type GitStore,
} from './git-store'
export {
  buildGitTree,
  flattenGitTree,
  type GitTreeDirNode,
  type GitTreeRoot,
  type GitTreeRow,
} from './git-tree'
export {
  diffStats,
  parseUnifiedDiff,
  synthesizeAddedDiff,
  type DiffHunk,
  type DiffRow,
  type ParsedDiff,
} from './diff-parse'
export { GitView } from './GitView'
export { GitStatusBarItem } from './GitStatusBarItem'

export const gitPlugin: Plugin = {
  id: 'builtin.git',
  name: 'Git',
  activate(ctx) {
    const i18n = getI18n(ctx)
    ctx.contribute('i18n', { locale: 'zh-CN', messages: GIT_ZH_CN })
    ctx.contribute('i18n', { locale: 'en-US', messages: GIT_EN_US })

    // One backend instance per kernel; per-project stores wrap it with scope ids.
    ctx.provide(GitBackendKey, createDefaultGitBackend())

    ctx.onProjectOpen((scope) => {
      const backend = ctx.get(GitBackendKey)
      const store = createGitStore(scope.id, backend, { t: i18n.t })
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
      titleKey: 'git.view.title',
      order: 20,
      icon: GitBranch,
      component: GitView,
    })

    // Diff previewer: lowest text priority so ordinary file opens keep their
    // regular previewer; the Git panel requests it explicitly via
    // preferredPreviewerId, and the pill switcher exposes it everywhere else.
    ctx.contribute('previewer.provider', {
      id: GIT_DIFF_PREVIEWER_ID,
      label: 'Diff',
      labelKey: 'git.diff.label',
      priority: 5,
      canHandle: (file) => !file.isBinary,
      load: () => import('./GitDiffPreview'),
    })

    ctx.contribute('statusbar.item', {
      id: 'git.branch',
      align: 'right',
      order: 10,
      component: GitStatusBarItem,
    })
  },
}
