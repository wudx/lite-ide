import type { AppKernel } from '@lite-ide/kernel'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Layers from 'lucide-solid/icons/layers'

export interface WelcomeEmptyProps {
  kernel: AppKernel
}

export function WelcomeEmpty(props: WelcomeEmptyProps) {
  return (
    <div class="flex-1 rounded-xl bg-[var(--bg-editor)] panel-card overflow-hidden relative flex flex-col items-center justify-center text-[var(--text-primary)] px-6 select-none">
      {/* Ambient backdrop glow */}
      <div
        class="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 52% 45% at 50% 40%, rgba(122, 162, 255, 0.085), transparent 72%)',
        }}
      />

      <div class="relative max-w-md w-full flex flex-col items-center text-center gap-6 animate-fade-up">
        <div class="w-16 h-16 rounded-2xl bg-gradient-to-b from-white/[0.08] to-white/[0.02] border border-white/[0.11] flex items-center justify-center shadow-[0_12px_36px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.12)]">
          <div class="w-10 h-10 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent-border)] flex items-center justify-center">
            <Layers class="w-5 h-5 text-[var(--accent)]" />
          </div>
        </div>

        <div class="space-y-2">
          <h1 class="text-xl font-semibold tracking-tight text-[var(--text-primary)]">LiteIDE</h1>
          <p class="text-[12.5px] text-[var(--text-secondary)] leading-relaxed max-w-sm">
            Lightweight micro-kernel workbench. Open one or more project folders — each opens in its own isolated top tab.
          </p>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-foreground)] font-semibold text-xs transition-all duration-150 active:scale-[0.98] shadow-[0_6px_24px_rgba(122,162,255,0.32),inset_0_1px_0_rgba(255,255,255,0.28)]"
          onClick={() => void props.kernel.executeCommand('workbench.openProject')}
        >
          <FolderOpen class="w-4 h-4" />
          <span>Open Project Folder</span>
        </button>

        <div class="w-full grid grid-cols-2 gap-2.5 pt-2">
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.025] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>Open Project</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-white/[0.09] shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+O
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.025] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>Close Tab</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-white/[0.09] shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+W
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.025] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>Toggle Sidebar</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-white/[0.09] shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+B
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/[0.025] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>Switch Project</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-white/[0.09] shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+Tab
            </kbd>
          </div>
        </div>
      </div>
    </div>
  )
}
