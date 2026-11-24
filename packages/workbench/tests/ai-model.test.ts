import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_MODEL_STORAGE_KEY,
  AI_PROVIDER_PRESETS,
  createAiModelService,
  DEFAULT_AI_PROVIDER_ID,
  DEFAULT_COMMIT_SYSTEM_PROMPT,
} from '../src/ai-model'

const COMPLETION_PAYLOAD = {
  choices: [{ message: { content: 'pong' } }],
}

describe('createAiModelService built-in presets', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('ships the MiniMax preset and default configs for every built-in provider', () => {
    const minimax = AI_PROVIDER_PRESETS.find((p) => p.id === 'minimax')
    expect(minimax).toMatchObject({
      label: 'MiniMax',
      defaultBaseUrl: 'https://api.minimaxi.com/v1',
      defaultModel: 'MiniMax-M2',
    })

    const ai = createAiModelService()
    expect(ai.providerId()).toBe(DEFAULT_AI_PROVIDER_ID)
    expect(ai.presets().length).toBe(AI_PROVIDER_PRESETS.length)
    for (const preset of AI_PROVIDER_PRESETS) {
      expect(ai.providers()[preset.id]).toEqual({
        apiKey: '',
        baseUrl: preset.defaultBaseUrl,
        model: preset.defaultModel,
      })
    }
  })

  it('persists provider edits and restores them in a new service instance', () => {
    const ai = createAiModelService()
    ai.setProviderId('minimax')
    ai.updateProvider('minimax', { apiKey: 'sk-minimax', model: 'MiniMax-M2.1' })

    const stored = JSON.parse(localStorage.getItem(AI_MODEL_STORAGE_KEY)!)
    expect(stored.providerId).toBe('minimax')
    expect(stored.providers.minimax).toEqual({
      apiKey: 'sk-minimax',
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'MiniMax-M2.1',
    })

    const restored = createAiModelService()
    expect(restored.providerId()).toBe('minimax')
    expect(restored.providers().minimax?.apiKey).toBe('sk-minimax')
    expect(restored.providers().minimax?.model).toBe('MiniMax-M2.1')
  })
})

describe('createAiModelService custom providers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds a custom provider, selects it and exposes it as a preset', () => {
    const ai = createAiModelService()
    const id = ai.addCustomProvider({
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'vendor/model-x',
    })

    expect(id).toMatch(/^custom-/)
    expect(ai.providerId()).toBe(id)
    expect(ai.providers()[id]).toEqual({
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'vendor/model-x',
    })
    const preset = ai.presets().find((p) => p.id === id)
    expect(preset).toMatchObject({
      id,
      label: 'OpenRouter',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'vendor/model-x',
      custom: true,
    })
    expect(ai.presetOf(id)).toEqual(preset)

    const stored = JSON.parse(localStorage.getItem(AI_MODEL_STORAGE_KEY)!)
    expect(stored.customProviders).toEqual([
      {
        id,
        label: 'OpenRouter',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'vendor/model-x',
      },
    ])
  })

  it('reset restores the creation defaults but keeps the API key', () => {
    const ai = createAiModelService()
    const id = ai.addCustomProvider({
      label: 'Gateway',
      baseUrl: 'https://gw.example.com/v1',
      model: 'gw-default',
    })
    ai.updateProvider(id, { apiKey: 'sk-gw', baseUrl: 'https://other.example.com/v1', model: 'gw-other' })

    ai.resetProvider(id)
    expect(ai.providers()[id]).toEqual({
      apiKey: 'sk-gw',
      baseUrl: 'https://gw.example.com/v1',
      model: 'gw-default',
    })
  })

  it('removes a custom provider and falls back to the default when it was active', () => {
    const ai = createAiModelService()
    const id = ai.addCustomProvider({
      label: 'Temp',
      baseUrl: 'https://temp.example.com/v1',
      model: 'temp-model',
    })

    ai.removeCustomProvider(id)
    expect(ai.presets().some((p) => p.id === id)).toBe(false)
    expect(ai.providers()[id]).toBeUndefined()
    expect(ai.providerId()).toBe(DEFAULT_AI_PROVIDER_ID)

    const stored = JSON.parse(localStorage.getItem(AI_MODEL_STORAGE_KEY)!)
    expect(stored.customProviders).toEqual([])
    expect(stored.providerId).toBe(DEFAULT_AI_PROVIDER_ID)
  })

  it('removeCustomProvider ignores built-in and unknown ids', () => {
    const ai = createAiModelService()
    ai.removeCustomProvider('zai')
    ai.removeCustomProvider('custom-nonexistent')
    expect(ai.presets().some((p) => p.id === 'zai')).toBe(true)
    expect(ai.providerId()).toBe(DEFAULT_AI_PROVIDER_ID)
  })

  it('updateProvider and resetProvider ignore unknown ids', () => {
    const ai = createAiModelService()
    ai.updateProvider('custom-unknown', { apiKey: 'sk-x' })
    ai.resetProvider('custom-unknown')
    expect(ai.providers()['custom-unknown']).toBeUndefined()
    // Built-in configs stay untouched.
    expect(ai.providers().deepseek?.apiKey).toBe('')
  })

  it('addCustomProvider rejects an empty base URL or model', () => {
    const ai = createAiModelService()
    expect(() =>
      ai.addCustomProvider({ label: 'X', baseUrl: '  ', model: 'm' }),
    ).toThrow(/base URL/)
    expect(() => ai.addCustomProvider({ label: 'X', baseUrl: 'https://x.example.com', model: '' })).toThrow(
      /model/,
    )
    expect(ai.presets().some((p) => p.custom)).toBe(false)
  })

  it('chat() calls the active custom provider endpoint via fetch', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(COMPLETION_PAYLOAD), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const ai = createAiModelService()
    const id = ai.addCustomProvider({
      label: 'LAN Gateway',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3',
    })
    ai.updateProvider(id, { apiKey: 'sk-lan' })

    await expect(ai.chat({ user: 'ping' })).resolves.toBe('pong')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('llama3')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-lan')
  })
})

