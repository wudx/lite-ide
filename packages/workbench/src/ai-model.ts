import { createServiceKey } from '@lite-ide/kernel'
import {
  chatCompletionViaFetch,
  chatCompletionViaTauri,
  isTauriEnvironment,
  type AiChatRequest,
} from '@lite-ide/protocol'
import { createSignal, type Accessor } from 'solid-js'

/** Providers shipped with the built-in model settings section. */
export type AiProviderId = 'zai' | 'deepseek'

export interface AiProviderPreset {
  id: AiProviderId
  /** Brand label shown in the settings UI (not translated). */
  label: string
  defaultBaseUrl: string
  defaultModel: string
  /** Suggested model ids offered as completion hints. */
  models: readonly string[]
}

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    models: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-4.6', 'glm-4.5-air', 'glm-4.5-flash'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
]

export interface AiProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export type AiProviderConfigs = Readonly<Record<AiProviderId, AiProviderConfig>>

export interface AiModelService {
  readonly presets: readonly AiProviderPreset[]
  readonly providerId: Accessor<AiProviderId>
  readonly providers: Accessor<AiProviderConfigs>
  /** Custom commit-message system prompt; empty string means the default. */
  readonly commitPrompt: Accessor<string>
  presetOf(id: AiProviderId): AiProviderPreset
  setProviderId(id: AiProviderId): void
  updateProvider(id: AiProviderId, patch: Partial<AiProviderConfig>): void
  /** Restores the preset base URL / model (keeps the API key). */
  resetProvider(id: AiProviderId): void
  setCommitPrompt(prompt: string): void
  /** True when the active provider has an API key configured. */
  isConfigured(): boolean
  /**
   * Runs one chat completion against the active provider. Desktop builds
   * route through the Rust `ai_chat` command; browsers call the endpoint
   * directly. Throws with a human-readable message on failure.
   */
  chat(request: { system?: string; user: string }): Promise<string>
}

export const AI_MODEL_STORAGE_KEY = 'lite-ide.ai-model.v1'
export const DEFAULT_AI_PROVIDER_ID: AiProviderId = 'deepseek'

export const AiModelKey = createServiceKey<AiModelService>('workbench.aiModel')

function presetOf(id: string): AiProviderPreset {
  return (
    AI_PROVIDER_PRESETS.find((p) => p.id === id) ??
    AI_PROVIDER_PRESETS.find((p) => p.id === DEFAULT_AI_PROVIDER_ID)!
  )
}

function defaultProviderConfig(id: AiProviderId): AiProviderConfig {
  const preset = presetOf(id)
  return { apiKey: '', baseUrl: preset.defaultBaseUrl, model: preset.defaultModel }
}

function sanitizeProviderConfig(raw: unknown, id: AiProviderId): AiProviderConfig {
  const defaults = defaultProviderConfig(id)
  if (typeof raw !== 'object' || raw === null) return defaults
  const record = raw as Record<string, unknown>
  return {
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    baseUrl:
      typeof record.baseUrl === 'string' && record.baseUrl.trim()
        ? record.baseUrl
        : defaults.baseUrl,
    model:
      typeof record.model === 'string' && record.model.trim() ? record.model : defaults.model,
  }
}

function readStoredSettings(): {
  providerId: AiProviderId
  providers: AiProviderConfigs
  commitPrompt: string
} {
  const fallback = {
    providerId: DEFAULT_AI_PROVIDER_ID,
    providers: {
      zai: defaultProviderConfig('zai'),
      deepseek: defaultProviderConfig('deepseek'),
    },
    commitPrompt: '',
  }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(AI_MODEL_STORAGE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const record = parsed as Record<string, unknown>
    const rawProviders =
      typeof record.providers === 'object' && record.providers !== null
        ? (record.providers as Record<string, unknown>)
        : {}
    const providerId: AiProviderId =
      record.providerId === 'zai' || record.providerId === 'deepseek'
        ? record.providerId
        : DEFAULT_AI_PROVIDER_ID
    return {
      providerId,
      providers: {
        zai: sanitizeProviderConfig(rawProviders.zai, 'zai'),
        deepseek: sanitizeProviderConfig(rawProviders.deepseek, 'deepseek'),
      },
      commitPrompt: typeof record.commitPrompt === 'string' ? record.commitPrompt : '',
    }
  } catch {
    return fallback
  }
}

function persistSettings(settings: {
  providerId: AiProviderId
  providers: AiProviderConfigs
  commitPrompt: string
}) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(AI_MODEL_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage quota / privacy errors.
  }
}

export function createAiModelService(): AiModelService {
  const stored = readStoredSettings()
  const [providerId, setProviderIdSignal] = createSignal<AiProviderId>(stored.providerId)
  const [providers, setProviders] = createSignal<AiProviderConfigs>(stored.providers)
  const [commitPrompt, setCommitPromptSignal] = createSignal(stored.commitPrompt)

  function persist() {
    persistSettings({
      providerId: providerId(),
      providers: providers(),
      commitPrompt: commitPrompt(),
    })
  }

  return {
    presets: AI_PROVIDER_PRESETS,
    providerId,
    providers,
    commitPrompt,

    presetOf,

    setProviderId(id: AiProviderId) {
      setProviderIdSignal(id)
      persist()
    },

    updateProvider(id: AiProviderId, patch: Partial<AiProviderConfig>) {
      setProviders((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
      persist()
    },

    resetProvider(id: AiProviderId) {
      const preset = presetOf(id)
      setProviders((prev) => ({
        ...prev,
        [id]: { ...prev[id], baseUrl: preset.defaultBaseUrl, model: preset.defaultModel },
      }))
      persist()
    },

    setCommitPrompt(prompt: string) {
      setCommitPromptSignal(prompt)
      persist()
    },

    isConfigured() {
      return providers()[providerId()].apiKey.trim().length > 0
    },

    async chat({ system, user }) {
      const id = providerId()
      const config = providers()[id]
      if (!config.apiKey.trim()) {
        throw new Error('ai model API key is not configured')
      }
      const request: AiChatRequest = {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        system,
        user,
      }
      const result = isTauriEnvironment()
        ? await chatCompletionViaTauri(request)
        : await chatCompletionViaFetch(request)
      return result.content
    },
  }
}
