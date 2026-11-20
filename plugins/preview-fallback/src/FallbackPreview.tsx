import type { PreviewProps } from '@lite-ide/kernel'
import { formatBytes } from '@lite-ide/workbench'
import FileWarning from 'lucide-solid/icons/file-exclamation-point'

export default function FallbackPreview(props: PreviewProps) {
  const modifiedAt = () => {
    if (!props.file.modifiedMs) return 'Unknown'
    return new Date(props.file.modifiedMs).toLocaleString()
  }

  return (
    <div class="flex-1 flex items-center justify-center p-6 animate-fade-up">
      <div class="max-w-md w-full rounded-2xl border border-[var(--border-panel)] bg-[var(--bg-surface)]/70 p-6 shadow-[var(--shadow-panel)] space-y-5">
        <div class="flex items-center gap-3.5">
          <div class="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
            <FileWarning class="w-5 h-5 text-amber-400" />
          </div>
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-[var(--text-primary)] truncate leading-normal">
              {props.file.name}
            </h2>
            <p class="text-xs text-[var(--text-secondary)]">
              {props.file.isBinary
                ? 'Binary file cannot be displayed in the text previewer'
                : 'File metadata inspection'}
            </p>
          </div>
        </div>

        <dl class="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)] text-xs">
          <div class="py-2.5 grid grid-cols-[100px_1fr] gap-3 items-baseline">
            <dt class="text-[var(--text-muted)]">Path</dt>
            <dd class="font-mono text-[var(--text-primary)] break-all">{props.file.relPath}</dd>
          </div>

          <div class="py-2.5 grid grid-cols-[100px_1fr] gap-3 items-baseline">
            <dt class="text-[var(--text-muted)]">Size</dt>
            <dd class="font-mono text-[var(--text-primary)] tabular-nums">
              {formatBytes(props.file.size)} ({props.file.size.toLocaleString()} bytes)
            </dd>
          </div>

          <div class="py-2.5 grid grid-cols-[100px_1fr] gap-3 items-baseline">
            <dt class="text-[var(--text-muted)]">MIME Type</dt>
            <dd class="font-mono text-[var(--text-primary)]">{props.file.mime}</dd>
          </div>

          <div class="py-2.5 grid grid-cols-[100px_1fr] gap-3 items-baseline">
            <dt class="text-[var(--text-muted)]">Encoding</dt>
            <dd class="font-mono uppercase text-[var(--text-primary)]">{props.file.encoding}</dd>
          </div>

          <div class="pt-2.5 grid grid-cols-[100px_1fr] gap-3 items-baseline">
            <dt class="text-[var(--text-muted)]">Modified</dt>
            <dd class="text-[var(--text-primary)] tabular-nums">{modifiedAt()}</dd>
          </div>
        </dl>
      </div>
    </div>
  )
}
