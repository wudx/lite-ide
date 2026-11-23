import { formatBytes, getI18n } from '@lite-ide/workbench'
import type { ProjectScope } from '@lite-ide/kernel'
import Maximize2 from 'lucide-solid/icons/maximize-2'
import MoveHorizontal from 'lucide-solid/icons/move-horizontal'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import ZoomIn from 'lucide-solid/icons/zoom-in'
import ZoomOut from 'lucide-solid/icons/zoom-out'
import { createEffect, createMemo, createSignal, Match, on, Show, Switch } from 'solid-js'
import {
  base64ToDataUrl,
  computePixelDiff,
  estimateBase64ByteLength,
  type ImageDiffMode,
} from './image-diff'

export interface GitDiffImageProps {
  scope: ProjectScope
  relPath: string
  mode: ImageDiffMode
  oldBase64: string | null
  newBase64: string | null
  oldLabel: string
  newLabel: string
}

interface ImageDimensions {
  w: number
  h: number
}

export default function GitDiffImage(props: GitDiffImageProps) {
  const i18n = getI18n(props.scope)

  const [scale, setScale] = createSignal(1)
  const [fitMode, setFitMode] = createSignal(true)
  const [offset, setOffset] = createSignal({ x: 0, y: 0 })
  const [panning, setPanning] = createSignal(false)

  const [swipePct, setSwipePct] = createSignal(50)
  const [draggingSwipe, setDraggingSwipe] = createSignal(false)
  const [onionOpacity, setOnionOpacity] = createSignal(0.5)

  const [oldDims, setOldDims] = createSignal<ImageDimensions | null>(null)
  const [newDims, setNewDims] = createSignal<ImageDimensions | null>(null)
  const [oldError, setOldError] = createSignal(false)
  const [newError, setNewError] = createSignal(false)

  const [diffSummary, setDiffSummary] = createSignal<{
    diffPixels: number
    totalPixels: number
    diffPercent: number
  } | null>(null)
  const [diffComputeFailed, setDiffComputeFailed] = createSignal(false)

  let oldImgRef: HTMLImageElement | undefined
  let newImgRef: HTMLImageElement | undefined
  let diffCanvasRef: HTMLCanvasElement | undefined
  let swipeViewportRef: HTMLDivElement | undefined

  let dragOrigin = { x: 0, y: 0 }
  let startOffset = { x: 0, y: 0 }

  const oldUrl = createMemo(() =>
    props.oldBase64 ? base64ToDataUrl(props.oldBase64, props.relPath) : null,
  )
  const newUrl = createMemo(() =>
    props.newBase64 ? base64ToDataUrl(props.newBase64, props.relPath) : null,
  )

  const oldBytes = createMemo(() =>
    props.oldBase64 !== null ? estimateBase64ByteLength(props.oldBase64) : null,
  )
  const newBytes = createMemo(() =>
    props.newBase64 !== null ? estimateBase64ByteLength(props.newBase64) : null,
  )

  const bothPresent = createMemo(() => oldUrl() !== null && newUrl() !== null)

  // Reset transient state when switching files or snapshots.
  createEffect(
    on(
      () => [props.relPath, props.oldBase64, props.newBase64],
      () => {
        setFitMode(true)
        setScale(1)
        setOffset({ x: 0, y: 0 })
        setOldDims(null)
        setNewDims(null)
        setOldError(false)
        setNewError(false)
        setDiffSummary(null)
        setDiffComputeFailed(false)
      },
    ),
  )

  // Compute pixel difference whenever both images are loaded and difference mode is active.
  createEffect(() => {
    if (props.mode !== 'difference') return
    const oDims = oldDims()
    const nDims = newDims()
    if (!oDims || !nDims || !oldImgRef || !newImgRef) return

    const result = computePixelDiff(oldImgRef, newImgRef)
    if (!result) {
      setDiffSummary(null)
      setDiffComputeFailed(true)
      return
    }
    setDiffComputeFailed(false)
    setDiffSummary({
      diffPixels: result.diffPixels,
      totalPixels: result.totalPixels,
      diffPercent: result.diffPercent,
    })

    if (diffCanvasRef) {
      diffCanvasRef.width = result.width
      diffCanvasRef.height = result.height
      const ctx = diffCanvasRef.getContext('2d')
      ctx?.putImageData(result.imageData, 0, 0)
    }
  })

  function zoomBy(factor: number) {
    setFitMode(false)
    setScale((prev) => Math.max(0.1, Math.min(12, Number((prev * factor).toFixed(2)))))
  }

  function resetToActualSize() {
    setFitMode(false)
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  function resetToFit() {
    setFitMode(true)
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? 1.15 : 0.87)
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || draggingSwipe()) return
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    setPanning(true)
    dragOrigin = { x: e.clientX, y: e.clientY }
    startOffset = offset()
  }

  function onPointerMove(e: PointerEvent) {
    if (!panning()) return
    setOffset({
      x: startOffset.x + (e.clientX - dragOrigin.x),
      y: startOffset.y + (e.clientY - dragOrigin.y),
    })
  }

  function onPointerUp(e: PointerEvent) {
    if (!panning()) return
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId)
    }
    setPanning(false)
  }

  function updateSwipeFromClientX(clientX: number) {
    if (!swipeViewportRef) return
    const rect = swipeViewportRef.getBoundingClientRect()
    if (rect.width <= 0) return
    const pct = ((clientX - rect.left) / rect.width) * 100
    setSwipePct(Math.max(0, Math.min(100, Number(pct.toFixed(2)))))
  }

  function onSwipeHandleDown(e: PointerEvent) {
    if (e.button !== 0) return
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    setDraggingSwipe(true)
    updateSwipeFromClientX(e.clientX)
  }

  function onSwipeHandleMove(e: PointerEvent) {
    if (!draggingSwipe()) return
    e.stopPropagation()
    updateSwipeFromClientX(e.clientX)
  }

  function onSwipeHandleUp(e: PointerEvent) {
    if (!draggingSwipe()) return
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    if (target.hasPointerCapture(e.pointerId)) {
      target.releasePointerCapture(e.pointerId)
    }
    setDraggingSwipe(false)
  }

  const transformStyle = () => ({
    transform: `translate(${offset().x}px, ${offset().y}px) scale(${fitMode() ? 1 : scale()})`,
  })

  const imgClass = () =>
    fitMode()
      ? 'max-w-[88%] max-h-[85%] object-contain rounded-lg shadow-[var(--shadow-image)]'
      : 'max-w-none rounded-lg shadow-[var(--shadow-image)]'

  const renderSideCard = (side: 'old' | 'new') => {
    const url = () => (side === 'old' ? oldUrl() : newUrl())
    const dims = () => (side === 'old' ? oldDims() : newDims())
    const bytes = () => (side === 'old' ? oldBytes() : newBytes())
    const hasError = () => (side === 'old' ? oldError() : newError())
    const label = () => (side === 'old' ? props.oldLabel : props.newLabel)

    return (
      <div
        data-testid={`git-diff-image-${side}`}
        class="w-1/2 min-w-0 min-h-0 flex flex-col border-r last:border-r-0 border-[var(--border-subtle)]"
      >
        <div class="shrink-0 px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] flex items-center justify-between gap-2 text-[11px]">
          <span
            class={`font-medium ${
              side === 'old' ? 'text-[var(--diff-del-text)]' : 'text-[var(--diff-add-text)]'
            }`}
          >
            {label()}
          </span>
          <span class="font-mono text-[10.5px] text-[var(--text-muted)] tabular-nums truncate">
            <Show when={dims()}>
              {(d) => <span>{`${d().w} × ${d().h} px · `}</span>}
            </Show>
            <Show when={bytes() !== null}>
              <span>{formatBytes(bytes()!)}</span>
            </Show>
          </span>
        </div>

        <div
          class={`flex-1 min-h-0 overflow-hidden flex items-center justify-center git-diff-checkerboard select-none ${
            panning() ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <Show
            when={url()}
            fallback={
              <div class="px-4 py-3 rounded-xl border border-dashed border-[var(--border-panel)] bg-[var(--bg-surface)]/80 text-xs text-[var(--text-muted)]">
                {side === 'old' ? i18n.t('git.diff.image.added') : i18n.t('git.diff.image.deleted')}
              </div>
            }
          >
            {(src) => (
              <Show
                when={!hasError()}
                fallback={
                  <div class="px-4 py-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-xs text-[var(--danger-text)]">
                    {i18n.t('git.diff.image.decodeError')}
                  </div>
                }
              >
                <img
                  src={src()}
                  alt={`${props.relPath} (${label()})`}
                  draggable={false}
                  class={imgClass()}
                  style={transformStyle()}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    const d = { w: img.naturalWidth, h: img.naturalHeight }
                    if (side === 'old') setOldDims(d)
                    else setNewDims(d)
                  }}
                  onError={() => {
                    if (side === 'old') setOldError(true)
                    else setNewError(true)
                  }}
                />
              </Show>
            )}
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="git-diff-image" data-image-diff-mode={props.mode} class="flex-1 min-h-0 relative flex flex-col">
      {/* Hidden preloaded image elements used for pixel difference computation when not in side-by-side */}
      <Show when={props.mode === 'difference'}>
        <div class="hidden" aria-hidden="true">
          <Show when={oldUrl()}>
            {(src) => (
              <img
                ref={oldImgRef}
                src={src()}
                alt=""
                onLoad={(e) => {
                  const img = e.currentTarget
                  setOldDims({ w: img.naturalWidth, h: img.naturalHeight })
                }}
                onError={() => setOldError(true)}
              />
            )}
          </Show>
          <Show when={newUrl()}>
            {(src) => (
              <img
                ref={newImgRef}
                src={src()}
                alt=""
                onLoad={(e) => {
                  const img = e.currentTarget
                  setNewDims({ w: img.naturalWidth, h: img.naturalHeight })
                }}
                onError={() => setNewError(true)}
              />
            )}
          </Show>
        </div>
      </Show>

      <Switch>
        {/* Side-by-Side mode (also handles single-sided added/deleted cleanly) */}
        <Match when={props.mode === 'side-by-side' || !bothPresent()}>
          <div class="flex-1 min-h-0 flex">
            {renderSideCard('old')}
            {renderSideCard('new')}
          </div>
        </Match>

        {/* Swipe (curtain) mode */}
        <Match when={props.mode === 'swipe'}>
          <div
            ref={swipeViewportRef}
            class={`flex-1 min-h-0 relative overflow-hidden git-diff-checkerboard select-none ${
              panning() ? 'cursor-grabbing' : 'cursor-grab'
            }`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* Left half (old) */}
            <div
              class="absolute inset-0 flex items-center justify-center pointer-events-none"
              style={{ 'clip-path': `inset(0 ${100 - swipePct()}% 0 0)` }}
            >
              <img
                src={oldUrl()!}
                alt={`${props.relPath} (${props.oldLabel})`}
                draggable={false}
                class={imgClass()}
                style={transformStyle()}
                onLoad={(e) => {
                  const img = e.currentTarget
                  setOldDims({ w: img.naturalWidth, h: img.naturalHeight })
                }}
              />
            </div>

            {/* Right half (new) */}
            <div
              class="absolute inset-0 flex items-center justify-center pointer-events-none"
              style={{ 'clip-path': `inset(0 0 0 ${swipePct()}%)` }}
            >
              <img
                src={newUrl()!}
                alt={`${props.relPath} (${props.newLabel})`}
                draggable={false}
                class={imgClass()}
                style={transformStyle()}
                onLoad={(e) => {
                  const img = e.currentTarget
                  setNewDims({ w: img.naturalWidth, h: img.naturalHeight })
                }}
              />
            </div>

            {/* Corner labels */}
            <div class="pointer-events-none absolute top-3 left-3 z-10 px-2.5 py-0.5 rounded-full glass-pill text-[11px] font-medium text-[var(--diff-del-text)]">
              {props.oldLabel}
            </div>
            <div class="pointer-events-none absolute top-3 right-3 z-10 px-2.5 py-0.5 rounded-full glass-pill text-[11px] font-medium text-[var(--diff-add-text)]">
              {props.newLabel}
            </div>

            {/* Draggable divider */}
            <div
              role="slider"
              aria-label={i18n.t('git.diff.image.swipeHandle')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(swipePct())}
              data-testid="git-diff-image-swipe-handle"
              class="absolute top-0 bottom-0 z-20 w-5 -ml-2.5 flex items-center justify-center cursor-ew-resize group"
              style={{ left: `${swipePct()}%` }}
              onPointerDown={onSwipeHandleDown}
              onPointerMove={onSwipeHandleMove}
              onPointerUp={onSwipeHandleUp}
              onPointerCancel={onSwipeHandleUp}
            >
              <div class="w-0.5 h-full bg-[var(--accent)] shadow-[0_0_8px_rgba(0,0,0,0.45)]" />
              <div class="absolute w-7 h-7 rounded-full bg-[var(--bg-surface)] border border-[var(--accent)] shadow-md flex items-center justify-center text-[var(--accent)] group-hover:scale-110 transition-transform">
                <MoveHorizontal class="w-3.5 h-3.5" />
              </div>
            </div>
          </div>
        </Match>

        {/* Onion-skin (opacity overlay) mode */}
        <Match when={props.mode === 'onion'}>
          <div
            class={`flex-1 min-h-0 relative overflow-hidden git-diff-checkerboard select-none flex items-center justify-center ${
              panning() ? 'cursor-grabbing' : 'cursor-grab'
            }`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              src={oldUrl()!}
              alt={`${props.relPath} (${props.oldLabel})`}
              draggable={false}
              class={`absolute ${imgClass()}`}
              style={transformStyle()}
              onLoad={(e) => {
                const img = e.currentTarget
                setOldDims({ w: img.naturalWidth, h: img.naturalHeight })
              }}
            />
            <img
              src={newUrl()!}
              alt={`${props.relPath} (${props.newLabel})`}
              draggable={false}
              class={`relative ${imgClass()}`}
              style={{
                ...transformStyle(),
                opacity: onionOpacity(),
              }}
              onLoad={(e) => {
                const img = e.currentTarget
                setNewDims({ w: img.naturalWidth, h: img.naturalHeight })
              }}
            />

            <div class="pointer-events-none absolute top-3 left-3 z-10 px-2.5 py-0.5 rounded-full glass-pill text-[11px] text-[var(--text-secondary)] tabular-nums">
              {`${props.oldLabel} ⇄ ${props.newLabel} (${Math.round(onionOpacity() * 100)}%)`}
            </div>
          </div>
        </Match>

        {/* Pixel difference mode */}
        <Match when={props.mode === 'difference'}>
          <div
            class={`flex-1 min-h-0 relative overflow-hidden git-diff-checkerboard select-none flex items-center justify-center ${
              panning() ? 'cursor-grabbing' : 'cursor-grab'
            }`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <Show
              when={!diffComputeFailed()}
              fallback={
                <div class="px-4 py-3 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] text-xs text-[var(--danger-text)]">
                  {i18n.t('git.diff.image.decodeError')}
                </div>
              }
            >
              <canvas
                ref={diffCanvasRef}
                data-testid="git-diff-image-diff-canvas"
                class={imgClass()}
                style={transformStyle()}
              />
            </Show>

            <Show when={diffSummary()}>
              {(summary) => (
                <div
                  data-testid="git-diff-image-pixel-stats"
                  class="pointer-events-none absolute top-3 left-3 z-10 px-2.5 py-1 rounded-full glass-pill text-[11px] text-[var(--text-secondary)] tabular-nums"
                >
                  {summary().diffPixels === 0
                    ? i18n.t('git.diff.image.identicalPixels')
                    : i18n.t('git.diff.image.pixelStats', {
                        count: summary().diffPixels.toLocaleString(),
                        percent: summary().diffPercent.toFixed(2),
                      })}
                </div>
              )}
            </Show>
          </div>
        </Match>
      </Switch>

      {/* Bottom floating zoom & mode-specific HUD */}
      <div class="absolute bottom-3.5 left-1/2 -translate-x-1/2 z-30 glass-pill rounded-full px-2.5 py-1 flex items-center gap-1 text-xs shadow-lg">
        <Show when={props.mode === 'onion' && bothPresent()}>
          <div class="flex items-center gap-1.5 pr-1.5 mr-1 border-r border-[var(--divider)]">
            <span class="text-[10.5px] text-[var(--text-secondary)] whitespace-nowrap">
              {i18n.t('git.diff.image.opacity')}
            </span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(onionOpacity() * 100)}
              aria-label={i18n.t('git.diff.image.opacity')}
              class="w-20 accent-[var(--accent)] cursor-pointer"
              onInput={(e) => setOnionOpacity(Number(e.currentTarget.value) / 100)}
            />
          </div>
        </Show>

        <button
          type="button"
          title={i18n.t('git.diff.image.zoomOut')}
          class="p-1.5 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          onClick={() => zoomBy(0.8)}
        >
          <ZoomOut class="w-3.5 h-3.5" />
        </button>
        <span class="w-12 text-center font-mono text-[11px] text-[var(--text-primary)] tabular-nums select-none">
          {fitMode() ? i18n.t('git.diff.image.fit') : `${Math.round(scale() * 100)}%`}
        </span>
        <button
          type="button"
          title={i18n.t('git.diff.image.zoomIn')}
          class="p-1.5 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          onClick={() => zoomBy(1.25)}
        >
          <ZoomIn class="w-3.5 h-3.5" />
        </button>

        <span class="mx-0.5 h-3.5 w-px bg-[var(--divider)]" />

        <button
          type="button"
          class={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
            !fitMode() && scale() === 1
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
          onClick={resetToActualSize}
        >
          100%
        </button>
        <button
          type="button"
          title={i18n.t('git.diff.image.fitToViewport')}
          class={`p-1.5 rounded-full transition-colors ${
            fitMode()
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
          onClick={resetToFit}
        >
          <Maximize2 class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title={i18n.t('git.diff.image.resetPan')}
          class="p-1.5 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          onClick={() => setOffset({ x: 0, y: 0 })}
        >
          <RotateCcw class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
