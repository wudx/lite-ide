import { createServiceKey } from '@lite-ide/kernel'
import {
  chatCompletionViaFetch,
  chatCompletionViaTauri,
  isTauriEnvironment,
  type AiChatRequest,
} from '@lite-ide/protocol'
import { createMemo, createSignal, type Accessor } from 'solid-js'

/**
 * Provider id. Built-in ids get literal autocomplete; the open `(string & {})`
 * arm carries user-added custom providers.
 */
export type AiProviderId = 'zai' | 'deepseek' | 'minimax' | (string & {})

export interface AiProviderPreset {
  id: AiProviderId
  /** Brand label shown in the settings UI (not translated). */
  label: string
  defaultBaseUrl: string
  defaultModel: string
  /** Suggested model ids offered as completion hints. */
  models: readonly string[]
  /** True for user-added providers (enables the delete affordance). */
  custom?: boolean
}

/** Built-in presets shipped with the workbench. */
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
  {
    id: 'minimax',
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-M2',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.1', 'MiniMax-M2'],
  },
]

/** Metadata of a user-added provider; creation values double as reset defaults. */
export interface AiCustomProviderMeta {
  id: string
  label: string
  defaultBaseUrl: string
  defaultModel: string
}

export interface AiProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export type AiProviderConfigs = Readonly<Record<string, AiProviderConfig>>

