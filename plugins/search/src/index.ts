import type { Plugin } from '@lite-ide/kernel'
import {
  CodeNavigationKey,
  ConfirmDialogKey,
  EditorBufferKey,
  getI18n,
  LayoutStateKey,
  ProjectFsEventsKey,
  ProjectSelectionKey,
  WorkspaceBackendKey,
  WorkspaceSearchLauncherKey,
  type WorkspaceSearchOptions,
} from '@lite-ide/workbench'
import Search from 'lucide-solid/icons/search'
import { SEARCH_EN_US, SEARCH_ZH_CN } from './i18n'
import './plugin.css'
import { SearchView } from './SearchView'
import { createSearchStore, SearchStoreKey } from './search-store'

export {
  compileSearchPattern,
  computeReplacementPreview,
  countLines,
  hasNullByte,
  isLikelyBinaryPath,
  parseFilterPatterns,
  replaceAllInContent,
  replaceSingleMatchInContent,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_FILES,
  SEARCH_MAX_MATCHES,
  searchFileContent,
  shouldIncludeRelPath,
  type CompiledSearchPattern,
  type FileSearchResult,
  type FilterRule,
  type SearchMatch,
  type SearchQueryOptions,
} from './search-engine'
export {
  createSearchStore,
  SearchStoreKey,
  type SearchFocusRequest,
  type SearchStore,
} from './search-store'
export { SearchView } from './SearchView'
export { SEARCH_EN_US, SEARCH_ZH_CN } from './i18n'

export const SEARCH_SIDEBAR_VIEW_ID = 'search'

function readActiveEditorSelectionText(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const sel = window.getSelection()?.toString()
  if (!sel) return undefined
  // Only pre-fill concise single-line selections from the page.
  const trimmed = sel.trim()
  if (!trimmed || trimmed.includes('\n') || trimmed.length > 200) return undefined
  const activeEl = document.activeElement
  if (activeEl && activeEl.closest('.cm-editor')) {
    return trimmed
  }
  return undefined
}

export const searchPlugin: Plugin = {
  id: 'builtin.search',
  name: 'Search',
  activate(ctx) {
    const backend = ctx.get(WorkspaceBackendKey)
    const i18n = getI18n(ctx)
    const layout = ctx.get(LayoutStateKey)
    const dialogs = ctx.tryGet(ConfirmDialogKey)

    ctx.contribute('i18n', { locale: 'zh-CN', messages: SEARCH_ZH_CN })
    ctx.contribute('i18n', { locale: 'en-US', messages: SEARCH_EN_US })

    ctx.onProjectOpen((scope) => {
      const store = createSearchStore(scope.id, {
        backend,
        selection: scope.tryGet(ProjectSelectionKey),
        buffers: scope.tryGet(EditorBufferKey),
        navigation: scope.tryGet(CodeNavigationKey),
        dialogs,
        t: i18n.t,
      })
      const storeReg = scope.provide(SearchStoreKey, store)

      const fsEvents = scope.tryGet(ProjectFsEventsKey)
      const fsSubscription = fsEvents?.on('delta', (delta) => {
        store.handleFsDelta(delta)
      })
      return {
        dispose() {
          fsSubscription?.dispose()
          storeReg.dispose()
          store.dispose()
        },
      }
    })

    function openSearchSidebar(options: WorkspaceSearchOptions = {}) {
      const activeScope = ctx.kernel.activeProject()
      if (!activeScope) {
        layout.setSidebarVisible(true)
        return
      }
      layout.showSidebarView(activeScope.id, SEARCH_SIDEBAR_VIEW_ID)
      const store = activeScope.tryGet(SearchStoreKey)
      if (!store) return

      if (options.focusReplace !== undefined) {
        store.setReplaceExpanded(options.focusReplace)
      }
      if (options.include !== undefined) {
        store.setFilesToInclude(options.include)
        store.setFiltersExpanded(true)
      }
      if (options.query !== undefined) {
        store.setQuery(options.query)
        void store.runSearchNow()
      }

      const focusTarget =
        options.focusReplace && (options.query ?? store.query()).length > 0
          ? 'replace'
          : 'search'
      store.requestFocus(focusTarget)
    }

    ctx.provide(WorkspaceSearchLauncherKey, {
      findInFiles: openSearchSidebar,
    })

    ctx.contribute('sidebar.view', {
      id: SEARCH_SIDEBAR_VIEW_ID,
      title: 'Search',
      titleKey: 'search.view.title',
      order: 15,
      icon: Search,
      component: SearchView,
    })

    ctx.contribute('command', {
      id: 'search.findInFiles',
      title: 'Find in Files',
      titleKey: 'search.command.findInFiles',
      shortcut: 'Mod+Shift+F',
      run: () => {
        const selected = readActiveEditorSelectionText()
        openSearchSidebar(selected ? { query: selected } : {})
      },
    })

    ctx.contribute('command', {
      id: 'search.replaceInFiles',
      title: 'Replace in Files',
      titleKey: 'search.command.replaceInFiles',
      shortcut: 'Mod+Shift+H',
      run: () => {
        const selected = readActiveEditorSelectionText()
        openSearchSidebar({
          focusReplace: true,
          ...(selected ? { query: selected } : {}),
        })
      },
    })

    // Ctrl+Shift+F / Ctrl+Shift+H（capture 阶段监听，插件停用/卸载时随上下文清理）。
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'f') {
          e.preventDefault()
          void ctx.kernel.executeCommand('search.findInFiles')
        } else if (key === 'h') {
          e.preventDefault()
          void ctx.kernel.executeCommand('search.replaceInFiles')
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    ctx.onDispose(() => window.removeEventListener('keydown', handleKeyDown, true))
  },
}

export default searchPlugin
