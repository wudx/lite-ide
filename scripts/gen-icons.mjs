import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const iconsDir = path.resolve(import.meta.dirname, '..', 'src-tauri', 'icons')
fs.mkdirSync(iconsDir, { recursive: true })

// CRC32 lookup table for PNG chunks
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crcTable[n] = c >>> 0
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  const combined = Buffer.concat([typeBuf, data])
  crcBuf.writeUInt32BE(crc32(combined), 0)
  return Buffer.concat([len, combined, crcBuf])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  const compressed = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

function encodeBmpDibForIco(width, height, rgba) {
  const andRowBytes = Math.ceil(width / 32) * 4
  const xorSize = width * height * 4
  const andSize = andRowBytes * height
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(width, 4) // biWidth
  header.writeInt32LE(height * 2, 8) // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20)

  const xor = Buffer.alloc(xorSize)
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const s = (srcY * width + x) * 4
      const d = (y * width + x) * 4
      xor[d] = rgba[s + 2] // B
      xor[d + 1] = rgba[s + 1] // G
      xor[d + 2] = rgba[s] // R
      xor[d + 3] = rgba[s + 3] // A
    }
  }
  const andMask = Buffer.alloc(andSize, 0)
  return Buffer.concat([header, xor, andMask])
}

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = 1 (ICO)
  header.writeUInt16LE(entries.length, 4)

  const dirEntries = []
  let offset = 6 + entries.length * 16
  for (const entry of entries) {
    const dir = Buffer.alloc(16)
    dir[0] = entry.width >= 256 ? 0 : entry.width
    dir[1] = entry.height >= 256 ? 0 : entry.height
    dir[2] = 0
    dir[3] = 0
    dir.writeUInt16LE(1, 4) // planes
    dir.writeUInt16LE(32, 6) // bpp
    dir.writeUInt32LE(entry.data.length, 8)
    dir.writeUInt32LE(offset, 12)
    dirEntries.push(dir)
    offset += entry.data.length
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.data)])
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r
  const qy = Math.abs(py) - by + r
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inn = Math.min(Math.max(qx, qy), 0)
  return out + inn - r
}

function blendPixel(buf, idx, r, g, b, a) {
  const srcA = clamp01(a)
  if (srcA <= 0) return
  const dstA = buf[idx + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) return
  const outR = (r * srcA + buf[idx] * dstA * (1 - srcA)) / outA
  const outG = (g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA
  const outB = (b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA
  buf[idx] = Math.round(outR)
  buf[idx + 1] = Math.round(outG)
  buf[idx + 2] = Math.round(outB)
  buf[idx + 3] = Math.round(outA * 255)
}

function renderIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4, 0)
  const aa = 1.5 / size

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Normalized coords in [-1, 1]
      const nx = ((x + 0.5) / size) * 2 - 1
      const ny = ((y + 0.5) / size) * 2 - 1
      const idx = (y * size + x) * 4

      // Outer rounded squircle container
      const dOuter = sdRoundedBox(nx, ny, 0.86, 0.86, 0.28)
      const outerAlpha = 1 - smoothstep(-aa, aa, dOuter)
      if (outerAlpha <= 0) continue

      // Deep slate-indigo gradient background
      const gradT = clamp01((nx + ny + 1.8) / 3.6)
      const bgR = 24 + gradT * 14
      const bgG = 28 + gradT * 18
      const bgB = 46 + gradT * 30
      blendPixel(buf, idx, bgR, bgG, bgB, outerAlpha)

      // Subtle inner border glow
      const borderMask = smoothstep(-0.04, -0.005, dOuter) * (1 - smoothstep(-0.005, aa, dOuter))
      blendPixel(buf, idx, 110, 168, 254, borderMask * 0.35 * outerAlpha)

      // Top tab pill bar accent
      const dTopBar = sdRoundedBox(nx, ny + 0.48, 0.56, 0.08, 0.04)
      const topBarAlpha = 1 - smoothstep(-aa, aa, dTopBar)
      blendPixel(buf, idx, 56, 189, 248, topBarAlpha * 0.28)

      // Active project tab pill on top-left
      const dTab1 = sdRoundedBox(nx + 0.34, ny + 0.48, 0.2, 0.055, 0.03)
      const tab1Alpha = 1 - smoothstep(-aa, aa, dTab1)
      blendPixel(buf, idx, 56, 189, 248, tab1Alpha * 0.95)

      // Second project tab pill
      const dTab2 = sdRoundedBox(nx - 0.14, ny + 0.48, 0.18, 0.05, 0.03)
      const tab2Alpha = 1 - smoothstep(-aa, aa, dTab2)
      blendPixel(buf, idx, 148, 163, 184, tab2Alpha * 0.45)

      // Left sidebar pane (file tree representation)
      const dLeft = sdRoundedBox(nx + 0.37, ny - 0.14, 0.19, 0.38, 0.06)
      const leftAlpha = 1 - smoothstep(-aa, aa, dLeft)
      blendPixel(buf, idx, 38, 46, 69, leftAlpha * 0.95)

      // Sidebar file rows
      for (let row = 0; row < 3; row++) {
        const ry = -0.06 + row * 0.17
        const rw = row === 1 ? 0.11 : 0.13
        const rx = -0.39 + (row === 1 ? 0.02 : 0)
        const dRow = sdRoundedBox(nx - rx, ny - ry, rw, 0.03, 0.015)
        const rowA = 1 - smoothstep(-aa, aa, dRow)
        if (row === 1) {
          blendPixel(buf, idx, 56, 189, 248, rowA * 0.9)
        } else {
          blendPixel(buf, idx, 148, 163, 184, rowA * 0.55)
        }
      }

      // Right preview pane
      const dRight = sdRoundedBox(nx - 0.22, ny - 0.14, 0.34, 0.38, 0.06)
      const rightAlpha = 1 - smoothstep(-aa, aa, dRight)
      blendPixel(buf, idx, 30, 36, 56, rightAlpha * 0.95)

      // Code lines inside right preview pane
      const lines = [
        { x: 0.14, y: -0.07, w: 0.16, color: [129, 140, 248] },
        { x: 0.21, y: 0.09, w: 0.21, color: [56, 189, 248] },
        { x: 0.19, y: 0.25, w: 0.18, color: [52, 211, 153] },
        { x: 0.12, y: 0.4, w: 0.11, color: [148, 163, 184] },
      ]
      for (const l of lines) {
        const dLine = sdRoundedBox(nx - l.x, ny - l.y, l.w, 0.032, 0.016)
        const lA = 1 - smoothstep(-aa, aa, dLine)
        blendPixel(buf, idx, l.color[0], l.color[1], l.color[2], lA * 0.95)
      }
    }
  }

  return buf
}

const rgba32 = renderIconRgba(32)
const rgba128 = renderIconRgba(128)
const rgba256 = renderIconRgba(256)

const png32 = encodePng(32, 32, rgba32)
const png128 = encodePng(128, 128, rgba128)
const png256 = encodePng(256, 256, rgba256)

fs.writeFileSync(path.join(iconsDir, '32x32.png'), png32)
fs.writeFileSync(path.join(iconsDir, '128x128.png'), png128)
fs.writeFileSync(path.join(iconsDir, '128x128@2x.png'), png256)

const ico = encodeIco([
  { width: 32, height: 32, data: encodeBmpDibForIco(32, 32, rgba32) },
  { width: 128, height: 128, data: png128 },
  { width: 256, height: 256, data: png256 },
])
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico)

console.log('Generated LiteIDE icons in:', iconsDir)
