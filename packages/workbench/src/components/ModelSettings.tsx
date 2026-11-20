import type { AppKernel } from '@lite-ide/kernel'
import Check from 'lucide-solid/icons/check'
import Eye from 'lucide-solid/icons/eye'
import EyeOff from 'lucide-solid/icons/eye-off'
import Loader2 from 'lucide-solid/icons/loader-circle'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import { createSignal, For, Show } from 'solid-js'
import { AiModelKey } from '../ai-model'
import { getI18n } from '../i18n'

export interface ModelSettingsProps {
  kernel: AppKernel
}

const inputClass =
  'w-full h-[28px] px-2.5 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] outline-none text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] leading-normal'

const fieldLabelClass = 'text-[11px] font-medium text-[var(--text-secondary)] leading-normal'

export function ModelSettings(props: ModelSettingsProps) {
  const ai = props.kernel.tryGet(AiModelKey)
  const i18n = getI18n(props.kernel)

  const [showApiKey, setShowApiKey] = createSignal(false)
  const [testState, setTestState] = createSignal<{
    status: 'testing' | 'ok' | 'fail'
    message?: string
  } | null>(null)

  if (!ai) return null

  const activeProvider = () => ai.providerId()
  const activeConfig = () => ai.providers()[activeProvider()]
  const activePreset = () => ai.presetOf(activeProvider())

  function update(patch: { apiKey?: string; baseUrl?: string; model?: string }) {
    ai!.updateProvider(activeProvider(), patch)
  }

  async function runConnectionTest() {
    if (testState()?.status === 'testing') return
    setTestState({ status: 'testing' })
    try {
      if (!ai!.isConfigured()) {
        throw new Error(i18n.t('settings.models.noApiKey'))
      }
      await ai!.chat({
        system: 'You are a connectivity probe. Reply with exactly: OK',
        user: 'ping',
      })
      setTestState({ status: 'ok' })
    } catch (err) {
      setTestState({
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div class="space-y-4">
      <section>
        <h3 class="text-xs font-semibold text-[var(--text-primary)] leading-normal">
          {i18n.t('settings.models.heading')}
        </h3>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 mb-3 leading-relaxed">
          {i18n.t('settings.models.description')}
        </p>

        <div class="space-y-2">
          <For each={ai.presets}>
            {(preset) => {
              const isActive = () => activeProvider() === preset.id
              return (
                <button
                  type="button"
                  data-testid={`ai-provider-${preset.id}`}
                  aria-pressed={isActive()}
                  class={`w-full rounded-xl border px-3 py-2.5 text-left flex items-center justify-between gap-3 transition-all duration-150 active:scale-[0.99] ${
                    isActive()
                      ? 'border-[var(--accent-border)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border-panel)] bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
                  }`}
                  onClick={() => {
                    setTestState(null)
                    ai!.setProviderId(preset.id)
                  }}
                >
                  <div class="min-w-0">
                    <div
                      class={`text-xs truncate leading-normal ${
                        isActive()
                          ? 'text-[var(--text-primary)] font-medium'
                          : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      {preset.label}
                    </div>
                    <div class="text-[10.5px] text-[var(--text-muted)] truncate font-mono leading-normal">
                      {ai.providers()[preset.id]?.model || preset.defaultModel}
                    </div>
                  </div>
                  <Show when={isActive()}>
                    <Check class="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  </Show>
                </button>
              )
            }}
          </For>
        </div>
      </section>

      <section class="space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <span class={fieldLabelClass}>{i18n.t('settings.models.apiKey')}</span>
          <button
            type="button"
            title={
              showApiKey()
                ? i18n.t('settings.models.hideApiKey')
                : i18n.t('settings.models.showApiKey')
            }
            class="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            onClick={() => setShowApiKey((v) => !v)}
          >
            <Show when={showApiKey()} fallback={<Eye class="w-3.5 h-3.5" />}>
              <EyeOff class="w-3.5 h-3.5" />
            </Show>
          </button>
        </div>
        <input
          data-testid="ai-api-key"
          type={showApiKey() ? 'text' : 'password'}
          autocomplete="off"
          spellcheck={false}
          placeholder={i18n.t('settings.models.apiKeyPlaceholder')}
          value={activeConfig().apiKey}
          onInput={(e) => update({ apiKey: e.currentTarget.value })}
          class={inputClass}
        />
        <p class="text-[10.5px] text-[var(--text-muted)] leading-relaxed">
          {i18n.t('settings.models.apiKeyHint')}
        </p>

        <div class="grid grid-cols-[1fr_auto] items-end gap-2">
          <div class="space-y-1">
            <span class={fieldLabelClass}>{i18n.t('settings.models.model')}</span>
            <input
              data-testid="ai-model"
              type="text"
              list="ai-model-suggestions"
              spellcheck={false}
              placeholder={i18n.t('settings.models.modelPlaceholder')}
              value={activeConfig().model}
              onInput={(e) => update({ model: e.currentTarget.value })}
              class={inputClass}
            />
            <datalist id="ai-model-suggestions">
              <For each={activePreset().models}>
                {(model) => <option value={model} />}
              </For>
            </datalist>
          </div>
          <button
            type="button"
            title={i18n.t('settings.models.resetDefaultsTitle')}
            class="mb-[1px] h-[28px] px-2 rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-1.5"
            onClick={() => {
              setTestState(null)
              ai!.resetProvider(activeProvider())
            }}
          >
            <RotateCcw class="w-3 h-3" />
            <span>{i18n.t('settings.models.resetDefaults')}</span>
          </button>
        </div>

        <div class="space-y-1">
          <span class={fieldLabelClass}>{i18n.t('settings.models.baseUrl')}</span>
          <input
            data-testid="ai-base-url"
            type="text"
            spellcheck={false}
            value={activeConfig().baseUrl}
            onInput={(e) => update({ baseUrl: e.currentTarget.value })}
            class={`${inputClass} font-mono`}
          />
        </div>

        <div class="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            data-testid="ai-test-connection"
            class="h-[28px] px-3 rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5"
            disabled={testState()?.status === 'testing'}
            onClick={() => void runConnectionTest()}
          >
            <Show when={testState()?.status === 'testing'}>
              <Loader2 class="w-3 h-3 animate-spin text-[var(--accent)]" />
            </Show>
            <span>
              {testState()?.status === 'testing'
                ? i18n.t('settings.models.testing')
                : i18n.t('settings.models.testConnection')}
            </span>
          </button>
          <Show when={testState()}>
            {(state) => (
              <span
                data-testid="ai-test-result"
                class={`text-[11px] truncate leading-normal ${
                  state().status === 'ok'
                    ? 'text-[var(--accent)]'
                    : state().status === 'fail'
                      ? 'text-[var(--danger-text)]'
                      : 'text-[var(--text-muted)]'
                }`}
                title={state().message}
              >
                <Show
                  when={state().status !== 'fail'}
                  fallback={i18n.t('settings.models.testFailed', {
                    message: state().message ?? '',
                  })}
                >
                  {i18n.t('settings.models.testOk')}
                </Show>
              </span>
            )}
          </Show>
        </div>
      </section>

      <section>
        <h3 class="text-xs font-semibold text-[var(--text-primary)] leading-normal">
          {i18n.t('settings.models.commitPromptHeading')}
        </h3>
        <p class="text-[11px] text-[var(--text-muted)] mt-1 mb-2 leading-relaxed">
          {i18n.t('settings.models.commitPromptDescription')}
        </p>
        <textarea
          data-testid="ai-commit-prompt"
          rows={4}
          placeholder={i18n.t('settings.models.commitPromptPlaceholder')}
          value={ai.commitPrompt()}
          onInput={(e) => ai!.setCommitPrompt(e.currentTarget.value)}
          class="w-full resize-y rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] outline-none px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] leading-normal transition-all font-mono"
        />
      </section>
    </div>
  )
}
