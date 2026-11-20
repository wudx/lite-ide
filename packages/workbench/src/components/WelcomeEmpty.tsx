import type { AppKernel } from '@lite-ide/kernel'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Layers from 'lucide-solid/icons/layers'

export interface WelcomeEmptyProps {
  kernel: AppKernel
}

export function WelcomeEmpty(props: WelcomeEmptyProps) {
  return (
    <div class="flex-1 flex flex-col items-center justify-center bg-[var(--bg-editor)] text-[var(--text-primary)] px-6 select-none">
      <div class="max-w-md w-full flex flex-col items-center text-center gap-5">
        <div class="w-14 h-14 rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-center shadow-lg">
          <Layers class="w-7 h-7 text-[var(--accent)]" />
        </div>

        <div class="space-y-1.5">
          <h1 class="text-lg font-semibold tracking-tight">LiteIDE</h1>
          <p class="text-xs text-[var(--text-secondary)] leading-relaxed">
            Lightweight micro-kernel workbench. Open one or more project folders — each opens in its own isolated top tab.
          </p>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--accent)] hover:brightness-110 text-slate-950 font-medium text-xs transition-all cursor-pointer shadow"
          onClick={() => void props.kernel.executeCommand('workbench.openProject')}
        >
          <FolderOpen class="w-4 h-4" />
          <span>Open Project Folder</span>
        </button>

        <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-[11px] text-[var(--text-muted)] pt-2">
          <div class="flex items-center justify-between gap-3">
            <span>Open Project</span>
            <kbd class="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              Ctrl+O
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span>Close Tab</span>
            <kbd class="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              Ctrl+W
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span>Toggle Sidebar</span>
            <kbd class="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              Ctrl+B
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <span>Switch Project</span>
            <kbd class="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              Ctrl+Tab
            </kbd>
          </div>
        </div>
      </div>
    </div>
  )
}
