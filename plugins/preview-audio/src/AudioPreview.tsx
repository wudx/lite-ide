import type { PreviewProps } from '@lite-ide/kernel'
import { getWorkspaceFileUrl } from '@lite-ide/protocol'
import { formatBytes, getI18n, WorkspaceBackendKey } from '@lite-ide/workbench'
import AudioLines from 'lucide-solid/icons/audio-lines'
import Pause from 'lucide-solid/icons/pause'
import Play from 'lucide-solid/icons/play'
import Repeat from 'lucide-solid/icons/repeat'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Volume1 from 'lucide-solid/icons/volume-1'
import Volume2 from 'lucide-solid/icons/volume-2'
import VolumeX from 'lucide-solid/icons/volume-x'
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js'
import {
  clampNumber,
  computeWaveformPeaks,
  formatAudioTime,
  formatSampleRate,
  PLAYBACK_RATES,
  readStoredVolume,
  WAVEFORM_BAR_COUNT,
  writeStoredVolume,
} from './audio-utils'

const MAX_WAVEFORM_BYTES = 25 * 1024 * 1024

interface DecodedAudioInfo {
  peaks: number[]
  sampleRate: number
  channels: number
}

export default function AudioPreview(props: PreviewProps) {
  const backend = props.scope.get(WorkspaceBackendKey)
  const i18n = getI18n(props.scope)

  const [playing, setPlaying] = createSignal(false)
  const [currentTime, setCurrentTime] = createSignal(0)
  const [duration, setDuration] = createSignal(0)
  const [volume, setVolume] = createSignal(readStoredVolume())
  const [muted, setMuted] = createSignal(false)
  const [loop, setLoop] = createSignal(false)
  const [playbackRate, setPlaybackRate] = createSignal<number>(1)
  const [audioError, setAudioError] = createSignal(false)
  const [seeking, setSeeking] = createSignal(false)
  const [decodedInfo, setDecodedInfo] = createSignal<DecodedAudioInfo | null>(null)

  let audioEl: HTMLAudioElement | undefined
  let trackEl: HTMLDivElement | undefined

  const audioUrl = createMemo(() => {
    const base = getWorkspaceFileUrl(props.scope.id, props.file.relPath, backend)
    if (base.startsWith('data:') || base.startsWith('blob:')) return base
    return `${base}?v=${props.file.modifiedMs}`
  })

  const progress = createMemo(() => {
    const total = duration()
    if (!Number.isFinite(total) || total <= 0) return 0
    return clampNumber(currentTime() / total, 0, 1)
  })

  const showTenths = createMemo(() => {
    const total = duration()
    return Number.isFinite(total) && total > 0 && total < 10
  })

  const formatLabel = createMemo(() => {
    const ext = props.file.ext.trim().toUpperCase()
    return ext || 'AUDIO'
  })

  // Reset player state and extract optional waveform peaks whenever the target file changes.
  createEffect(
    on(
      () => `${props.scope.id}:${props.file.relPath}:${props.file.modifiedMs}`,
      () => {
        if (audioEl) {
          audioEl.pause()
          audioEl.currentTime = 0
        }
        setPlaying(false)
        setCurrentTime(0)
        setDuration(0)
        setAudioError(false)
        setSeeking(false)
        setDecodedInfo(null)

        const url = audioUrl()
        const fileSize = props.file.size
        if (fileSize <= 0 || fileSize > MAX_WAVEFORM_BYTES || typeof AudioContext === 'undefined') {
          return
        }

        const controller = new AbortController()
        let audioCtx: AudioContext | null = null

        void (async () => {
          try {
            const response = await fetch(url, { signal: controller.signal })
            if (!response.ok || controller.signal.aborted) return
            const arrayBuffer = await response.arrayBuffer()
            if (controller.signal.aborted) return

            audioCtx = new AudioContext()
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
            if (controller.signal.aborted) return

            const channels: Float32Array[] = []
            for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
              channels.push(audioBuffer.getChannelData(ch))
            }

            const peaks = computeWaveformPeaks(channels, WAVEFORM_BAR_COUNT)
            setDecodedInfo({
              peaks,
              sampleRate: audioBuffer.sampleRate,
              channels: audioBuffer.numberOfChannels,
            })

            if (duration() === 0 && Number.isFinite(audioBuffer.duration)) {
              setDuration(audioBuffer.duration)
            }
          } catch {
            // Waveform decoding is progressive enhancement; native <audio> playback still works.
          } finally {
            if (audioCtx) {
              void audioCtx.close().catch(() => {})
            }
          }
        })()

        onCleanup(() => {
          controller.abort()
          if (audioCtx) {
            void audioCtx.close().catch(() => {})
          }
        })
      },
    ),
  )

  // Keep native <audio> properties synchronized with reactive controls.
  createEffect(() => {
    if (!audioEl) return
    audioEl.volume = volume()
    audioEl.muted = muted()
    audioEl.loop = loop()
    audioEl.playbackRate = playbackRate()
  })

  onCleanup(() => {
    audioEl?.pause()
  })

  function seekTo(seconds: number) {
    const total = duration()
    if (!audioEl || !Number.isFinite(total) || total <= 0) return
    const next = clampNumber(seconds, 0, total)
    audioEl.currentTime = next
    setCurrentTime(next)
  }

  function seekFromPointer(clientX: number) {
    if (!trackEl) return
    const total = duration()
    if (!Number.isFinite(total) || total <= 0) return
    const rect = trackEl.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = clampNumber((clientX - rect.left) / rect.width, 0, 1)
    seekTo(ratio * total)
  }

  function togglePlay() {
    if (!audioEl || audioError()) return
    if (audioEl.paused) {
      if (duration() > 0 && audioEl.currentTime >= duration()) {
        audioEl.currentTime = 0
        setCurrentTime(0)
      }
      void audioEl.play().catch(() => {
        setPlaying(false)
      })
    } else {
      audioEl.pause()
    }
  }

  function restartAudio() {
    if (!audioEl || audioError()) return
    seekTo(0)
    if (audioEl.paused) {
      void audioEl.play().catch(() => {
        setPlaying(false)
      })
    }
  }

  function updateVolume(next: number) {
    const clamped = clampNumber(next, 0, 1)
    setVolume(clamped)
    if (clamped > 0 && muted()) {
      setMuted(false)
    }
    writeStoredVolume(clamped)
  }

  function toggleMute() {
    setMuted((prev) => !prev)
  }

  function onTrackPointerDown(e: PointerEvent) {
    if (e.button !== 0 || audioError()) return
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    setSeeking(true)
    seekFromPointer(e.clientX)
  }

  function onTrackPointerMove(e: PointerEvent) {
    if (!seeking()) return
    seekFromPointer(e.clientX)
  }

  function onTrackPointerUp(e: PointerEvent) {
    if (!seeking()) return
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId)
    }
    setSeeking(false)
  }

  function onTrackKeyDown(e: KeyboardEvent) {
    const total = duration()
    if (!Number.isFinite(total) || total <= 0) return
    const step = total < 10 ? total * 0.1 : 5
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      seekTo(currentTime() + step)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      seekTo(currentTime() - step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      seekTo(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      seekTo(total)
    }
  }

  function onRootKeyDown(e: KeyboardEvent) {
    if (e.code !== 'Space' || e.repeat) return
    const target = e.target as HTMLElement | null
    if (
      target instanceof HTMLButtonElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return
    }
    e.preventDefault()
    togglePlay()
  }

  return (
    <div
      role="region"
      aria-label={i18n.t('previewAudio.regionLabel', { name: props.file.name })}
      tabIndex={-1}
      class="flex-1 min-h-0 relative flex items-center justify-center p-6 outline-none animate-fade-up"
      onKeyDown={onRootKeyDown}
    >
      {/* Top-left floating metadata pill (matches ImagePreview HUD) */}
      <div class="pointer-events-none absolute top-3.5 left-4 z-10 flex items-center gap-2 glass-pill rounded-full px-3 py-1 text-[11px] text-[var(--text-secondary)] tabular-nums">
        <span class="font-mono font-medium text-[var(--text-primary)]">{formatLabel()}</span>
        <span class="text-[var(--divider)]">·</span>
        <span>{props.file.mime}</span>
        <span class="text-[var(--divider)]">·</span>
        <span>{formatBytes(props.file.size)}</span>
        <Show when={decodedInfo()}>
          {(info) => (
            <>
              <Show when={info().sampleRate > 0}>
                <span class="text-[var(--divider)]">·</span>
                <span>{formatSampleRate(info().sampleRate)}</span>
              </Show>
              <Show when={info().channels > 0}>
                <span class="text-[var(--divider)]">·</span>
                <span>
                  {info().channels === 1
                    ? i18n.t('previewAudio.mono')
                    : info().channels === 2
                      ? i18n.t('previewAudio.stereo')
                      : i18n.t('previewAudio.channels', { count: info().channels })}
                </span>
              </Show>
            </>
          )}
        </Show>
      </div>

      {/* Native audio element handles streaming, HTTP Range seeking, and codec decoding */}
      <audio
        ref={(el) => {
          audioEl = el
          el.volume = volume()
          el.muted = muted()
          el.loop = loop()
          el.playbackRate = playbackRate()
        }}
        src={audioUrl()}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d >= 0) {
            setDuration(d)
          }
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d >= 0) {
            setDuration(d)
          }
        }}
        onTimeUpdate={(e) => {
          if (!seeking()) {
            setCurrentTime(e.currentTarget.currentTime)
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          if (duration() > 0) {
            setCurrentTime(duration())
          }
        }}
        onError={() => {
          setPlaying(false)
          setAudioError(true)
        }}
      />

      {/* Centered player card */}
      <div class="w-full max-w-xl rounded-2xl border border-[var(--border-panel)] bg-[var(--bg-surface)]/80 p-6 shadow-[var(--shadow-panel)] space-y-5">
        {/* Track header */}
        <div class="flex items-center gap-3.5 min-w-0">
          <div class="w-11 h-11 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-center shrink-0">
            <AudioLines
              class={`w-5 h-5 text-[var(--accent)] ${playing() ? 'animate-pulse' : ''}`}
            />
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-semibold text-[var(--text-primary)] truncate leading-normal">
              {props.file.name}
            </h2>
            <p class="text-xs text-[var(--text-secondary)] truncate leading-normal">
              {props.file.relPath}
            </p>
          </div>
          <div class="shrink-0 font-mono text-xs text-[var(--text-primary)] tabular-nums">
            {formatAudioTime(currentTime(), showTenths())}
            <span class="text-[var(--text-muted)]">
              {' '}
              / {formatAudioTime(duration(), showTenths())}
            </span>
          </div>
        </div>

        <Show
          when={!audioError()}
          fallback={
            <div class="px-4 py-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-xs text-[var(--danger-text)]">
              {i18n.t('previewAudio.loadError', {
                path: props.file.relPath,
                mime: props.file.mime,
              })}
            </div>
          }
        >
          {/* Interactive waveform / progress seek track */}
          <div
            ref={(el) => (trackEl = el)}
            role="slider"
            tabIndex={0}
            aria-label={i18n.t('previewAudio.playbackPosition')}
            aria-valuemin={0}
            aria-valuemax={Number(duration().toFixed(2))}
            aria-valuenow={Number(currentTime().toFixed(2))}
            aria-valuetext={i18n.t('previewAudio.playbackProgress', {
              current: formatAudioTime(currentTime(), showTenths()),
              total: formatAudioTime(duration(), showTenths()),
            })}
            class="h-20 px-3 rounded-xl bg-[var(--bg-inset)] border border-[var(--border-subtle)] flex items-center cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-focus)]"
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerUp}
            onKeyDown={onTrackKeyDown}
          >
            <Show
              when={decodedInfo()?.peaks.length}
              fallback={
                <div class="w-full h-2 rounded-full bg-[var(--bg-hover-strong)] overflow-hidden">
                  <div
                    class="h-full rounded-full bg-[var(--accent)] transition-[width] duration-75"
                    style={{ width: `${(progress() * 100).toFixed(2)}%` }}
                  />
                </div>
              }
            >
              <div class="w-full h-14 flex items-center gap-[3px]">
                <For each={decodedInfo()?.peaks ?? []}>
                  {(peak, idx) => {
                    const barRatio = () => (idx() + 0.5) / WAVEFORM_BAR_COUNT
                    const isPlayed = () => progress() > 0 && barRatio() <= progress()
                    return (
                      <span
                        class={`flex-1 rounded-full transition-colors duration-100 ${
                          isPlayed()
                            ? 'bg-[var(--accent)]'
                            : 'bg-[var(--text-muted)]/35 hover:bg-[var(--text-muted)]/55'
                        }`}
                        style={{ height: `${Math.round(peak * 100)}%` }}
                      />
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* Transport & secondary controls */}
          <div class="flex flex-wrap items-center justify-between gap-3">
            {/* Primary playback transport */}
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={playing() ? i18n.t('previewAudio.pause') : i18n.t('previewAudio.play')}
                title={
                  playing()
                    ? i18n.t('previewAudio.pauseShortcut')
                    : i18n.t('previewAudio.playShortcut')
                }
                class="h-9 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-foreground)] shadow-[0_2px_10px_var(--accent-glow)] active:scale-[0.98] flex items-center gap-1.5 text-xs font-medium transition-all duration-150"
                onClick={togglePlay}
              >
                <Show when={playing()} fallback={<Play class="w-3.5 h-3.5 fill-current" />}>
                  <Pause class="w-3.5 h-3.5 fill-current" />
                </Show>
                <span>{playing() ? i18n.t('previewAudio.pause') : i18n.t('previewAudio.play')}</span>
              </button>

              <button
                type="button"
                aria-label={i18n.t('previewAudio.restart')}
                title={i18n.t('previewAudio.restart')}
                class="h-9 w-9 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors"
                onClick={restartAudio}
              >
                <RotateCcw class="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                aria-label={i18n.t('previewAudio.toggleLoop')}
                aria-pressed={loop()}
                title={i18n.t('previewAudio.loopTitle')}
                class={`h-9 w-9 rounded-xl border flex items-center justify-center transition-colors ${
                  loop()
                    ? 'bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => setLoop((prev) => !prev)}
              >
                <Repeat class="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Speed selector */}
            <div
              role="group"
              aria-label={i18n.t('previewAudio.playbackSpeed')}
              class="flex items-center gap-0.5 bg-[var(--bg-inset)] p-0.5 rounded-lg border border-[var(--border-subtle)]"
            >
              <For each={PLAYBACK_RATES}>
                {(rate) => (
                  <button
                    type="button"
                    aria-pressed={playbackRate() === rate}
                    class={`px-2 py-1 rounded-md text-[11px] font-mono tabular-nums transition-colors ${
                      playbackRate() === rate
                        ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-panel)] shadow-sm'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-transparent'
                    }`}
                    onClick={() => setPlaybackRate(rate)}
                  >
                    {rate}x
                  </button>
                )}
              </For>
            </div>

            {/* Volume & mute */}
            <div class="flex items-center gap-2">
              <button
                type="button"
                aria-label={
                  muted() || volume() === 0
                    ? i18n.t('previewAudio.unmute')
                    : i18n.t('previewAudio.mute')
                }
                aria-pressed={muted() || volume() === 0}
                title={
                  muted() || volume() === 0
                    ? i18n.t('previewAudio.unmute')
                    : i18n.t('previewAudio.mute')
                }
                class="h-8 w-8 rounded-lg hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-colors"
                onClick={toggleMute}
              >
                <Show
                  when={!muted() && volume() > 0}
                  fallback={<VolumeX class="w-4 h-4 text-[var(--text-muted)]" />}
                >
                  <Show when={volume() >= 0.5} fallback={<Volume1 class="w-4 h-4" />}>
                    <Volume2 class="w-4 h-4" />
                  </Show>
                </Show>
              </button>
              <input
                type="range"
                aria-label={i18n.t('previewAudio.volume')}
                min={0}
                max={1}
                step={0.01}
                value={muted() ? 0 : volume()}
                onInput={(e) => updateVolume(Number(e.currentTarget.value))}
                class="w-20 accent-[var(--accent)] cursor-pointer"
              />
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
