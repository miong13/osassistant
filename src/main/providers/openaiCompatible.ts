import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import type { ChatMessage, ChatPart, ModelInfo } from '../../shared/types'
import { imagesOf, normalizeHistory, textOf } from './history'
import type { ChatProvider, StreamHandlers, StreamRequest, TurnResult } from './types'
import { genericErrorMessage, newToolCallId } from './types'

export function toOpenAIMessages(system: string, messages: ChatMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const m of normalizeHistory(messages)) {
    if (m.role === 'user') {
      const images = imagesOf(m.parts)
      const text = textOf(m.parts)
      out.push({
        role: 'user',
        content: images.length
          ? [
              ...(text ? [{ type: 'text' as const, text }] : []),
              ...images.map((p) => ({ type: 'image_url' as const, image_url: { url: `data:${p.mediaType};base64,${p.data}` } }))
            ]
          : text
      })
    }
    else if (m.role === 'assistant') {
      const calls = m.parts.filter((p) => p.type === 'tool_call')
      out.push({
        role: 'assistant',
        content: textOf(m.parts) || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) }
              }))
            }
          : {})
      })
    } else {
      for (const p of m.parts) {
        if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.content })
      }
    }
  }
  return out
}

/** A model as a service's /models endpoint lists it. Some services add fields beyond the id. */
export interface ListedModel {
  id: string
  [field: string]: unknown
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

const isOpenCode = (baseUrl: string) => {
  const host = hostOf(baseUrl)
  return host === 'opencode.ai' || host.endsWith('.opencode.ai')
}

/** OpenCode lists prices per model; a model that costs nothing in and out is free. */
function isFree(m: ListedModel): boolean {
  const text = (m.cost as { text?: { input?: { price?: unknown }; output?: { price?: unknown } } } | undefined)?.text
  return text?.input?.price === 0 && text?.output?.price === 0
}

/**
 * Some services list models that can't be used for chat here. Returns a function that maps a listed
 * model to how it's shown and used, or null to hide it. Returns null when every model can be used.
 */
export function chatModelFilter(baseUrl: string): ((m: ListedModel) => ModelInfo | null) | null {
  // OpenCode Zen / Go: every chat model works through chat completions (OpenCode translates other formats).
  // Zen's free models only work in the OpenCode app; they're listed anyway and refused with a clear message.
  if (isOpenCode(baseUrl)) {
    return (m) => {
      if (m.type !== undefined && m.type !== 'chat') return null
      const name = typeof m.name === 'string' && m.name ? m.name : m.id
      return { id: m.id, label: isFree(m) && !/\bfree\b/i.test(name) ? `${name} (free)` : name }
    }
  }
  // Google Gemini: ids come as "models/gemini-…", and the list includes embedding, image, speech and video models.
  if (hostOf(baseUrl) === 'generativelanguage.googleapis.com') {
    return (m) => {
      const id = m.id.replace(/^models\//, '')
      return id.startsWith('gemini-') && !/embedding|image|tts|audio|live|veo|imagen|computer-use|robotics/.test(id)
        ? { id, label: id }
        : null
    }
  }
  return null
}

/** Longest "try again in…" wait worth sitting through; anything longer fails right away instead. */
const MAX_RETRY_WAIT_MS = 60_000

/**
 * The OpenAI SDK waits as long as a Retry-After header says before retrying, even hours (OpenCode's
 * free-model limit sends ~12 h). This marks such responses as not worth retrying so the error shows now.
 */
export async function fetchWithoutLongWaits(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  const header = res.headers.get('retry-after')
  if (!header) return res
  const seconds = Number(header)
  const waitMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  if (!(waitMs > MAX_RETRY_WAIT_MS)) return res
  const headers = new Headers(res.headers)
  headers.set('x-should-retry', 'false')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/** Works with any service that speaks the OpenAI chat-completions format (LM Studio, OpenRouter, Groq...). */
export class OpenAICompatibleProvider implements ChatProvider {
  private client: OpenAI

  constructor(
    private baseUrl: string,
    apiKey: string | undefined,
    private extraModels: string[] = []
  ) {
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || 'not-needed',
      fetch: fetchWithoutLongWaits,
      // OpenCode asks apps to name themselves rather than send a generic SDK name.
      ...(isOpenCode(baseUrl) ? { defaultHeaders: { 'User-Agent': `os-assistant/${__APP_VERSION__}` } } : {})
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    const extra = this.extraModels.map((id) => ({ id, label: id }))
    try {
      const listed: ModelInfo[] = []
      const usable = chatModelFilter(this.baseUrl)
      for await (const m of this.client.models.list()) {
        const info = usable ? usable(m as unknown as ListedModel) : { id: m.id, label: m.id }
        if (info) listed.push(info)
      }
      return [...extra, ...listed.filter((m) => !this.extraModels.includes(m.id))]
    } catch (err) {
      if (extra.length) return extra
      throw err
    }
  }

  async stream(req: StreamRequest, handlers: StreamHandlers): Promise<TurnResult> {
    const tools: ChatCompletionTool[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema }
    }))
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(tools.length ? { tools } : {}),
        stream: true
      },
      {
        signal: req.signal,
        // OpenCode Go refuses requests without a stable session id per conversation.
        ...(isOpenCode(this.baseUrl) && req.conversationId
          ? { headers: { 'x-opencode-session': req.conversationId } }
          : {})
      }
    )
    let text = ''
    let finish = ''
    const calls = new Map<number, { id: string; name: string; args: string }>()
    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta
      if (delta?.content) {
        text += delta.content
        handlers.onText(delta.content)
      }
      for (const tc of delta?.tool_calls ?? []) {
        // Some services (e.g. Gemini) can leave out `index`; then a new id means a new call.
        let index: number | undefined = tc.index
        if (index === undefined) {
          const last = calls.size - 1
          index = last < 0 || (tc.id && calls.get(last)?.id && calls.get(last)?.id !== tc.id) ? calls.size : last
        }
        const cur = calls.get(index) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        calls.set(index, cur)
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }

    const parts: ChatPart[] = []
    if (text) parts.push({ type: 'text', text })
    for (const c of calls.values()) {
      let input: unknown = {}
      try {
        input = c.args ? JSON.parse(c.args) : {}
      } catch {
        input = { __invalid_json: c.args }
      }
      parts.push({ type: 'tool_call', id: c.id || newToolCallId(), name: c.name, input })
    }
    return {
      parts,
      stopReason: calls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end'
    }
  }

  describeError(err: unknown): string {
    if (err instanceof OpenAI.AuthenticationError) return 'The API key for this provider was rejected.'
    if (err instanceof OpenAI.NotFoundError) return 'Model or endpoint not found. Check the base URL and model.'
    if (err instanceof OpenAI.APIError && err.type === 'FreeUsageLimitError')
      return "OpenCode only allows Zen's free models inside the OpenCode app. Pick a paid model, or use OpenCode Go, whose free models work here."
    if (err instanceof OpenAI.RateLimitError) return 'The service is rate-limiting requests. Try again soon.'
    if (err instanceof OpenAI.APIConnectionError) return `Could not reach ${this.baseUrl}.`
    return genericErrorMessage(err)
  }
}
