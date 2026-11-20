import type { GitFileStatus } from '@lite-ide/protocol'

export interface GitTreeDirNode {
  kind: 'dir'
  /** Display label, possibly compacted across single-child folders (e.g. `src/utils`). */
  label: string
  /** Full project-relative folder path used as a stable collapse key. */
  relPath: string
  dirs: GitTreeDirNode[]
  files: GitFileStatus[]
  /** All entries under this directory subtree (for folder-level stage/unstage). */
  allEntries: GitFileStatus[]
}

export type GitTreeRow =
  | {
      kind: 'dir'
      key: string
      label: string
      relPath: string
      depth: number
      collapsed: boolean
      entries: GitFileStatus[]
    }
  | {
      kind: 'file'
      key: string
      entry: GitFileStatus
      depth: number
    }

interface MutableDirNode {
  name: string
  relPath: string
  dirs: Map<string, MutableDirNode>
  files: GitFileStatus[]
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function compactDir(node: MutableDirNode): GitTreeDirNode {
  let current = node
  let label = node.name
  while (current.dirs.size === 1 && current.files.length === 0) {
    const onlyChild = current.dirs.values().next().value!
    label = `${label}/${onlyChild.name}`
    current = onlyChild
  }

  const dirs = [...current.dirs.values()]
    .map(compactDir)
    .sort((a, b) => compareNames(a.label, b.label))
  const files = [...current.files].sort((a, b) => {
    const aName = a.relPath.slice(a.relPath.lastIndexOf('/') + 1)
    const bName = b.relPath.slice(b.relPath.lastIndexOf('/') + 1)
    return compareNames(aName, bName)
  })
  const allEntries = [...dirs.flatMap((d) => d.allEntries), ...files]

  return {
    kind: 'dir',
    label,
    relPath: current.relPath,
    dirs,
    files,
    allEntries,
  }
}

export interface GitTreeRoot {
  dirs: GitTreeDirNode[]
  files: GitFileStatus[]
}

/**
 * Builds a directory tree from flat git status entries, compacting
 * single-child folder chains (e.g. `packages/kernel/src`).
 */
export function buildGitTree(entries: readonly GitFileStatus[]): GitTreeRoot {
  const rootDirs = new Map<string, MutableDirNode>()
  const rootFiles: GitFileStatus[] = []

  for (const entry of entries) {
    const segments = entry.relPath.split('/').filter((s) => s.length > 0)
    if (segments.length <= 1) {
      rootFiles.push(entry)
      continue
    }

    let currentMap = rootDirs
    let accPath = ''
    let parentDir: MutableDirNode | null = null
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      accPath = accPath ? `${accPath}/${segment}` : segment
      let dir = currentMap.get(segment)
      if (!dir) {
        dir = {
          name: segment,
          relPath: accPath,
          dirs: new Map(),
          files: [],
        }
        currentMap.set(segment, dir)
      }
      parentDir = dir
      currentMap = dir.dirs
    }
    parentDir?.files.push(entry)
  }

  const dirs = [...rootDirs.values()]
    .map(compactDir)
    .sort((a, b) => compareNames(a.label, b.label))
  const files = [...rootFiles].sort((a, b) => compareNames(a.relPath, b.relPath))

  return { dirs, files }
}

/**
 * Flattens a `GitTreeRoot` into visible rows respecting collapsed folder state.
 */
export function flattenGitTree(
  root: GitTreeRoot,
  section: 'staged' | 'unstaged',
  collapsedDirs: Readonly<Record<string, boolean>>,
): GitTreeRow[] {
  const rows: GitTreeRow[] = []

  function visitDir(dir: GitTreeDirNode, depth: number) {
    const key = `${section}:${dir.relPath}`
    const collapsed = Boolean(collapsedDirs[key])
    rows.push({
      kind: 'dir',
      key,
      label: dir.label,
      relPath: dir.relPath,
      depth,
      collapsed,
      entries: dir.allEntries,
    })
    if (collapsed) return
    for (const childDir of dir.dirs) {
      visitDir(childDir, depth + 1)
    }
    for (const file of dir.files) {
      rows.push({
        kind: 'file',
        key: `${section}:file:${file.relPath}`,
        entry: file,
        depth: depth + 1,
      })
    }
  }

  for (const dir of root.dirs) {
    visitDir(dir, 0)
  }
  for (const file of root.files) {
    rows.push({
      kind: 'file',
      key: `${section}:file:${file.relPath}`,
      entry: file,
      depth: 0,
    })
  }
  return rows
}
