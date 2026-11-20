import { describe, expect, it } from 'vitest'
import { joinNativePath } from '../src/paths'

describe('joinNativePath', () => {
  it('joins with backslashes for Windows-style roots', () => {
    expect(joinNativePath('D:\\Projects\\demo', 'src/main.ts')).toBe('D:\\Projects\\demo\\src\\main.ts')
    expect(joinNativePath('D:\\Projects\\demo', 'assets')).toBe('D:\\Projects\\demo\\assets')
  })

  it('joins with forward slashes for POSIX-style roots', () => {
    expect(joinNativePath('/workspace/lite-ide-demo', 'src/main.ts')).toBe(
      '/workspace/lite-ide-demo/src/main.ts',
    )
  })

  it('avoids duplicating a trailing separator on the root', () => {
    expect(joinNativePath('D:\\Projects\\demo\\', 'src/main.ts')).toBe('D:\\Projects\\demo\\src\\main.ts')
    expect(joinNativePath('/workspace/', 'src/main.ts')).toBe('/workspace/src/main.ts')
  })
})
