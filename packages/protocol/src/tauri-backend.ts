import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { DirEntry, FileMeta, FsDelta, ProjectInfo, TextPayload, WorkspaceBackend } from './types'

export function createTauriBackend(): WorkspaceBackend {
  return {
    kind: 'tauri',

    async openProject(path: string, onFsEvent: (delta: FsDelta) => void): Promise<ProjectInfo> {
      const channel = new Channel<FsDelta>()
      channel.onmessage = (delta) => {
        onFsEvent(delta)
      }
      return invoke<ProjectInfo>('project_open', {
        path,
        onFsEvent: channel,
      })
    },

    async closeProject(projectId: string): Promise<void> {
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

    async pickFolder(): Promise<string | null> {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Open Project Folder',
      })
      if (typeof selected === 'string' && selected.length > 0) {
        return selected
      }
      return null
    },
  }
}
