import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import type { ChatMessage, ChatPart, ModelInfo } from '../../shared/types'
import { normalizeHistory, textOf } from './history'
import type { ChatProvider, StreamHandlers, StreamRequest, TurnResult } from './types'
import { genericErrorMessage, newToolCallId } from './types'

export function toOpenAIMessages(system: string, messages: ChatMessage[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const m of normalizeHistory(messages)) {
    if (m.role === 'user') out.push({ role: 'user', content: textOf(m.parts) })
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

/**
 * Some services list models that can't be used for chat here. Returns a function that maps a listed
 * model id to the id to use for chat, or null to hide it. Returns null when every model can be used.
 */
export function chatModelFilter(baseUrl: string): ((id: string) => string | null) | null {
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return null
  }
  // OpenCode Zen / Go: Claude, GPT, Gemini, Grok etc. use other formats, and free models only work inside OpenCode.
  if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
    return (id) => (/^(deepseek|glm|kimi|minimax|mistral|qwen3\.8-max)/.test(id) && !id.endsWith('-free') ? id : null)
  }
  // Google Gemini: ids come as "models/gemini-…", and the list includes embedding, image, speech and video models.
  if (host === 'generativelanguage.googleapis.com') {
    return (listed) => {
      const id = listed.replace(/^models\//, '')
      return id.startsWith('gemini-') && !/embedding|image|tts|audio|live|veo|imagen|computer-use|robotics/.test(id)
        ? id
        : null
    }
  }
  return null
}

/** Works with any service that speaks the OpenAI chat-completions format (LM Studio, OpenRouter, Groq...). */
export class OpenAICompatibleProvider implements ChatProvider {
  private client: OpenAI

  constructor(
    private baseUrl: string,
    apiKey: string | undefined,
    private extraModels: string[] = []
  ) {
    this.client = new OpenAI({ baseURL: baseUrl, apiKey: apiKey || 'not-needed' })
  }

  async listModels(): Promise<ModelInfo[]> {
    const extra = this.extraModels.map((id) => ({ id, label: id }))
    try {
      const listed: ModelInfo[] = []
      const usable = chatModelFilter(this.baseUrl)
      for await (const m of this.client.models.list()) {
        const id = usable ? usable(m.id) : m.id
        if (id) listed.push({ id, label: id })
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
      { signal: req.signal }
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
    if (err instanceof OpenAI.RateLimitError) return 'The service is rate-limiting requests. Try again soon.'
    if (err instanceof OpenAI.APIConnectionError) return `Could not reach ${this.baseUrl}.`
    return genericErrorMessage(err)
  }
}
