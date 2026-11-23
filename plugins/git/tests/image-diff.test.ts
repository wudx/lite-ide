import { afterEach, describe, expect, it } from 'vitest'
import {
  base64ToDataUrl,
  estimateBase64ByteLength,
  IMAGE_DIFF_MODE_STORAGE_KEY,
  imageMimeForPath,
  isImageFile,
  isSvgFile,
  readStoredImageDiffMode,
  writeStoredImageDiffMode,
} from '../src/image-diff'

describe('image-diff helpers', () => {
  afterEach(() => {
    localStorage.removeItem(IMAGE_DIFF_MODE_STORAGE_KEY)
  })

  it('detects supported image formats case-insensitively', () => {
    expect(isImageFile('assets/logo.png')).toBe(true)
    expect(isImageFile('assets/PHOTO.JPEG')).toBe(true)
    expect(isImageFile('icons/app.webp')).toBe(true)
    expect(isImageFile('diagrams/arch.svg')).toBe(true)
    expect(isImageFile('src/App.tsx')).toBe(false)
    expect(isImageFile('data/metrics.xlsx')).toBe(false)
    expect(isImageFile('no-extension')).toBe(false)
  })

  it('distinguishes svg files from raster images', () => {
    expect(isSvgFile('diagrams/arch.svg')).toBe(true)
    expect(isSvgFile('diagrams/ARCH.SVG')).toBe(true)
    expect(isSvgFile('assets/logo.png')).toBe(false)
  })

  it('builds valid data URLs with matching MIME types', () => {
    expect(imageMimeForPath('a/b.png')).toBe('image/png')
    expect(imageMimeForPath('a/b.jpg')).toBe('image/jpeg')
    expect(imageMimeForPath('a/b.svg')).toBe('image/svg+xml')
    expect(base64ToDataUrl('AAAA', 'assets/icon.webp')).toBe('data:image/webp;base64,AAAA')
  })

  it('estimates decoded byte length from standard base64', () => {
    expect(estimateBase64ByteLength('')).toBe(0)
    expect(estimateBase64ByteLength('Zg==')).toBe(1) // 'f'
    expect(estimateBase64ByteLength('Zm8=')).toBe(2) // 'fo'
    expect(estimateBase64ByteLength('Zm9v')).toBe(3) // 'foo'
  })

  it('persists and restores image diff view mode', () => {
    expect(readStoredImageDiffMode()).toBe('side-by-side')
    writeStoredImageDiffMode('swipe')
    expect(readStoredImageDiffMode()).toBe('swipe')
    writeStoredImageDiffMode('difference')
    expect(readStoredImageDiffMode()).toBe('difference')
    localStorage.setItem(IMAGE_DIFF_MODE_STORAGE_KEY, 'unknown-mode')
    expect(readStoredImageDiffMode()).toBe('side-by-side')
  })
})
