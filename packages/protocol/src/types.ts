export interface ProjectInfo {
  id: string
  name: string
  rootPath: string
}

export interface DirEntry {
  name: string
  relPath: string
  isDir: boolean
  size: number
  modifiedMs: number
  ignored: boolean
  hidden: boolean
}

export interface FileMeta {
  projectId: string
  relPath: string
  name: string
  ext: string
  size: number
  modifiedMs: number
  mime: string
  isBinary: boolean
  encoding: string
}

export interface TextPayload {
  content: string
  totalBytes: number
  loadedBytes: number
  truncated: boolean
  lineCount: number
  encoding: string
}

export interface WriteTextResult {
  meta: FileMeta
  lineCount: number
  writtenBytes: number
}

export interface FsDelta {
  projectId: string
  affectedDirs: string[]
  affectedPaths: string[]
  overflow: boolean
}

export interface WorkspaceBackend {
  readonly kind: 'tauri' | 'mock'
  openProject(path: string, onFsEvent: (delta: FsDelta) => void): Promise<ProjectInfo>
  closeProject(projectId: string): Promise<void>
  listDir(projectId: string, relPath: string): Promise<DirEntry[]>
  statPreview(projectId: string, relPath: string): Promise<FileMeta>
  readText(projectId: string, relPath: string, maxBytes?: number): Promise<TextPayload>
  writeText(
    projectId: string,
    relPath: string,
    content: string,
    encoding?: string,
  ): Promise<WriteTextResult>
  createFile(projectId: string, relPath: string): Promise<FileMeta>
  createDir(projectId: string, relPath: string): Promise<DirEntry>
  renamePath(projectId: string, oldRelPath: string, newRelPath: string): Promise<DirEntry>
  deletePath(projectId: string, relPath: string): Promise<void>
  pickFolder(): Promise<string | null>
  resolveFileUrl?(projectId: string, relPath: string): string
}
