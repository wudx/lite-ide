export const AUDIO_EXTS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aac',
  'm4a',
  'weba',
  'aiff',
  'aif',
])

export function isAudioExtension(ext: string): boolean {
  return AUDIO_EXTS.has(ext.trim().toLowerCase())
}
