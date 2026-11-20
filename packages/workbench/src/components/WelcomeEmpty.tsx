import type { AppKernel } from '@lite-ide/kernel'
import FolderOpen from 'lucide-solid/icons/folder-open'
import { getI18n } from '../i18n'

export interface WelcomeEmptyProps {
  kernel: AppKernel
}

export function WelcomeEmpty(props: WelcomeEmptyProps) {
  const i18n = getI18n(props.kernel)

  return (
    <div class="flex-1 rounded-xl bg-[var(--bg-editor)] panel-card overflow-hidden relative flex flex-col items-center justify-center text-[var(--text-primary)] px-6 select-none">
      {/* Ambient backdrop glow */}
      <div
        class="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 52% 45% at 50% 40%, var(--welcome-glow), transparent 72%)',
        }}
      />

      <div class="relative max-w-md w-full flex flex-col items-center text-center gap-6 animate-fade-up">
        <img
          src="/icon.png"
          alt="LiteIDE"
          draggable={false}
          class="w-16 h-16 drop-shadow-[0_10px_32px_var(--accent-glow)]"
        />

        <div class="space-y-2">
          <h1 class="text-xl font-semibold tracking-tight text-[var(--text-primary)]">LiteIDE</h1>
          <p class="text-[12.5px] text-[var(--text-secondary)] leading-relaxed max-w-sm">
            {i18n.t('welcome.subtitle')}
          </p>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-foreground)] font-semibold text-xs transition-all duration-150 active:scale-[0.98] shadow-[0_6px_24px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.28)]"
          onClick={() => void props.kernel.executeCommand('workbench.openProject')}
        >
          <FolderOpen class="w-4 h-4" />
          <span>{i18n.t('welcome.openProjectFolder')}</span>
        </button>

        <div class="w-full grid grid-cols-2 gap-2.5 pt-2">
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>{i18n.t('welcome.shortcut.openProject')}</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+O
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>{i18n.t('welcome.shortcut.closeTab')}</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+W
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>{i18n.t('welcome.shortcut.toggleSidebar')}</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+B
            </kbd>
          </div>
          <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]">
            <span>{i18n.t('welcome.shortcut.switchProject')}</span>
            <kbd class="px-1.5 py-0.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border-panel)] shadow-[var(--shadow-kbd)] font-mono text-[10px] text-[var(--text-primary)]">
              Ctrl+Tab
            </kbd>
          </div>
        </div>
      </div>
    </div>
  )
}
