import OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatModelFilter, type ListedModel, OpenAICompatibleProvider } from '../src/main/providers/openaiCompatible'

const usableIds = (url: string, ids: string[]) =>
  ids.map((id) => chatModelFilter(url)!({ id })?.id).filter(Boolean)

/** Shaped like OpenCode's /models entries. */
const openCodeModel = (id: string, name: string, price: number, type = 'chat'): ListedModel => ({
  id,
  name,
  type,
  cost: { text: { input: { price }, output: { price } } }
})

describe('chatModelFilter', () => {
  it('lists every OpenCode chat model by name and marks the free ones', () => {
    const listed = [
      openCodeModel('big-pickle', 'Big Pickle', 0),
      openCodeModel('beam-free', 'Beam Free', 0),
      openCodeModel('claude-haiku-5-5', 'Claude Haiku 5.5', 1),
      openCodeModel('glm-5.3', 'GLM-5.3', 0.6),
      openCodeModel('some-embedder', 'Embedder', 0.1, 'embedding')
    ]
    for (const url of ['https://opencode.ai/zen/v1', 'https://opencode.ai/zen/go/v1']) {
      expect(listed.map(chatModelFilter(url)!).filter(Boolean)).toEqual([
        { id: 'big-pickle', label: 'Big Pickle (free)' },
        { id: 'beam-free', label: 'Beam Free' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        { id: 'glm-5.3', label: 'GLM-5.3' }
      ])
    }
    // Entries without extra details are still listed by id.
    expect(chatModelFilter('https://opencode.ai/zen/v1')!({ id: 'kimi-k3' })).toEqual({ id: 'kimi-k3', label: 'kimi-k3' })
  })

  it('keeps Gemini chat models and drops the "models/" prefix', () => {
    const ids = [
      'models/gemini-3.8-flash',
      'models/gemini-3.1-pro',
      'models/gemini-embedding-001',
      'models/gemini-2.5-flash-image',
      'models/gemini-2.5-flash-preview-tts',
      'models/imagen-4.0-generate-001',
      'models/gemma-3-27b-it',
      'gemini-3.5-flash-lite'
    ]
    expect(usableIds('https://generativelanguage.googleapis.com/v1beta/openai/', ids)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-pro',
      'gemini-3.5-flash-lite'
    ])
  })

  it('keeps every model on other services', () => {
    expect(chatModelFilter('https://openrouter.ai/api/v1')).toBeNull()
    expect(chatModelFilter('not a url')).toBeNull()
  })
})

describe('OpenCode requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  function capture(status = 200, body: unknown = 'data: [DONE]\n\n', headers: Record<string, string> = {}) {
    const requests: Request[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return typeof body === 'string'
        ? new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } })
        : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
    })
    return requests
  }
  const request = (conversationId?: string) => ({
    model: 'glm-5.3',
    system: 'sys',
    messages: [],
    tools: [],
    effort: 'medium' as const,
    signal: new AbortController().signal,
    conversationId
  })

  it('sends a session id per conversation and names the app', async () => {
    const requests = capture()
    await new OpenAICompatibleProvider('https://opencode.ai/zen/go/v1', 'k').stream(request('conv-1'), { onText: () => {} })
    expect(requests[0].headers.get('x-opencode-session')).toBe('conv-1')
    expect(requests[0].headers.get('user-agent')).toMatch(/^os-assistant\//)
  })

  it("doesn't send the session id to other services", async () => {
    const requests = capture()
    await new OpenAICompatibleProvider('https://openrouter.ai/api/v1', 'k').stream(request('conv-1'), { onText: () => {} })
    expect(requests[0].headers.get('x-opencode-session')).toBeNull()
  })

  it("explains when OpenCode refuses a free model outside its app", async () => {
    const requests = capture(
      429,
      { type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } },
      { 'retry-after': '45118' } // about 12 hours
    )
    const provider = new OpenAICompatibleProvider('https://opencode.ai/zen/v1', 'k')
    const err = await provider.stream({ ...request('c'), model: 'big-pickle' }, { onText: () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(OpenAI.RateLimitError)
    expect(provider.describeError(err)).toMatch(/only allows Zen's free models inside the OpenCode app/)
    expect(requests).toHaveLength(1) // gave up instead of waiting 12 hours to retry
  })

  it('still retries after a short wait', async () => {
    const requests = capture(429, { error: { message: 'slow down' } }, { 'retry-after-ms': '1' })
    const provider = new OpenAICompatibleProvider('https://opencode.ai/zen/v1', 'k')
    await provider.stream(request('c'), { onText: () => {} }).catch(() => undefined)
    expect(requests).toHaveLength(3)
  })
})
