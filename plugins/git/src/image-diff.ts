/**
 * Image diff helpers for the Git diff preview.
 *
 * Covers extension detection, MIME mapping, base64 data-URL construction,
 * byte-length estimation, persisted comparison mode, and offscreen canvas
 * pixel-difference computation.
 */

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

export type ImageDiffMode = 'side-by-side' | 'swipe' | 'onion' | 'difference'

export const IMAGE_DIFF_MODE_STORAGE_KEY = 'lite-ide:git:image-diff-mode'

function fileExtension(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

export function isImageFile(relPath: string): boolean {
  return fileExtension(relPath) in IMAGE_EXT_MIME
}

export function isSvgFile(relPath: string): boolean {
  return fileExtension(relPath) === 'svg'
}

export function imageMimeForPath(relPath: string): string {
  return IMAGE_EXT_MIME[fileExtension(relPath)] ?? 'application/octet-stream'
}

export function base64ToDataUrl(base64: string, relPath: string): string {
  return `data:${imageMimeForPath(relPath)};base64,${base64}`
}

/**
 * Estimates the decoded byte length of a standard base64 string without
 * allocating a buffer.
 */
export function estimateBase64ByteLength(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  let padding = 0
  if (base64.endsWith('==')) padding = 2
  else if (base64.endsWith('=')) padding = 1
  return Math.max(0, Math.floor((len * 3) / 4) - padding)
}

export function readStoredImageDiffMode(): ImageDiffMode {
  if (typeof localStorage === 'undefined') return 'side-by-side'
  try {
    const stored = localStorage.getItem(IMAGE_DIFF_MODE_STORAGE_KEY)
    if (
      stored === 'side-by-side' ||
      stored === 'swipe' ||
      stored === 'onion' ||
      stored === 'difference'
    ) {
      return stored
    }
    return 'side-by-side'
  } catch {
    return 'side-by-side'
  }
}

export function writeStoredImageDiffMode(mode: ImageDiffMode): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(IMAGE_DIFF_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

export interface PixelDiffResult {
  width: number
  height: number
  diffPixels: number
  totalPixels: number
  diffPercent: number
  imageData: ImageData
}

/**
 * Computes a pixel-by-pixel visual difference between two loaded images.
 * Changed pixels are highlighted in vivid magenta; unchanged pixels are
 * rendered as a dimmed grayscale backdrop so spatial context stays clear.
 */
export function computePixelDiff(
  oldImg: HTMLImageElement,
  newImg: HTMLImageElement,
): PixelDiffResult | null {
  const oldW = oldImg.naturalWidth || 0
  const oldH = oldImg.naturalHeight || 0
  const newW = newImg.naturalWidth || 0
  const newH = newImg.naturalHeight || 0
  const width = Math.max(oldW, newW)
  const height = Math.max(oldH, newH)
  if (width === 0 || height === 0) return null

  const canvasA = document.createElement('canvas')
  canvasA.width = width
  canvasA.height = height
  const ctxA = canvasA.getContext('2d', { willReadFrequently: true })
  if (!ctxA) return null

  const canvasB = document.createElement('canvas')
  canvasB.width = width
  canvasB.height = height
  const ctxB = canvasB.getContext('2d', { willReadFrequently: true })
  if (!ctxB) return null

  try {
    ctxA.clearRect(0, 0, width, height)
    ctxA.drawImage(oldImg, 0, 0, oldW, oldH)
    ctxB.clearRect(0, 0, width, height)
    ctxB.drawImage(newImg, 0, 0, newW, newH)

    const dataA = ctxA.getImageData(0, 0, width, height).data
    const dataB = ctxB.getImageData(0, 0, width, height).data
    const out = ctxA.createImageData(width, height)
    const dst = out.data

    const totalPixels = width * height
    let diffPixels = 0

    for (let i = 0; i < dataA.length; i += 4) {
      const dr = Math.abs(dataA[i] - dataB[i])
      const dg = Math.abs(dataA[i + 1] - dataB[i + 1])
      const db = Math.abs(dataA[i + 2] - dataB[i + 2])
      const da = Math.abs(dataA[i + 3] - dataB[i + 3])

      if (dr > 0 || dg > 0 || db > 0 || da > 0) {
        diffPixels += 1
        // Highlight changed pixels in vivid magenta-red, scaled subtly by delta.
        const delta = Math.max(dr, dg, db, da)
        const alpha = Math.min(255, Math.max(170, delta + 140))
        dst[i] = 244
        dst[i + 1] = 63
        dst[i + 2] = 94
        dst[i + 3] = alpha
      } else {
        // Dimmed grayscale backdrop for unchanged pixels.
        const lum = Math.round(0.299 * dataB[i] + 0.587 * dataB[i + 1] + 0.114 * dataB[i + 2])
        dst[i] = lum
        dst[i + 1] = lum
        dst[i + 2] = lum
        dst[i + 3] = Math.round(dataB[i + 3] * 0.28)
      }
    }

    return {
      width,
      height,
      diffPixels,
      totalPixels,
      diffPercent: totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0,
      imageData: out,
    }
  } catch {
    return null
  }
}
