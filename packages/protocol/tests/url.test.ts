import { describe, expect, it } from 'vitest'
import { encodeRelPath, getWorkspaceFileUrl } from '../src/url'

describe('workspace URL builder', () => {
  it('normalizes slashes and encodes unicode segments', () => {
    expect(encodeRelPath('src\\assets\\图标 logo.svg')).toBe(
      'src/assets/%E5%9B%BE%E6%A0%87%20logo.svg',
    )
    expect(encodeRelPath('/docs/intro.md/')).toBe('docs/intro.md')
  })

  it('builds Windows http://workspace.localhost URL when Windows runtime', () => {
    expect(getWorkspaceFileUrl('proj-1', 'assets/a b.png', undefined, true)).toBe(
      'http://workspace.localhost/proj-1/assets/a%20b.png',
    )
  })

  it('builds workspace://localhost URL on macOS and Linux', () => {
    expect(getWorkspaceFileUrl('proj-1', 'assets/a b.png', undefined, false)).toBe(
      'workspace://localhost/proj-1/assets/a%20b.png',
    )
  })
})