describe('createAiModelService storage sanitation', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('synthesizes missing built-in configs from a legacy storage payload', () => {
    localStorage.setItem(
      AI_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerId: 'zai',
        providers: { zai: { apiKey: 'sk-z', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' } },
        commitPrompt: 'p',
      }),
    )
    const ai = createAiModelService()
    expect(ai.providerId()).toBe('zai')
    expect(ai.providers().zai?.apiKey).toBe('sk-z')
    // MiniMax did not exist in the legacy payload: it boots with preset defaults.
    expect(ai.providers().minimax).toEqual({
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/v1',
      model: 'MiniMax-M2',
    })
  })

  it('falls back to the default provider when the stored id is unknown', () => {
    localStorage.setItem(
      AI_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerId: 'custom-gone',
        providers: {},
        customProviders: [],
      }),
    )
    const ai = createAiModelService()
    expect(ai.providerId()).toBe(DEFAULT_AI_PROVIDER_ID)
  })

  it('falls back to the default provider when a stored custom provider is missing', () => {
    localStorage.setItem(
      AI_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerId: 'custom-x',
        providers: {},
        customProviders: [
          { id: 'custom-y', label: 'Kept', defaultBaseUrl: 'https://y.example.com/v1', defaultModel: 'y' },
        ],
      }),
    )
    const ai = createAiModelService()
    expect(ai.providerId()).toBe(DEFAULT_AI_PROVIDER_ID)
    // custom-x is unknown and dropped; custom-y survives sanitation.
    expect(ai.presets().some((p) => p.id === 'custom-y')).toBe(true)
  })

  it('drops junk and built-in id collisions from stored custom providers', () => {
    localStorage.setItem(
      AI_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerId: 'deepseek',
        providers: {},
        customProviders: [
          null,
          'nope',
          { id: 'zai', label: 'Hijack', defaultBaseUrl: 'https://evil.example.com', defaultModel: 'x' },
          { id: 'custom-a', label: '  ', defaultBaseUrl: 'https://a.example.com/v1', defaultModel: 'a' },
          { id: 'custom-a', label: 'Dup', defaultBaseUrl: 'https://dup.example.com', defaultModel: 'd' },
          { label: 'NoId', defaultBaseUrl: 'https://n.example.com', defaultModel: 'n' },
        ],
      }),
    )
    const ai = createAiModelService()
    const customIds = ai.presets().filter((p) => p.custom).map((p) => p.id)
    expect(customIds).toEqual(['custom-a'])
    // Blank labels fall back to 'Custom'.
    expect(ai.presets().find((p) => p.id === 'custom-a')?.label).toBe('Custom')
  })

  it('returns full defaults on corrupt JSON', () => {
    localStorage.setItem(AI_MODEL_STORAGE_KEY, '{not json')
    const ai = createAiModelService()
    expect(ai.providerId()).toBe(DEFAULT_AI_PROVIDER_ID)
    expect(ai.providers().deepseek?.baseUrl).toBe('https://api.deepseek.com')
    expect(ai.commitPrompt()).toBe(DEFAULT_COMMIT_SYSTEM_PROMPT)
  })

  it('defaults commitPrompt to DEFAULT_COMMIT_SYSTEM_PROMPT when unset or blank', () => {
    const fresh = createAiModelService()
    expect(fresh.commitPrompt()).toBe(DEFAULT_COMMIT_SYSTEM_PROMPT)

    localStorage.setItem(
      AI_MODEL_STORAGE_KEY,
      JSON.stringify({ providerId: 'deepseek', providers: {}, commitPrompt: '   ' }),
    )
    const blank = createAiModelService()
    expect(blank.commitPrompt()).toBe(DEFAULT_COMMIT_SYSTEM_PROMPT)

    blank.setCommitPrompt('Custom prompt')
    expect(createAiModelService().commitPrompt()).toBe('Custom prompt')
  })
})
