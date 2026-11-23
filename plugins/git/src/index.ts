import type { Plugin } from '@lite-ide/kernel'
import { createDefaultGitBackend } from '@lite-ide/protocol'
import { getI18n, ProjectFsEventsKey } from '@lite-ide/workbench'
import GitBranch from 'lucide-solid/icons/git-branch'
// Bundle-format build: the two previewer components are statically imported
// so the CJS dist stays a single file (the diff and xlsx previewers share
// git-store/xlsx-diff internally — multi-entry would make rollup emit shared
// chunks the host cannot resolve). xlsx travels with the bundle.
import GitDiffPreview from './GitDiffPreview'
import XlsxTablePreview from './XlsxTablePreview'
import { GitView } from './GitView'
import { GitStatusBarItem } from './GitStatusBarItem'
import { createGitStore, GitBackendKey, GIT_DIFF_PREVIEWER_ID, GitStoreKey } from './git-store'
import { isImageFile } from './image-diff'
import { isSpreadsheetFile } from './xlsx-diff'
import { GIT_EN_US, GIT_ZH_CN } from './i18n'
import './plugin.css'

export {
  createGitStore,
  GitBackendKey,
  GitStoreKey,
  GIT_DIFF_PREVIEWER_ID,
  commitFileLetter,
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
  type SplitRow,
  splitHunkRows,
} from './diff-parse'
export { GitView } from './GitView'
export { GitHistory } from './GitHistory'
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
    // Spreadsheets and images are binary to git but compared from parsed rows
    // or decoded image snapshots, so they must stay handleable.
    ctx.contribute('previewer.provider', {
      id: GIT_DIFF_PREVIEWER_ID,
      label: 'Diff',
      labelKey: 'git.diff.label',
      priority: 5,
      canHandle: (file) =>
        !file.isBinary || isSpreadsheetFile(file.relPath) || isImageFile(file.relPath),
      load: () => Promise.resolve({ default: GitDiffPreview }),
    })

    // Workbook sheet preview: clicking an xlsx/xlsm/xls in the explorer shows
    // its first sheet as a read-only table, with a shortcut into the diff
    // comparison when the file carries uncommitted changes.
    ctx.contribute('previewer.provider', {
      id: 'git-xlsx-table',
      label: 'Sheet',
      labelKey: 'git.preview.label',
      priority: 55,
      canHandle: (file) => file.isBinary && isSpreadsheetFile(file.relPath),
      load: () => Promise.resolve({ default: XlsxTablePreview }),
    })

    ctx.contribute('statusbar.item', {
      id: 'git.branch',
      align: 'right',
      order: 10,
      component: GitStatusBarItem,
    })
  },
}

export default gitPlugin
