import type { PreviewProps } from '@lite-ide/kernel'
import { getWorkspaceFileUrl } from '@lite-ide/protocol'
import { formatBytes, WorkspaceBackendKey } from '@lite-ide/workbench'
import Maximize2 from 'lucide-solid/icons/maximize-2'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import ZoomIn from 'lucide-solid/icons/zoom-in'
import ZoomOut from 'lucide-solid/icons/zoom-out'
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js'

export default function ImagePreview(props: PreviewProps) {
  const backend = props.scope.get(WorkspaceBackendKey)

  const [scale, setScale] = createSignal(1)
  const [fitMode, setFitMode] = createSignal(true)
  const [offset, setOffset] = createSignal({ x: 0, y: 0 })
  const [naturalSize, setNaturalSize] = createSignal<{ w: number; h: number } | null>(null)
  const [imgError, setImgError] = createSignal(false)
  const [panning, setPanning] = createSignal(false)

  let dragOrigin = { x: 0, y: 0 }
  let startOffset = { x: 0, y: 0 }

  // Reset zoom/pan when switching image files.
  createEffect(
    on(
      () => props.file.relPath,
      () => {
        setFitMode(true)
        setScale(1)
        setOffset({ x: 0, y: 0 })
        setNaturalSize(null)
        setImgError(false)
      },
    ),
  )

  const imageUrl = createMemo(() => {
    const base = getWorkspaceFileUrl(props.scope.id, props.file.relPath, backend)
    if (base.startsWith('data:') || base.startsWith('blob:')) return base
    return `${base}?v=${props.file.modifiedMs}`
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
    if (e.button !== 0) return
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

  return (
    <div class="flex-1 min-h-0 flex flex-col">
      {/* Toolbar */}
      <div class="h-[36px] shrink-0 px-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/40 flex items-center justify-between text-xs">
        <div class="flex items-center gap-3 text-[var(--text-secondary)]">
          <Show when={naturalSize()}>
            {(dim) => (
              <span class="font-mono">
                {dim().w} × {dim().h} px
              </span>
            )}
          </Show>
          <span>{props.file.mime}</span>
          <span>{formatBytes(props.file.size)}</span>
        </div>

        <div class="flex items-center gap-1">
          <button
            type="button"
            title="Zoom Out"
            class="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => zoomBy(0.8)}
          >
            <ZoomOut class="w-3.5 h-3.5" />
          </button>
          <span class="w-14 text-center font-mono text-[11px] text-[var(--text-primary)]">
            {fitMode() ? 'Fit' : `${Math.round(scale() * 100)}%`}
          </span>
          <button
            type="button"
            title="Zoom In"
            class="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => zoomBy(1.25)}
          >
            <ZoomIn class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            class={`px-2 py-1 rounded text-[11px] hover:bg-[var(--bg-hover)] ${
              !fitMode() && scale() === 1
                ? 'text-[var(--accent)]'
                : 'text-[var(--text-secondary)]'
            }`}
            onClick={resetToActualSize}
          >
            100%
          </button>
          <button
            type="button"
            title="Fit to Viewport"
            class={`p-1.5 rounded hover:bg-[var(--bg-hover)] ${
              fitMode() ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
            }`}
            onClick={resetToFit}
          >
            <Maximize2 class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Reset Pan"
            class="p-1.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => setOffset({ x: 0, y: 0 })}
          >
            <RotateCcw class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Interactive image viewport */}
      <div
        class={`flex-1 min-h-0 overflow-hidden flex items-center justify-center checkerboard-bg select-none ${
          panning() ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Show
          when={!imgError()}
          fallback={
            <div class="px-4 py-3 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-red-300">
              Unable to load image: {props.file.relPath}
            </div>
          }
        >
          <img
            src={imageUrl()}
            alt={props.file.name}
            draggable={false}
            class={fitMode() ? 'max-w-[90%] max-h-[90%] object-contain shadow-lg' : 'max-w-none shadow-lg'}
            style={{
              transform: `translate(${offset().x}px, ${offset().y}px) scale(${fitMode() ? 1 : scale()})`,
            }}
            onLoad={(e) => {
              const img = e.currentTarget
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
            }}
            onError={() => setImgError(true)}
          />
        </Show>
      </div>
    </div>
  )
}
