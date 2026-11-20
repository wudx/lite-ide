export const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const
export const AUDIO_VOLUME_STORAGE_KEY = 'lite-ide.audio.volume.v1'
export const WAVEFORM_BAR_COUNT = 64

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function formatAudioTime(seconds: number, showTenths = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return showTenths ? '0:00.0' : '0:00'
  }

  if (showTenths) {
    const roundedTenths = Math.round(seconds * 10)
    const wholeSeconds = Math.floor(roundedTenths / 10)
    const tenths = roundedTenths % 10
    const mins = Math.floor(wholeSeconds / 60)
    const secs = wholeSeconds % 60
    return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`
  }

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function formatSampleRate(sampleRate: number): string {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return ''
  const khz = sampleRate / 1000
  const formatted = Number.isInteger(khz) ? String(khz) : khz.toFixed(1).replace(/\.0$/, '')
  return `${formatted} kHz`
}

/**
 * Downsamples decoded PCM channel arrays into normalized bar heights in [0.08, 1].
 */
export function computeWaveformPeaks(
  channels: readonly Float32Array[],
  barCount = WAVEFORM_BAR_COUNT,
): number[] {
  if (channels.length === 0 || barCount <= 0) return []
  const sampleCount = channels[0]?.length ?? 0
  if (sampleCount === 0) return []

  const rawPeaks = new Array<number>(barCount).fill(0)
  let globalMax = 0

  for (let i = 0; i < barCount; i++) {
    const start = Math.floor((i * sampleCount) / barCount)
    const end = Math.max(start + 1, Math.floor(((i + 1) * sampleCount) / barCount))
    let bucketMax = 0

    for (let ch = 0; ch < channels.length; ch++) {
      const data = channels[ch]
      if (!data) continue
      const limit = Math.min(end, data.length)
      // Stride over huge buffers so waveform generation stays sub-millisecond.
      const step = Math.max(1, Math.floor((limit - start) / 128))
      for (let idx = start; idx < limit; idx += step) {
        const amp = Math.abs(data[idx] ?? 0)
        if (amp > bucketMax) bucketMax = amp
      }
    }

    rawPeaks[i] = bucketMax
    if (bucketMax > globalMax) globalMax = bucketMax
  }

  if (globalMax <= 0) {
    return new Array<number>(barCount).fill(0.08)
  }

  return rawPeaks.map((peak) => Math.max(0.08, Number((peak / globalMax).toFixed(3))))
}

export function readStoredVolume(): number {
  if (typeof localStorage === 'undefined') return 0.85
  try {
    const raw = localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY)
    if (raw === null) return 0.85
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampNumber(parsed, 0, 1) : 0.85
  } catch {
    return 0.85
  }
}

export function writeStoredVolume(volume: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, String(clampNumber(volume, 0, 1)))
  } catch {
    // Ignore storage quota / privacy errors.
  }
}
