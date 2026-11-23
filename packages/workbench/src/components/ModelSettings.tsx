import type { AppKernel } from '@lite-ide/kernel'
import { formatErrorMessage } from '@lite-ide/protocol'
import Check from 'lucide-solid/icons/check'
import Eye from 'lucide-solid/icons/eye'
import EyeOff from 'lucide-solid/icons/eye-off'
import Loader2 from 'lucide-solid/icons/loader-circle'
import Plus from 'lucide-solid/icons/plus'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Trash from 'lucide-solid/icons/trash'
import { createSignal, For, Show } from 'solid-js'
import { AiModelKey } from '../ai-model'
import { getI18n } from '../i18n'

export interface ModelSettingsProps {
  kernel: AppKernel
}

const inputClass =
  'w-full h-[28px] px-2.5 rounded-lg bg-[var(--bg-inset)] border border-[var(--border-subtle)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-inset-focus)] outline-none text-[11.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] leading-normal'

const fieldLabelClass = 'text-[11px] font-medium text-[var(--text-secondary)] leading-normal'

const ghostButtonClass =
  'h-[28px] px-2.5 rounded-lg border border-[var(--border-panel)] bg-[var(--bg-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 disabled:pointer-events-none'

export function ModelSettings(props: ModelSettingsProps) {
  const ai = props.kernel.tryGet(AiModelKey)
  const i18n = getI18n(props.kernel)

  const [showApiKey, setShowApiKey] = createSignal(false)
  const [testState, setTestState] = createSignal<{
    status: 'testing' | 'ok' | 'fail'
    message?: string
  } | null>(null)
  const [showAddForm, setShowAddForm] = createSignal(false)
  const [customName, setCustomName] = createSignal('')
  const [customBaseUrl, setCustomBaseUrl] = createSignal('')
  const [customModel, setCustomModel] = createSignal('')
  // Two-click confirm for deleting custom providers; null = none armed.
  const [deleteArmedId, setDeleteArmedId] = createSignal<string | null>(null)

  if (!ai) return null

  const activeProvider = () => ai.providerId()
  const activeConfig = () => ai.providers()[activeProvider()]
  const activePreset = () => ai.presetOf(activeProvider())
  const canAddCustom = () =>
    customName().trim() !== '' && customBaseUrl().trim() !== '' && customModel().trim() !== ''

  function update(patch: { apiKey?: string; baseUrl?: string; model?: string }) {
    ai!.updateProvider(activeProvider(), patch)
  }

  function submitCustomProvider() {
    if (!canAddCustom()) return
    ai!.addCustomProvider({
      label: customName(),
      baseUrl: customBaseUrl(),
      model: customModel(),
    })
    setCustomName('')
    setCustomBaseUrl('')
    setCustomModel('')
    setShowAddForm(false)
    setTestState(null)
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
        message: formatErrorMessage(err),
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
          <For each={ai.presets()}>
            {(preset) => {
              const isActive = () => activeProvider() === preset.id
              const isDeleteArmed = () => deleteArmedId() === preset.id
              return (
                <div class="relative">
                  <button
                    type="button"
                    data-testid={`ai-provider-${preset.id}`}
                    aria-pressed={isActive()}
                    class={`w-full rounded-xl border px-3 py-2.5 text-left flex items-center justify-between gap-3 transition-all duration-150 active:scale-[0.99] ${
                      isActive()
                        ? 'border-[var(--accent-border)] bg-[var(--accent-soft)]'
                        : 'border-[var(--border-panel)] bg-[var(--bg-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]'
                    } ${preset.custom ? 'pr-10' : ''}`}
                    onClick={() => {
                      setTestState(null)
                      setDeleteArmedId(null)
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
                  <Show when={preset.custom}>
                    <button
                      type="button"
                      data-testid={`ai-delete-${preset.id}`}
                      title={
                        isDeleteArmed()
                          ? i18n.t('settings.models.deleteCustomConfirm')
                          : i18n.t('settings.models.deleteCustomTitle')
                      }
                      aria-label={
                        isDeleteArmed()
                          ? i18n.t('settings.models.deleteCustomConfirm')
                          : i18n.t('settings.models.deleteCustomTitle')
                      }
                      class={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md transition-colors hover:bg-[var(--bg-hover)] ${
                        isDeleteArmed()
                          ? 'text-[var(--danger-text)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (isDeleteArmed()) {
                          setDeleteArmedId(null)
                          setTestState(null)
                          ai!.removeCustomProvider(preset.id)
                        } else {
                          setDeleteArmedId(preset.id)
                        }
                      }}
                    >
                      <Trash class="w-3 h-3" />
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>

        <Show
          when={showAddForm()}
          fallback={
            <button
              type="button"
              data-testid="ai-add-custom"
              class="mt-2 w-full rounded-xl border border-dashed border-[var(--border-panel)] bg-transparent px-3 py-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors flex items-center justify-center gap-1.5"
              onClick={() => setShowAddForm(true)}
            >
              <Plus class="w-3.5 h-3.5" />
              <span>{i18n.t('settings.models.addCustom')}</span>
            </button>
          }
        >
          <div class="mt-2 rounded-xl border border-[var(--border-panel)] bg-[var(--bg-subtle)] p-2.5 space-y-2">
            <input
              data-testid="ai-custom-name"
              type="text"
              spellcheck={false}
              aria-label={i18n.t('settings.models.customName')}
              placeholder={i18n.t('settings.models.customNamePlaceholder')}
              value={customName()}
              onInput={(e) => setCustomName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCustomProvider()}
              class={inputClass}
            />
            <input
              data-testid="ai-custom-base-url"
              type="text"
              spellcheck={false}
              aria-label={i18n.t('settings.models.baseUrl')}
              placeholder={i18n.t('settings.models.customBaseUrlPlaceholder')}
              value={customBaseUrl()}
              onInput={(e) => setCustomBaseUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCustomProvider()}
              class={`${inputClass} font-mono`}
            />
            <input
              data-testid="ai-custom-model"
              type="text"
              spellcheck={false}
              aria-label={i18n.t('settings.models.model')}
              placeholder={i18n.t('settings.models.modelPlaceholder')}
              value={customModel()}
              onInput={(e) => setCustomModel(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitCustomProvider()}
              class={inputClass}
            />
            <p class="text-[10.5px] text-[var(--text-muted)] leading-relaxed">
              {i18n.t('settings.models.customHint')}
            </p>
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="ai-custom-cancel"
                class={ghostButtonClass}
                onClick={() => {
                  setCustomName('')
                  setCustomBaseUrl('')
                  setCustomModel('')
                  setShowAddForm(false)
                }}
              >
                {i18n.t('settings.models.customCancel')}
              </button>
              <button
                type="button"
                data-testid="ai-custom-confirm"
                class={ghostButtonClass}
                disabled={!canAddCustom()}
                onClick={() => submitCustomProvider()}
              >
                {i18n.t('settings.models.customAdd')}
              </button>
            </div>
          </div>
        </Show>
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
          value={activeConfig()?.apiKey ?? ''}
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
              value={activeConfig()?.model ?? ''}
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
            value={activeConfig()?.baseUrl ?? ''}
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
