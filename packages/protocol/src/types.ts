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

/**
 * Manifest of an installable external plugin (`plugin.json` inside the plugin
 * folder). Entry scripts are classic scripts registering themselves through
 * the injected `liteide.plugin({...})` global at load time.
 */
export interface PluginManifest {
  /** Unique id: ASCII letters, digits, `-` and `_` (also the folder name). */
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** Entry script filename inside the plugin folder; defaults to `main.js`. */
  main?: string
}

/** A plugin installed in the backend-managed plugins directory. */
export interface InstalledPlugin {
  manifest: PluginManifest
  /** Folder name inside the managed plugins root. */
  dirName: string
  installedMs: number
  /** Set when the folder exists but its manifest failed validation. */
  error?: string | null
}

export interface PluginListResult {
  /** Absolute path of the managed plugins root; null on the browser demo backend. */
  rootPath: string | null
  plugins: InstalledPlugin[]
}

/** A catalog entry available for one-click install (built-in samples). */
export interface CatalogPlugin {
  manifest: PluginManifest
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

/** Per-file patch text from `git diff` (unified format, no color codes). */
export interface GitDiffFile {
  relPath: string
  patch: string
}

export interface GitDiffOptions {
  /** True for staged changes (`git diff --staged`), false for worktree changes. */
  staged: boolean
  /** Optional path filter; omit for every changed file. */
  relPaths?: string[]
}

/**
 * Which snapshot a blob read targets: the HEAD commit, the index (stage 0,
 * the "staged" content), or the worktree file on disk.
 */
export type GitBlobRev = 'HEAD' | ':0' | 'worktree'

export interface GitBranchInfo {
  name: string
  /** True for the currently checked-out branch. */
  current: boolean
  /** True for remote tracking branches (e.g. `origin/main`). */
  remote: boolean
  /** Configured upstream tracking branch for local branches, if any. */
  upstream?: string | null
}

/** One entry from `git stash list`; `index` 0 is the newest entry. */
export interface GitStashEntry {
  index: number
  /** Reflog selector, e.g. `stash@{0}`. */
  refName: string
  /** Stash subject line ("WIP on main: abc1234 msg" or "On main: msg"). */
  message: string
  /** Relative committer date for display, e.g. "2 hours ago". */
  date: string
}

/** One commit from `git log` on the current branch, newest first. */
export interface GitCommitInfo {
  /** Full commit SHA. */
  sha: string
  /** Abbreviated SHA for display (git picks the unambiguous length). */
  shortSha: string
  /** First paragraph (subject line) of the commit message. */
  subject: string
  /** Remaining commit message body, if any. */
  body?: string | null
  author: string
  email: string
  /** Author time in epoch milliseconds. */
  dateMs: number
}

export interface GitLogOptions {
  /** Maximum number of commits to return (default 50). */
  limit?: number
  /** Number of newer commits to skip, for pagination. */
  skip?: number
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
  /** Unified per-file patches for staged or worktree changes (empty when clean). */
  diff(projectId: string, options: GitDiffOptions): Promise<GitDiffFile[]>
  /**
   * Raw file bytes (base64) from the requested snapshot. Resolves to null
   * when the path does not exist there (e.g. a file added in the worktree
   * read at HEAD). Backs binary comparisons such as spreadsheet diffs.
   */
  readBlob(projectId: string, rev: GitBlobRev, relPath: string): Promise<string | null>
  /**
   * Recent commits on the current branch, newest first. A folder outside
   * version control — or a repository without any commits yet — resolves to
   * an empty list rather than an error.
   */
  log(projectId: string, options?: GitLogOptions): Promise<GitCommitInfo[]>
  /**
   * Per-file patches introduced by one commit. Paths narrow the result;
   * merge commits resolve to an empty list (combined diffs are not shown).
   */
  show(projectId: string, sha: string, relPaths?: string[]): Promise<GitDiffFile[]>
  branches(projectId: string): Promise<GitBranchInfo[]>
  checkoutBranch(projectId: string, name: string, create?: boolean): Promise<void>
  /** Stashes all tracked + untracked changes; optional stash message. */
  stashAll(projectId: string, message?: string): Promise<void>
  /** Stashes only the given paths' changes (tracked and untracked). */
  stashPaths(projectId: string, relPaths: string[]): Promise<void>
  /** The project's stash stack, newest entry first. */
  stashList(projectId: string): Promise<GitStashEntry[]>
  /** Applies the stash entry to the worktree without removing it (git stash apply). */
  stashRestore(projectId: string, index: number): Promise<void>
  /** Removes a stash entry without applying it (git stash drop). */
  stashDrop(projectId: string, index: number): Promise<void>
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

  // ---- External plugin management (app-level, optional like pickSavePath) ----

  /** Installed external plugins; absent when the backend lacks plugin support. */
  pluginList?(): Promise<PluginListResult>
  /** Installs a plugin from a local folder containing `plugin.json` (desktop). */
  pluginInstallFromPath?(sourcePath: string): Promise<InstalledPlugin>
  /** Installs a built-in catalog plugin by id (desktop & demo backends). */
  pluginInstallFromCatalog?(catalogId: string): Promise<InstalledPlugin>
  /** Removes an installed plugin folder. */
  pluginUninstall?(pluginId: string): Promise<void>
  /** Entry script source of an installed plugin, ready for evaluation. */
  pluginReadEntry?(pluginId: string): Promise<string>
  /** Installable catalog; absent when the backend ships no catalog. */
  pluginCatalog?(): Promise<CatalogPlugin[]>
}