export interface AiModelService {
  /** Built-in presets followed by the user's custom providers (reactive). */
  readonly presets: Accessor<readonly AiProviderPreset[]>
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
  /**
   * Registers a user-defined provider with empty API key, selects it and
   * returns its generated id.
   */
  addCustomProvider(input: { label: string; baseUrl: string; model: string }): AiProviderId
  /** Deletes a user-defined provider; falls back to the default when active. */
  removeCustomProvider(id: AiProviderId): void
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

/** Default system prompt used when generating Git commit messages. */
export const DEFAULT_COMMIT_SYSTEM_PROMPT = [
  '你是一名资深软件工程师，请根据提供的代码变更生成一条 Git 提交信息。',
  '要求：',
  '1. 首行使用 Conventional Commits 格式「type(scope): 描述」，type 从 feat/fix/docs/style/refactor/perf/test/build/ci/chore 中选择；描述简明扼要，结尾不加句号。',
  '2. 空一行后可用「- 」开头的要点列出主要改动，最多 5 条；改动很小时省略正文。',
  '3. 只输出提交信息本身，不要输出 Markdown 代码块、解释或任何额外内容。',
].join('\n')

export const AiModelKey = createServiceKey<AiModelService>('workbench.aiModel')

const CUSTOM_LABEL_FALLBACK = 'Custom'

function nextCustomProviderId(takenIds: readonly string[]): string {
  const taken = new Set(takenIds)
  let id = ''
  do {
    id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  } while (taken.has(id))
  return id
}

/** Maps a stored custom-provider meta to a preset-like record for the UI.
 *  Results are cached per meta object so unchanged rows keep a stable
 *  reference across `<For>` reconciliations. */
const customPresetCache = new WeakMap<AiCustomProviderMeta, AiProviderPreset>()

function customPresetOf(meta: AiCustomProviderMeta): AiProviderPreset {
  let preset = customPresetCache.get(meta)
  if (!preset) {
    preset = {
      id: meta.id,
      label: meta.label,
      defaultBaseUrl: meta.defaultBaseUrl,
      defaultModel: meta.defaultModel,
      models: meta.defaultModel ? [meta.defaultModel] : [],
      custom: true,
    }
    customPresetCache.set(meta, preset)
  }
  return preset
}

function defaultProviderConfig(preset: Pick<AiProviderPreset, 'defaultBaseUrl' | 'defaultModel'>): AiProviderConfig {
  return { apiKey: '', baseUrl: preset.defaultBaseUrl, model: preset.defaultModel }
}

function sanitizeProviderConfig(
  raw: unknown,
  preset: Pick<AiProviderPreset, 'defaultBaseUrl' | 'defaultModel'>,
): AiProviderConfig {
  const defaults = defaultProviderConfig(preset)
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

/** Validates stored custom-provider metas; drops junk and built-in id collisions. */
function sanitizeCustomMetas(raw: unknown): AiCustomProviderMeta[] {
  if (!Array.isArray(raw)) return []
  const builtinIds = new Set(AI_PROVIDER_PRESETS.map((p) => p.id))
  const seen = new Set<string>()
  const metas: AiCustomProviderMeta[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    if (!id || builtinIds.has(id) || seen.has(id)) continue
    const label =
      typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : CUSTOM_LABEL_FALLBACK
    const defaultBaseUrl =
      typeof record.defaultBaseUrl === 'string' && record.defaultBaseUrl.trim()
        ? record.defaultBaseUrl.trim()
        : ''
    const defaultModel =
      typeof record.defaultModel === 'string' && record.defaultModel.trim()
        ? record.defaultModel.trim()
        : ''
    metas.push({ id, label, defaultBaseUrl, defaultModel })
    seen.add(id)
  }
  return metas
}

function resolveStoredProviderId(raw: unknown, customMetas: readonly AiCustomProviderMeta[]): AiProviderId {
  if (typeof raw !== 'string') return DEFAULT_AI_PROVIDER_ID
  if (
    AI_PROVIDER_PRESETS.some((p) => p.id === raw) ||
    customMetas.some((m) => m.id === raw)
  ) {
    return raw
  }
  return DEFAULT_AI_PROVIDER_ID
}

interface StoredSettings {
  providerId: AiProviderId
  providers: AiProviderConfigs
  customProviders: readonly AiCustomProviderMeta[]
  commitPrompt: string
}

function readStoredSettings(): StoredSettings {
  const fallback: StoredSettings = {
    providerId: DEFAULT_AI_PROVIDER_ID,
    providers: Object.fromEntries(
      AI_PROVIDER_PRESETS.map((preset) => [preset.id, defaultProviderConfig(preset)]),
    ),
    customProviders: [],
    commitPrompt: DEFAULT_COMMIT_SYSTEM_PROMPT,
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
    const customProviders = sanitizeCustomMetas(record.customProviders)
    const providers: Record<string, AiProviderConfig> = {}
    for (const preset of AI_PROVIDER_PRESETS) {
      providers[preset.id] = sanitizeProviderConfig(rawProviders[preset.id], preset)
    }
    for (const meta of customProviders) {
      providers[meta.id] = sanitizeProviderConfig(rawProviders[meta.id], meta)
    }
    return {
      providerId: resolveStoredProviderId(record.providerId, customProviders),
      providers,
      customProviders,
      commitPrompt:
        typeof record.commitPrompt === 'string' && record.commitPrompt.trim().length > 0
          ? record.commitPrompt
          : DEFAULT_COMMIT_SYSTEM_PROMPT,
    }
  } catch {
    return fallback
  }
}

function persistSettings(settings: StoredSettings) {
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
  const [customMetas, setCustomMetas] = createSignal<readonly AiCustomProviderMeta[]>(
    stored.customProviders,
  )
  const [commitPrompt, setCommitPromptSignal] = createSignal(stored.commitPrompt)

  const presets = createMemo<readonly AiProviderPreset[]>(() => [
    ...AI_PROVIDER_PRESETS,
    ...customMetas().map(customPresetOf),
  ])

  function presetOf(id: AiProviderId): AiProviderPreset {
    const builtin = AI_PROVIDER_PRESETS.find((p) => p.id === id)
    if (builtin) return builtin
    const meta = customMetas().find((m) => m.id === id)
    if (meta) return customPresetOf(meta)
    return AI_PROVIDER_PRESETS.find((p) => p.id === DEFAULT_AI_PROVIDER_ID)!
  }

  function persist() {
    persistSettings({
      providerId: providerId(),
      providers: providers(),
      customProviders: customMetas(),
      commitPrompt: commitPrompt(),
    })
  }

  return {
    presets,
    providerId,
    providers,
    commitPrompt,

    presetOf,

    setProviderId(id: AiProviderId) {
      setProviderIdSignal(id)
      persist()
    },

    updateProvider(id: AiProviderId, patch: Partial<AiProviderConfig>) {
      // Ignore unknown ids instead of seeding a partial config.
      if (!providers()[id]) return
      setProviders((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
      persist()
    },

    resetProvider(id: AiProviderId) {
      if (!providers()[id]) return
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

    addCustomProvider(input: { label: string; baseUrl: string; model: string }) {
      const label = input.label.trim() || CUSTOM_LABEL_FALLBACK
      const baseUrl = input.baseUrl.trim()
      const model = input.model.trim()
      if (!baseUrl || !model) {
        throw new Error('custom provider requires a non-empty base URL and model')
      }
      const id = nextCustomProviderId(customMetas().map((m) => m.id))
      setCustomMetas((prev) => [...prev, { id, label, defaultBaseUrl: baseUrl, defaultModel: model }])
      setProviders((prev) => ({ ...prev, [id]: { apiKey: '', baseUrl, model } }))
      setProviderIdSignal(id)
      persist()
      return id
    },

    removeCustomProvider(id: AiProviderId) {
      if (!customMetas().some((m) => m.id === id)) return
      setCustomMetas((prev) => prev.filter((m) => m.id !== id))
      setProviders((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (providerId() === id) setProviderIdSignal(DEFAULT_AI_PROVIDER_ID)
      persist()
    },

    isConfigured() {
      return providers()[providerId()]?.apiKey.trim().length > 0
    },

    async chat({ system, user }) {
      const id = providerId()
      const config = providers()[id]
      if (!config?.apiKey.trim()) {
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
