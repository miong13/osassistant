import { Ollama, type Message, type Tool, type ToolCall } from 'ollama'
import type { ChatMessage, ChatPart, ModelInfo } from '../../shared/types'
import { normalizeHistory, textOf } from './history'
import type { ChatProvider, StreamHandlers, StreamRequest, TurnResult } from './types'
import { genericErrorMessage, newToolCallId } from './types'

export function toOllamaMessages(system: string, messages: ChatMessage[]): Message[] {
  const out: Message[] = [{ role: 'system', content: system }]
  for (const m of normalizeHistory(messages)) {
    if (m.role === 'user') out.push({ role: 'user', content: textOf(m.parts) })
    else if (m.role === 'assistant') {
      const calls = m.parts.filter((p) => p.type === 'tool_call')
      out.push({
        role: 'assistant',
        content: textOf(m.parts),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> }
              }))
            }
          : {})
      })
    } else {
      for (const p of m.parts) {
        if (p.type === 'tool_result') out.push({ role: 'tool', content: p.content, tool_name: p.name })
      }
    }
  }
  return out
}

export const OLLAMA_CONTEXT_TOKENS = 8192

export class OllamaProvider implements ChatProvider {
  private client: Ollama

  constructor(private baseUrl = 'http://localhost:11434') {
    this.client = new Ollama({ host: baseUrl })
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.client.list()
    return res.models.map((m) => ({ id: m.name, label: m.name }))
  }

  async stream(req: StreamRequest, handlers: StreamHandlers): Promise<TurnResult> {
    const tools: Tool[] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema as Tool['function']['parameters'] }
    }))
    try {
      return await this.run(req, handlers, tools)
    } catch (err) {
      // Some local models don't support tools; retry once without them.
      if (tools.length && err instanceof Error && /does not support tools/i.test(err.message)) {
        return this.run(req, handlers, [])
      }
      throw err
    }
  }

  private async run(req: StreamRequest, handlers: StreamHandlers, tools: Tool[]): Promise<TurnResult> {
    const response = await this.client.chat({
      model: req.model,
      messages: toOllamaMessages(req.system, req.messages),
      ...(tools.length ? { tools } : {}),
      // Ollama's default context is small and it silently drops the start of the prompt (including
      // the system prompt) when it overflows. Set it explicitly; history is trimmed to fit.
      options: { num_ctx: OLLAMA_CONTEXT_TOKENS },
      stream: true
    })
    const onAbort = () => response.abort()
    req.signal.addEventListener('abort', onAbort)
    let text = ''
    const calls: ToolCall[] = []
    let thinking = false
    let doneReason = ''
    try {
      for await (const chunk of response) {
        if (chunk.message.thinking && !thinking) {
          thinking = true
          handlers.onThinking?.(true)
        }
        if (chunk.message.content) {
          if (thinking) {
            thinking = false
            handlers.onThinking?.(false)
          }
          text += chunk.message.content
          handlers.onText(chunk.message.content)
        }
        if (chunk.message.tool_calls) calls.push(...chunk.message.tool_calls)
        if (chunk.done) doneReason = chunk.done_reason
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort)
    }
    if (req.signal.aborted) throw new DOMException('Aborted', 'AbortError')

    const parts: ChatPart[] = []
    if (text) parts.push({ type: 'text', text })
    for (const c of calls) {
      parts.push({ type: 'tool_call', id: newToolCallId(), name: c.function.name, input: c.function.arguments })
    }
    return {
      parts,
      stopReason: calls.length ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end'
    }
  }

  describeError(err: unknown): string {
    if (err instanceof Error) {
      if (/ECONNREFUSED|fetch failed/i.test(err.message))
        return `Could not reach Ollama at ${this.baseUrl}. Is Ollama running?`
      if (/not found/i.test(err.message))
        return `${err.message}. Pull it first with \`ollama pull <model>\`, or pick another model.`
    }
    return genericErrorMessage(err)
  }
}
