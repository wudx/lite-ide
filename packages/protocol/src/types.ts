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

export interface PickFolderOptions {
  title?: string
}

export interface PickSavePathOptions {
  title?: string
  outsideProjectMessage?: string
}

/** One changed path from `git status --porcelain`. Letters follow git's XY alphabet. */
export interface GitFileStatus {
  /** Index (staged) status letter: ' ', 'M', 'A', 'D', 'R', 'C', 'U' or '?'. */
  x: string
  /** Worktree (unstaged) status letter, same alphabet as `x`. */
  y: string
  relPath: string
  /** Original path for renames/copies. */
  origPath?: string | null
}

export interface GitStatus {
  /** False when the project folder is not inside a git work tree. */
  repo: boolean
  /** Current branch name; null on a detached HEAD. */
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  entries: GitFileStatus[]
}

export interface GitCommitResult {
  sha: string
}

export interface GitBranchInfo {
  name: string
  /** True for the currently checked-out branch. */
  current: boolean
  /** True for remote tracking branches (e.g. `origin/main`). */
  remote: boolean
  /** Configured upstream tracking branch for local branches, if any. */
  upstream?: string | null
}

/**
 * Version-control operations for one opened project. Implementations must
 * scope every call to the project and only accept project-relative paths.
 */
export interface GitBackend {
  status(projectId: string): Promise<GitStatus>
  stage(projectId: string, relPaths: string[]): Promise<void>
  unstage(projectId: string, relPaths: string[]): Promise<void>
  /**
   * Reverts worktree changes: untracked paths are deleted, tracked paths are
   * restored from the index. Staged-only changes are not touched.
   */
  discard(
    projectId: string,
    untrackedPaths: string[],
    trackedPaths: string[],
  ): Promise<void>
  commit(projectId: string, message: string): Promise<GitCommitResult>
  push(projectId: string): Promise<void>
  branches(projectId: string): Promise<GitBranchInfo[]>
  checkoutBranch(projectId: string, name: string, create?: boolean): Promise<void>
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
  pickFolder(options?: PickFolderOptions): Promise<string | null>
  /**
   * Desktop-only: opens a native save dialog rooted at the project folder and
   * resolves to the chosen location relative to the project root, or null when
   * the user cancels (or picks a path outside the project). Browser backends
   * omit this capability; callers fall back to inline path entry.
   */
  pickSavePath?(
    projectId: string,
    suggestedName: string,
    options?: PickSavePathOptions,
  ): Promise<string | null>
  resolveFileUrl?(projectId: string, relPath: string): string
}
