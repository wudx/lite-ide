import { invoke } from '@tauri-apps/api/core'

/**
 * OpenAI-compatible chat-completion contract shared by the desktop IPC path
 * (Rust `ai_chat`, which bypasses webview CORS) and the browser fetch path
 * (pure-browser mock mode). Provider endpoints (Z.ai, DeepSeek, ...) are
 * configured through their base URL.
 */
export interface AiChatRequest {
  /** Provider API root, e.g. `https://api.deepseek.com`; `/chat/completions` is appended. */
  baseUrl: string
  apiKey: string
  model: string
  /** Optional system instruction (e.g. a custom commit-message prompt). */
  system?: string
  user: string
}

export interface AiChatResult {
  content: string
}

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'

/** Loopback hosts may use plain HTTP; the hostname must end here (no suffix tricks). */
function isLoopbackHttp(base: string): boolean {
  return ['http://localhost', 'http://127.0.0.1'].some((host) => {
    if (!base.startsWith(host)) return false
    const next = base.charAt(host.length)
    return next === '' || next === ':' || next === '/'
  })
}

/** Local gateways may use plain HTTP; everything else must be HTTPS. */
export function validateChatBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('base URL is empty')
  }
  if (!trimmed.startsWith('https://') && !isLoopbackHttp(trimmed)) {
    throw new Error('base URL must use https:// (http://localhost is allowed for local gateways)')
  }
  return trimmed
}

/** Joins the configured base URL with the chat-completions path. */
export function buildChatEndpoint(baseUrl: string): string {
  const base = validateChatBaseUrl(baseUrl)
  if (base.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    return base
  }
  return `${base}${CHAT_COMPLETIONS_SUFFIX}`
}

/** Builds the OpenAI-compatible request body (low temperature, no streaming). */
export function buildChatRequestBody(request: AiChatRequest): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = []
  if (request.system && request.system.trim()) {
    messages.push({ role: 'system', content: request.system })
  }
  messages.push({ role: 'user', content: request.user })
  return {
    model: request.model,
    messages,
    temperature: 0.2,
    stream: false,
    max_tokens: 1024,
  }
}

/** Extracts `error.message` / `message` from a provider error payload. */
export function extractProviderErrorMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>
  for (const key of ['error', 'message']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'object' && value !== null) {
      const nested = (value as Record<string, unknown>).message
      if (typeof nested === 'string' && nested.trim()) return nested.trim()
    }
  }
  return null
}

/** Extracts `choices[0].message.content`; throws a descriptive error otherwise. */
export function parseChatCompletionResponse(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('invalid chat completion response')
  }
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    const detail = extractProviderErrorMessage(payload)
    throw new Error(detail ? `provider error: ${detail}` : 'chat completion response has no choices')
  }
  const message = (choices[0] as Record<string, unknown>).message
  const content = (message as Record<string, unknown> | undefined)?.content
  if (typeof content !== 'string') {
    throw new Error('chat completion response has no message content')
  }
  return content
}

/**
 * Browser/mock transport: calls the provider endpoint directly from the
 * webview. Works in a plain browser (and under Playwright route mocks);
 * desktop builds prefer the Rust transport to avoid CORS restrictions.
 */
export async function chatCompletionViaFetch(
  request: AiChatRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AiChatResult> {
  const endpoint = buildChatEndpoint(request.baseUrl)
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(buildChatRequestBody(request)),
    })
  } catch (err) {
    throw new Error(`network request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    // Non-JSON body: fall through to the status-based error below.
  }
  if (!response.ok) {
    const detail = extractProviderErrorMessage(payload) ?? text.slice(0, 200)
    throw new Error(`HTTP ${response.status}: ${detail}`)
  }
  return { content: parseChatCompletionResponse(payload) }
}

/** Desktop transport: routed through the Rust `ai_chat` command (no CORS). */
export async function chatCompletionViaTauri(request: AiChatRequest): Promise<AiChatResult> {
  return invoke<AiChatResult>('ai_chat', { request })
}
