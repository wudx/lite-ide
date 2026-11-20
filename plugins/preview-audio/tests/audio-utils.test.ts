import { createAppKernel } from '@lite-ide/kernel'
import type { FileMeta } from '@lite-ide/protocol'
import { isAudioExtension } from '@lite-ide/workbench'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUDIO_VOLUME_STORAGE_KEY,
  clampNumber,
  computeWaveformPeaks,
  formatAudioTime,
  formatSampleRate,
  readStoredVolume,
  writeStoredVolume,
} from '../src/audio-utils'
import { previewAudioPlugin } from '../src/index'

function makeFileMeta(ext: string, isBinary = true): FileMeta {
  return {
    projectId: 'p1',
    relPath: `assets/test.${ext}`,
    name: `test.${ext}`,
    ext,
    size: 1024,
    modifiedMs: 1700000000000,
    mime: 'audio/wav',
    isBinary,
    encoding: 'binary',
  }
}

describe('audio-utils', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('recognizes supported audio extensions case-insensitively', () => {
    for (const ext of [
      'mp3',
      'WAV',
      'ogg',
      'oga',
      'opus',
      'flac',
      'aac',
      'm4a',
      'weba',
      'aiff',
      'aif',
    ]) {
      expect(isAudioExtension(ext)).toBe(true)
    }
    expect(isAudioExtension('ts')).toBe(false)
    expect(isAudioExtension('png')).toBe(false)
    expect(isAudioExtension('mp4')).toBe(false)
  })

  it('formats audio durations with and without tenths', () => {
    expect(formatAudioTime(-1)).toBe('0:00')
    expect(formatAudioTime(Number.NaN)).toBe('0:00')
    expect(formatAudioTime(0)).toBe('0:00')
    expect(formatAudioTime(65.4)).toBe('1:05')
    expect(formatAudioTime(3661)).toBe('1:01:01')
    expect(formatAudioTime(0.76, true)).toBe('0:00.8')
    expect(formatAudioTime(9.94, true)).toBe('0:09.9')
  })

  it('formats sample rate', () => {
    expect(formatSampleRate(44100)).toBe('44.1 kHz')
    expect(formatSampleRate(48000)).toBe('48 kHz')
    expect(formatSampleRate(0)).toBe('')
  })

  it('clamps values and persists volume in localStorage', () => {
    expect(clampNumber(1.5, 0, 1)).toBe(1)
    expect(clampNumber(-0.2, 0, 1)).toBe(0)
    expect(clampNumber(Number.NaN, 0, 1)).toBe(0)

    expect(readStoredVolume()).toBe(0.85)
    writeStoredVolume(0.42)
    expect(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY)).toBe('0.42')
    expect(readStoredVolume()).toBe(0.42)

    localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, 'not-a-number')
    expect(readStoredVolume()).toBe(0.85)
  })

  it('computes normalized waveform peaks across channels', () => {
    expect(computeWaveformPeaks([], 8)).toEqual([])
    expect(computeWaveformPeaks([new Float32Array(0)], 8)).toEqual([])

    const silent = computeWaveformPeaks([new Float32Array(32)], 4)
    expect(silent).toEqual([0.08, 0.08, 0.08, 0.08])

    const left = new Float32Array([0.2, 0.2, 0.5, 0.5, -1.0, -0.5, 0.0, 0.0])
    const right = new Float32Array([0.1, 0.1, 0.8, 0.1, 0.2, 0.2, 0.0, 0.0])
    const peaks = computeWaveformPeaks([left, right], 4)
    expect(peaks).toHaveLength(4)
    expect(peaks[0]).toBeCloseTo(0.2, 2)
    expect(peaks[1]).toBeCloseTo(0.8, 2)
    expect(peaks[2]).toBe(1)
    expect(peaks[3]).toBe(0.08)
  })
})

describe('previewAudioPlugin', () => {
  it('registers preview-audio provider with priority 60 for audio files', () => {
    const kernel = createAppKernel({
      host: {
        async open(rootPath) {
          return { info: { id: 'p1', name: 'demo', rootPath } }
        },
      },
    })

    kernel.registerPlugin(previewAudioPlugin)
    const providers = kernel.contributions('previewer.provider')()
    const audioProvider = providers.find((p) => p.id === 'preview-audio')

    expect(audioProvider).toBeDefined()
    expect(audioProvider?.label).toBe('Audio')
    expect(audioProvider?.priority).toBe(60)
    expect(audioProvider?.canHandle(makeFileMeta('wav'))).toBe(true)
    expect(audioProvider?.canHandle(makeFileMeta('mp3'))).toBe(true)
    expect(audioProvider?.canHandle(makeFileMeta('png'))).toBe(false)
    expect(audioProvider?.canHandle(makeFileMeta('ts', false))).toBe(false)

    kernel.dispose()
  })
})
