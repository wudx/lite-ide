import { describe, expect, it, vi } from 'vitest'
import {
  buildChatEndpoint,
  buildChatRequestBody,
  chatCompletionViaFetch,
  extractProviderErrorMessage,
  parseChatCompletionResponse,
  validateChatBaseUrl,
  type AiChatRequest,
} from '../src/ai'

const baseRequest: AiChatRequest = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
  user: 'hello',
}

describe('validateChatBaseUrl', () => {
  it('accepts https and loopback http, trims trailing slashes', () => {
    expect(validateChatBaseUrl('https://api.z.ai/api/paas/v4/')).toBe('https://api.z.ai/api/paas/v4')
    expect(validateChatBaseUrl('  https://api.deepseek.com  ')).toBe('https://api.deepseek.com')
    expect(validateChatBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
    expect(validateChatBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
  })

  it('rejects empty and non-https remote URLs', () => {
    expect(() => validateChatBaseUrl('')).toThrow()
    expect(() => validateChatBaseUrl('   ')).toThrow()
    expect(() => validateChatBaseUrl('http://api.deepseek.com')).toThrow()
    expect(() => validateChatBaseUrl('ftp://example.com')).toThrow()
  })

  it('does not let remote hosts piggyback on the loopback allowlist', () => {
    expect(() => validateChatBaseUrl('http://localhost.evil.com')).toThrow()
    expect(() => validateChatBaseUrl('http://127.0.0.1.evil.com')).toThrow()
    expect(() => validateChatBaseUrl('http://localhost:8080/v1')).not.toThrow()
  })
})

describe('buildChatEndpoint', () => {
  it('appends the completions path once', () => {
    expect(buildChatEndpoint('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/chat/completions',
    )
    expect(buildChatEndpoint('https://api.z.ai/api/paas/v4')).toBe(
      'https://api.z.ai/api/paas/v4/chat/completions',
    )
    expect(buildChatEndpoint('https://proxy.example.com/v1/chat/completions/')).toBe(
      'https://proxy.example.com/v1/chat/completions',
    )
  })
})

describe('buildChatRequestBody', () => {
  it('includes the system message only when non-blank', () => {
    const withSystem = buildChatRequestBody({ ...baseRequest, system: 'be terse' })
    expect(withSystem.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hello' },
    ])
    expect(withSystem.model).toBe('deepseek-chat')
    expect(withSystem.stream).toBe(false)

    const withoutSystem = buildChatRequestBody({ ...baseRequest, system: '   ' })
    expect(withoutSystem.messages).toEqual([{ role: 'user', content: 'hello' }])
  })
})

describe('parseChatCompletionResponse', () => {
  it('extracts choices[0].message.content', () => {
    expect(
      parseChatCompletionResponse({
        choices: [{ message: { role: 'assistant', content: 'feat: add x' } }],
      }),
    ).toBe('feat: add x')
  })

  it('surfaces provider error payloads and malformed shapes', () => {
    expect(() => parseChatCompletionResponse({ error: { message: 'bad key' } })).toThrow(
      'provider error: bad key',
    )
    expect(() => parseChatCompletionResponse({ choices: [] })).toThrow('no choices')
    expect(() => parseChatCompletionResponse(null)).toThrow()
    expect(() =>
      parseChatCompletionResponse({ choices: [{ message: { content: null } }] }),
    ).toThrow('no message content')
  })
})

describe('extractProviderErrorMessage', () => {
  it('reads error.message, nested messages and plain message fields', () => {
    expect(extractProviderErrorMessage({ error: { message: 'quota exceeded' } })).toBe(
      'quota exceeded',
    )
    expect(extractProviderErrorMessage({ message: 'unauthorized' })).toBe('unauthorized')
    expect(extractProviderErrorMessage({ error: 'plain string' })).toBe('plain string')
    expect(extractProviderErrorMessage({})).toBeNull()
    expect(extractProviderErrorMessage('not an object')).toBeNull()
  })
})

describe('chatCompletionViaFetch', () => {
  it('posts an OpenAI-compatible payload and returns the content', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'feat: ok' } }] }),
        { status: 200 },
      )
    }) as typeof fetch
    const result = await chatCompletionViaFetch(baseRequest, impl)
    expect(result.content).toBe('feat: ok')
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('Authorization')).toBe('Bearer sk-test')
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('deepseek-chat')
  })

  it('turns provider HTTP errors into readable messages', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
      })) as typeof fetch
    await expect(chatCompletionViaFetch(baseRequest, impl)).rejects.toThrow(
      'HTTP 401: invalid api key',
    )
  })

  it('rejects before sending when the base URL is invalid', async () => {
    const impl = vi.fn()
    await expect(
      chatCompletionViaFetch({ ...baseRequest, baseUrl: 'http://insecure.example.com' }, impl as unknown as typeof fetch),
    ).rejects.toThrow('https://')
    expect(impl).not.toHaveBeenCalled()
  })
})
