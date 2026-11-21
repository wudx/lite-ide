import type { AppKernel } from '@lite-ide/kernel'
import FolderPlus from 'lucide-solid/icons/folder-plus'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import { createSignal, For, Show } from 'solid-js'
import { WorkspaceBackendKey } from '../services'
import { getI18n } from '../i18n'
import { PluginRegistryKey, type ExternalPluginState } from '../plugin-registry'

export interface PluginSettingsProps {
  kernel: AppKernel
}

const ghostButtonClass =
  'h-[28px] px-2.5 rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 disabled:pointer-events-none'

function statusBadgeClass(status: ExternalPluginState['status']): string {
  if (status === 'running') return 'text-[var(--success-text)]'
  if (status === 'error') return 'text-[var(--danger-text)]'
  return 'text-[var(--text-muted)]'
}

export function PluginSettings(props: PluginSettingsProps) {
  const registry = props.kernel.tryGet(PluginRegistryKey)
  const backend = props.kernel.tryGet(WorkspaceBackendKey)
  const i18n = getI18n(props.kernel)

  const [opError, setOpError] = createSignal<string | null>(null)
  const [busyId, setBusyId] = createSignal<string | null>(null)
  // Two-click confirm for uninstalling; null = none armed.
  const [uninstallArmedId, setUninstallArmedId] = createSignal<string | null>(null)

  if (!registry) return null

  const isDesktop = backend?.kind === 'tauri'
  const installedIds = () => new Set(registry.states().map((s) => s.manifest.id))
  const catalogEntries = () => registry.catalog().filter((c) => !installedIds().has(c.manifest.id))

  async function run(op: string, fn: () => Promise<void>): Promise<void> {
    setOpError(null)
    setBusyId(op)
    try {
      await fn()
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function pickAndInstallFromFolder(): Promise<void> {
    // 浏览器演示模式无本地文件夹可选取（isDesktop 已隐藏入口）。
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: i18n.t('plugins.installFromFolderTitle'),
    })
    if (typeof selected !== 'string' || selected.length === 0) return
    await run('install-from-path', () => registry!.installFromPath(selected))
  }

  function uninstallPlugin(state: ExternalPluginState) {
    const id = state.manifest.id
    if (uninstallArmedId() !== id) {
      setUninstallArmedId(id)
      return
    }
    setUninstallArmedId(null)
    void run(`uninstall:${id}`, () => registry!.uninstall(id))
  }

  return (
    <div class="space-y-4">
      <section>
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-xs font-semibold text-[var(--text-primary)] leading-normal">
            {i18n.t('plugins.heading')}
          </h3>
          <Show when={isDesktop && registry.supported}>
            <button
              type="button"
              class={`${ghostButtonClass} inline-flex items-center gap-1.5`}
              disabled={busyId() !== null}
              onClick={() => void pickAndInstallFromFolder()}
            >
              <FolderPlus class="w-3.5 h-3.5" />
              {i18n.t('plugins.installFromFolder')}
            </button>
          </Show>
        </div>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 mb-3 leading-relaxed">
          {i18n.t('plugins.description')}
        </p>

        <Show when={!registry.supported}>
          <p class="text-[11px] text-[var(--warning-text)] leading-relaxed">
            {i18n.t('plugins.unsupported')}
          </p>
        </Show>

        <Show when={opError()}>
          <div class="mb-3 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11px] text-[var(--danger-text)] leading-relaxed">
            {i18n.t('plugins.opFailed', { message: opError()! })}
          </div>
        </Show>

        <Show when={registry.supported}>
          {/* 可安装目录（内置示例；已安装的条目自动隐藏） */}
          <Show when={catalogEntries().length > 0}>
            <h4 class="text-[11px] font-medium text-[var(--text-secondary)] mb-2 leading-normal">
              {i18n.t('plugins.catalog.heading')}
            </h4>
            <div class="space-y-2 mb-4">
              <For each={catalogEntries()}>
                {(entry) => (
                  <div class="rounded-xl border border-[var(--border-panel)] bg-[var(--bg-subtle)] px-3 py-2.5 flex items-center justify-between gap-3">
                    <div class="min-w-0">
                      <div class="text-[11.5px] font-medium text-[var(--text-primary)] leading-normal truncate">
                        {entry.manifest.name}
                        <span class="ml-1.5 font-normal text-[var(--text-muted)]">
                          v{entry.manifest.version}
                        </span>
                      </div>
                      <Show when={entry.manifest.description}>
                        <p class="text-[11px] text-[var(--text-muted)] mt-0.5 truncate leading-normal">
                          {entry.manifest.description}
                        </p>
                      </Show>
                    </div>
                    <button
                      type="button"
                      data-testid={`plugin-catalog-install-${entry.manifest.id}`}
                      class="h-[26px] px-2.5 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[11px] text-[var(--accent)] hover:bg-[var(--bg-active-strong)] transition-colors disabled:opacity-50 disabled:pointer-events-none shrink-0"
                      disabled={busyId() !== null}
                      onClick={() =>
                        void run(`catalog:${entry.manifest.id}`, () =>
                          registry!.installFromCatalog(entry.manifest.id),
                        )
                      }
                    >
                      {busyId() === `catalog:${entry.manifest.id}`
                        ? i18n.t('plugins.installing')
                        : i18n.t('plugins.install')}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* 已安装列表 */}
          <h4 class="text-[11px] font-medium text-[var(--text-secondary)] mb-2 leading-normal">
            {i18n.t('plugins.installed.heading')}
          </h4>
          <Show
            when={registry.states().length > 0}
            fallback={
              <p class="text-[11px] text-[var(--text-muted)] leading-relaxed">
                {i18n.t('plugins.installed.empty')}
              </p>
            }
          >
            <div class="space-y-2">
              <For each={registry.states()}>
                {(state) => {
                  const id = state.manifest.id
                  const isUninstallArmed = () => uninstallArmedId() === id
                  return (
                    <div class="rounded-xl border border-[var(--border-panel)] bg-[var(--bg-subtle)] px-3 py-2.5">
                      <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                          <div class="text-[11.5px] font-medium text-[var(--text-primary)] leading-normal truncate">
                            {state.manifest.name}
                            <span class="ml-1.5 font-normal text-[var(--text-muted)]">
                              v{state.manifest.version}
                            </span>
                            <Show when={state.embedded}>
                              <span
                                class="ml-1.5 rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-1 py-px text-[10px] text-[var(--accent)]"
                                data-testid={`plugin-embedded-${id}`}
                              >
                                {i18n.t('plugins.embedded')}
                              </span>
                            </Show>
                            <span
                              class={`ml-2 ${statusBadgeClass(state.status)}`}
                              data-testid={`plugin-status-${id}`}
                            >
                              {i18n.t(`plugins.status.${state.status}`)}
                            </span>
                          </div>
                          <p class="text-[11px] text-[var(--text-muted)] mt-0.5 truncate leading-normal">
                            {id}
                            <Show when={state.manifest.author}>
                              <span> · {state.manifest.author}</span>
                            </Show>
                          </p>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <Show
                            when={state.status === 'running'}
                            fallback={
                              <button
                                type="button"
                                data-testid={`plugin-enable-${id}`}
                                class={`${ghostButtonClass} h-[26px]`}
                                disabled={busyId() !== null || state.status === 'error'}
                                title={i18n.t('plugins.action.enable')}
                                onClick={() =>
                                  void run(`enable:${id}`, () => registry!.setEnabled(id, true))
                                }
                              >
                                {i18n.t('plugins.action.enable')}
                              </button>
                            }
                          >
                            <button
                              type="button"
                              data-testid={`plugin-disable-${id}`}
                              class={`${ghostButtonClass} h-[26px]`}
                              disabled={busyId() !== null}
                              onClick={() =>
                                void run(`disable:${id}`, () => registry!.setEnabled(id, false))
                              }
                            >
                              {i18n.t('plugins.action.disable')}
                            </button>
                          </Show>
                          <Show when={state.status === 'error'}>
                            <button
                              type="button"
                              class={`${ghostButtonClass} h-[26px] inline-flex items-center gap-1`}
                              disabled={busyId() !== null}
                              title={i18n.t('plugins.action.reload')}
                              onClick={() => void run(`reload:${id}`, () => registry!.reload(id))}
                            >
                              <RotateCcw class="w-3 h-3" />
                            </button>
                          </Show>
                          {/* 嵌入式内置插件随应用分发：只可停用，不可卸载。 */}
                          <Show
                            when={!state.embedded}
                            fallback={
                              <span
                                class="h-[26px] px-2.5 inline-flex items-center text-[11px] text-[var(--text-muted)]"
                                title={i18n.t('plugins.embeddedHint')}
                              >
                                {i18n.t('plugins.embeddedHint')}
                              </span>
                            }
                          >
                            <button
                              type="button"
                              data-testid={`plugin-uninstall-${id}`}
                              class={`h-[26px] px-2.5 rounded-lg border text-[11px] transition-colors disabled:opacity-50 disabled:pointer-events-none ${
                                isUninstallArmed()
                                  ? 'border-[var(--danger-border)] bg-[var(--danger-btn-bg)] text-[var(--danger-text)]'
                                  : 'border-[var(--border-panel)] bg-transparent text-[var(--text-secondary)] hover:text-[var(--danger-text)] hover:bg-[var(--danger-bg)]'
                              }`}
                              disabled={busyId() !== null}
                              onClick={() => uninstallPlugin(state)}
                            >
                              {isUninstallArmed()
                                ? i18n.t('plugins.action.uninstallConfirm')
                                : i18n.t('plugins.action.uninstall')}
                            </button>
                          </Show>
                        </div>
                      </div>
                      <Show when={state.error}>
                        <p class="mt-1.5 text-[11px] text-[var(--danger-text)] leading-relaxed break-all">
                          {state.error}
                        </p>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>

          <Show when={registry.rootPath()}>
            <p class="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed break-all">
              {i18n.t('plugins.rootPath', { path: registry.rootPath()! })}
            </p>
          </Show>
        </Show>
      </section>
    </div>
  )
}
