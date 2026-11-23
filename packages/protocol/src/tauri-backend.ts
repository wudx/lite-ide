import { Channel, invoke } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { message, open, save } from '@tauri-apps/plugin-dialog'
import type {
  CatalogPlugin,
  DirEntry,
  FileMeta,
  FsDelta,
  InstalledPlugin,
  PickFolderOptions,
  PickSavePathOptions,
  PluginListResult,
  ProjectInfo,
  TerminalEvent,
  TerminalSessionHandle,
  TextPayload,
  WorkspaceBackend,
  WriteTextResult,
} from './types'

/**
 * Maps an absolute path chosen in a native dialog onto a workspace-relative
 * path. Returns null when the path lies outside (or equals) the project root.
 * Comparison is separator- and case-insensitive so Windows drives and mixed
 * separators from the dialog are handled.
 */
export function toProjectRelPath(root: string, absPath: string): string | null {
  const normalize = (p: string) => {
    const unified = p.replace(/\//g, '\\')
    return unified.length > 1 && unified.endsWith('\\') ? unified.slice(0, -1) : unified
  }
  const rootNorm = normalize(root)
  const absNorm = normalize(absPath)
  const rootLower = rootNorm.toLowerCase()
  const absLower = absNorm.toLowerCase()
  if (absLower === rootLower) return null
  if (!absLower.startsWith(`${rootLower}\\`)) return null
  return absNorm.slice(rootNorm.length + 1).replace(/\\/g, '/')
}

export function createTauriBackend(): WorkspaceBackend {
  const projectRoots = new Map<string, string>()

  return {
    kind: 'tauri',

    async openProject(path: string, onFsEvent: (delta: FsDelta) => void): Promise<ProjectInfo> {
      const channel = new Channel<FsDelta>()
      channel.onmessage = (delta) => {
        onFsEvent(delta)
      }
      const info = await invoke<ProjectInfo>('project_open', {
        path,
        onFsEvent: channel,
      })
      projectRoots.set(info.id, info.rootPath)
      return info
    },

    async closeProject(projectId: string): Promise<void> {
      projectRoots.delete(projectId)
      await invoke<void>('project_close', { projectId })
    },

    async listDir(projectId: string, relPath: string): Promise<DirEntry[]> {
      return invoke<DirEntry[]>('fs_list_dir', { projectId, relPath })
    },

    async statPreview(projectId: string, relPath: string): Promise<FileMeta> {
      return invoke<FileMeta>('fs_stat_preview', { projectId, relPath })
    },

    async readText(projectId: string, relPath: string, maxBytes?: number): Promise<TextPayload> {
      return invoke<TextPayload>('fs_read_text', { projectId, relPath, maxBytes })
    },

    async writeText(
      projectId: string,
      relPath: string,
      content: string,
      encoding?: string,
    ): Promise<WriteTextResult> {
      return invoke<WriteTextResult>('fs_write_text', {
        projectId,
        relPath,
        content,
        encoding,
      })
    },

    async createFile(projectId: string, relPath: string): Promise<FileMeta> {
      return invoke<FileMeta>('fs_create_file', { projectId, relPath })
    },

    async createDir(projectId: string, relPath: string): Promise<DirEntry> {
      return invoke<DirEntry>('fs_create_dir', { projectId, relPath })
    },

    async renamePath(
      projectId: string,
      oldRelPath: string,
      newRelPath: string,
    ): Promise<DirEntry> {
      return invoke<DirEntry>('fs_rename_path', { projectId, oldRelPath, newRelPath })
    },

    async deletePath(projectId: string, relPath: string): Promise<void> {
      await invoke<void>('fs_delete_path', { projectId, relPath })
    },

    async revealInFileManager(projectId: string, relPath: string): Promise<void> {
      await invoke<void>('fs_reveal_in_file_manager', { projectId, relPath })
    },

    async pickFolder(options?: PickFolderOptions): Promise<string | null> {
      const selected = await open({
        directory: true,
        multiple: false,
        title: options?.title ?? 'Open Project Folder',
      })
      if (typeof selected === 'string' && selected.length > 0) {
        return selected
      }
      return null
    },

    async pickSavePath(
      projectId: string,
      suggestedName: string,
      options?: PickSavePathOptions,
    ): Promise<string | null> {
      const root = projectRoots.get(projectId)
      if (!root) return null

      const selected = await save({
        title: options?.title ?? 'Save Untitled File',
        defaultPath: await join(root, suggestedName),
      })
      if (!selected) return null

      const relPath = toProjectRelPath(root, selected)
      if (!relPath) {
        await message(
          options?.outsideProjectMessage ?? 'Please choose a location inside the project folder.',
          {
            title: 'LiteIDE',
            kind: 'warning',
          },
        )
        return null
      }
      return relPath
    },

    // 外部插件管理：桌面端由 Rust 侧维护应用数据目录下的 plugins/ 文件夹。
    async pluginList(): Promise<PluginListResult> {
      return invoke<PluginListResult>('plugin_list')
    },

    async pluginInstallFromPath(sourcePath: string): Promise<InstalledPlugin> {
      return invoke<InstalledPlugin>('plugin_install_from_path', { sourcePath })
    },

    async pluginInstallFromCatalog(catalogId: string): Promise<InstalledPlugin> {
      return invoke<InstalledPlugin>('plugin_install_from_catalog', { catalogId })
    },

    // GitHub 安装由 Rust 侧下载 zipball 并走同一套校验/落盘管线。
    async pluginInstallFromGithub(url: string): Promise<InstalledPlugin> {
      return invoke<InstalledPlugin>('plugin_install_from_github', { url })
    },

    async pluginUninstall(pluginId: string): Promise<void> {
      await invoke<void>('plugin_uninstall', { pluginId })
    },

    async pluginReadEntry(pluginId: string): Promise<string> {
      return invoke<string>('plugin_read_entry', { pluginId })
    },

    async pluginReadAsset(pluginId: string, fileName: string): Promise<string> {
      return invoke<string>('plugin_read_asset', { pluginId, fileName })
    },

    async pluginCatalog(): Promise<CatalogPlugin[]> {
      return invoke<CatalogPlugin[]>('plugin_catalog')
    },

    // 交互式终端：输出经 IPC Channel 流式回传（base64 分帧，见 TerminalEvent）。
    async terminalSpawn(projectId, options): Promise<TerminalSessionHandle> {
      const channel = new Channel<TerminalEvent>()
      channel.onmessage = (event) => {
        options.onEvent(event)
      }
      return invoke<TerminalSessionHandle>('terminal_spawn', {
        projectId,
        cols: options.cols,
        rows: options.rows,
        onEvent: channel,
      })
    },

    terminalWrite(sessionId: string, data: string): Promise<void> {
      return invoke<void>('terminal_write', { sessionId, data })
    },

    terminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
      return invoke<void>('terminal_resize', { sessionId, cols, rows })
    },

    terminalKill(sessionId: string): Promise<void> {
      return invoke<void>('terminal_kill', { sessionId })
    },
  }
}
