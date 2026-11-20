import { describe, expect, it } from 'vitest'
import { toProjectRelPath } from '../src/tauri-backend'

describe('toProjectRelPath', () => {
  it('maps absolute dialog paths onto workspace-relative paths', () => {
    expect(toProjectRelPath('E:\\projects\\demo', 'E:\\projects\\demo\\notes.md')).toBe('notes.md')
    expect(toProjectRelPath('E:\\projects\\demo', 'E:\\projects\\demo\\src\\a\\b.ts')).toBe(
      'src/a/b.ts',
    )
    // Mixed separators and a trailing root slash from the dialog.
    expect(toProjectRelPath('E:\\projects\\demo\\', 'E:/projects/demo/x.md')).toBe('x.md')
  })

  it('rejects paths outside or equal to the project root', () => {
    expect(toProjectRelPath('E:\\projects\\demo', 'E:\\projects\\demo')).toBeNull()
    expect(toProjectRelPath('E:\\projects\\demo', 'E:\\projects\\demo2\\x.md')).toBeNull()
    expect(toProjectRelPath('E:\\projects\\demo', 'D:\\other\\x.md')).toBeNull()
  })

  it('compares case-insensitively for Windows drives while preserving the case of the result', () => {
    expect(toProjectRelPath('e:\\Projects\\Demo', 'E:\\PROJECTS\\demo\\Sub\\X.md')).toBe(
      'Sub/X.md',
    )
  })
})
