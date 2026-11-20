import type { GitFileStatus } from '@lite-ide/protocol'
import { describe, expect, it } from 'vitest'
import { buildGitTree, flattenGitTree } from '../src/git-tree'

function entry(relPath: string, x = ' ', y = 'M'): GitFileStatus {
  return { x, y, relPath }
}

describe('git-tree', () => {
  it('compacts single-child folder chains and sorts dirs before files', () => {
    const tree = buildGitTree([
      entry('README.md'),
      entry('packages/kernel/src/kernel.ts'),
      entry('src/App.tsx'),
      entry('a2.txt'),
      entry('a10.txt'),
    ])

    const rows = flattenGitTree(tree, 'unstaged', {})
    expect(
      rows.map((r) =>
        r.kind === 'dir' ? `D:${r.depth}:${r.label}` : `F:${r.depth}:${r.entry.relPath}`,
      ),
    ).toEqual([
      'D:0:packages/kernel/src',
      'F:1:packages/kernel/src/kernel.ts',
      'D:0:src',
      'F:1:src/App.tsx',
      'F:0:a2.txt',
      'F:0:a10.txt',
      'F:0:README.md',
    ])
  })

  it('stops compacting when a folder branches or has direct files', () => {
    const tree = buildGitTree([
      entry('src/index.ts'),
      entry('src/utils/deep/format.ts'),
      entry('packages/a/one.ts'),
      entry('packages/b/two.ts'),
    ])

    const rows = flattenGitTree(tree, 'staged', {})
    expect(
      rows.map((r) =>
        r.kind === 'dir' ? `D:${r.depth}:${r.label}` : `F:${r.depth}:${r.entry.relPath}`,
      ),
    ).toEqual([
      'D:0:packages',
      'D:1:a',
      'F:2:packages/a/one.ts',
      'D:1:b',
      'F:2:packages/b/two.ts',
      'D:0:src',
      'D:1:utils/deep',
      'F:2:src/utils/deep/format.ts',
      'F:1:src/index.ts',
    ])
  })

  it('hides descendants of collapsed directories and collects subtree entries', () => {
    const tree = buildGitTree([
      entry('src/App.tsx'),
      entry('src/components/Button.tsx'),
      entry('README.md'),
    ])

    const rows = flattenGitTree(tree, 'unstaged', { 'unstaged:src': true })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      kind: 'dir',
      label: 'src',
      relPath: 'src',
      collapsed: true,
    })
    if (rows[0].kind === 'dir') {
      expect(rows[0].entries.map((e) => e.relPath)).toEqual([
        'src/components/Button.tsx',
        'src/App.tsx',
      ])
    }
    expect(rows[1]).toMatchObject({
      kind: 'file',
      depth: 0,
    })
  })

  it('preserves rename origPath and unmerged entries while isolating collapse keys per section', () => {
    const tree = buildGitTree([
      { x: 'R', y: ' ', relPath: 'src/new.ts', origPath: 'src/old.ts' },
      { x: 'U', y: 'U', relPath: 'src/conflict.ts' },
    ])

    const stagedCollapsed = flattenGitTree(tree, 'staged', { 'staged:src': true })
    const unstagedExpanded = flattenGitTree(tree, 'unstaged', { 'staged:src': true })

    expect(stagedCollapsed).toHaveLength(1)
    expect(stagedCollapsed[0]).toMatchObject({
      kind: 'dir',
      key: 'staged:src',
      collapsed: true,
    })
    if (stagedCollapsed[0].kind === 'dir') {
      expect(stagedCollapsed[0].entries).toEqual([
        { x: 'U', y: 'U', relPath: 'src/conflict.ts' },
        { x: 'R', y: ' ', relPath: 'src/new.ts', origPath: 'src/old.ts' },
      ])
    }

    expect(unstagedExpanded).toHaveLength(3)
    expect(unstagedExpanded[0]).toMatchObject({
      kind: 'dir',
      key: 'unstaged:src',
      collapsed: false,
    })
  })
})
