import type { PreviewProps } from '@lite-ide/kernel'
import { formatBytes } from '@lite-ide/workbench'
import { FileWarning } from 'lucide-solid'

export default function FallbackPreview(props: PreviewProps) {
  const modifiedAt = () => {
    if (!props.file.modifiedMs) return 'Unknown'
    return new Date(props.file.modifiedMs).toLocaleString()
  }

  return (
    <div class="flex-1 flex items-center justify-center p-6">
      <div class="max-w-md w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-lg space-y-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg bg-[var(--bg-app)] border border-[var(--border-subtle)] flex items-center justify-center">
            <FileWarning class="w-5 h-5 text-amber-400" />
          </div>
          <div class="min-w-0">
            <h2 class="text-sm font-semibold text-[var(--text-primary)] truncate">
              {props.file.name}
            </h2>
            <p class="text-xs text-[var(--text-secondary)]">
              {props.file.isBinary
                ? 'Binary file cannot be displayed in the text previewer'
                : 'File metadata inspection'}
            </p>
          </div>
        </div>

        <dl class="grid grid-cols-[100px_1fr] gap-y-2 gap-x-3 text-xs border-t border-[var(--border-subtle)] pt-4">
          <dt class="text-[var(--text-muted)]">Path</dt>
          <dd class="font-mono text-[var(--text-primary)] break-all">{props.file.relPath}</dd>

          <dt class="text-[var(--text-muted)]">Size</dt>
          <dd class="font-mono text-[var(--text-primary)]">
            {formatBytes(props.file.size)} ({props.file.size.toLocaleString()} bytes)
          </dd>

          <dt class="text-[var(--text-muted)]">MIME Type</dt>
          <dd class="font-mono text-[var(--text-primary)]">{props.file.mime}</dd>

          <dt class="text-[var(--text-muted)]">Encoding</dt>
          <dd class="font-mono uppercase text-[var(--text-primary)]">{props.file.encoding}</dd>

          <dt class="text-[var(--text-muted)]">Modified</dt>
          <dd class="text-[var(--text-primary)]">{modifiedAt()}</dd>
        </dl>
      </div>
    </div>
  )
}
