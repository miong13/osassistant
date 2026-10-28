import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolUnion
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatMessage, ChatPart, ModelInfo } from '../../shared/types'
import { normalizeHistory } from './history'
import type { ChatProvider, StopReason, StreamHandlers, StreamRequest, TurnResult } from './types'
import { genericErrorMessage } from './types'

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
]

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Convert our neutral history into Claude messages. Claude's own turns are replayed unchanged. */
export function toAnthropicMessages(messages: ChatMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = []
  for (const m of normalizeHistory(messages)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    let content: BetaContentBlockParam[]
    if (m.role === 'assistant' && m.raw?.providerKind === 'anthropic' && Array.isArray(m.raw.content)) {
      content = m.raw.content as BetaContentBlockParam[]
    } else {
      content = m.parts.flatMap((p): BetaContentBlockParam[] => {
        if (p.type === 'text') return p.text ? [{ type: 'text', text: p.text }] : []
        if (p.type === 'image')
          return p.data ? [{ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }] : []
        if (p.type === 'tool_call')
          return [
            { type: 'tool_use', id: p.id, name: p.name, input: (p.input ?? {}) as Record<string, unknown> }
          ]
        return [
          { type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, is_error: p.isError }
        ]
      })
    }
    if (!content.length) continue
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = [...(last.content as BetaContentBlockParam[]), ...content]
    } else {
      out.push({ role, content })
    }
  }
  return out
}

function toParts(content: BetaContentBlock[]): ChatPart[] {
  const parts: ChatPart[] = []
  for (const b of content) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input })
  }
  return parts
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

export class AnthropicProvider implements ChatProvider {
  private client: Anthropic

  constructor(apiKey: string | undefined) {
    // With no key, the SDK falls back to ANTHROPIC_API_KEY / an `ant auth login` profile.
    this.client = new Anthropic(apiKey ? { apiKey } : {})
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const found: ModelInfo[] = []
      for await (const m of this.client.models.list()) {
        found.push({ id: m.id, label: m.display_name })
      }
      const preferred = ANTHROPIC_MODELS.filter((p) => found.some((f) => f.id === p.id))
      const rest = found.filter((f) => !ANTHROPIC_MODELS.some((p) => p.id === f.id))
      return [...preferred, ...rest]
    } catch {
      return ANTHROPIC_MODELS
    }
  }

  async stream(req: StreamRequest, handlers: StreamHandlers): Promise<TurnResult> {
    const tools: BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaToolUnion extends { input_schema: infer S } ? S : never,
      eager_input_streaming: true
    }))
    const messages = toAnthropicMessages(req.messages)

    // A tool input that isn't parseable JSON rejects finalMessage(); re-issue that turn
    // (at most twice). API errors, including user aborts, are rethrown.
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: 64000,
          system: req.system,
          messages,
          ...(tools.length ? { tools } : {}),
          thinking: { type: 'adaptive' },
          output_config: { effort: req.effort },
          cache_control: { type: 'ephemeral' },
          betas: [FALLBACK_BETA],
          fallbacks: 'default'
        },
        { signal: req.signal }
      )
      stream.on('text', (delta) => handlers.onText(delta))
      stream.on('streamEvent', (event) => {
        if (event.type === 'content_block_start') {
          handlers.onThinking?.(event.content_block.type === 'thinking')
        }
      })
      try {
        const message = await stream.finalMessage()
        return {
          parts: toParts(message.content),
          raw: { providerKind: 'anthropic', model: req.model, content: message.content },
          stopReason: mapStop(message.stop_reason)
        }
      } catch (err) {
        if (err instanceof Anthropic.APIError || attempt >= 2) throw err
      }
    }
  }

  describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError)
      return 'Your Claude API key was rejected. Add or fix it in Settings → AI Providers.'
    if (err instanceof Anthropic.PermissionDeniedError)
      return 'This API key does not have access to that model.'
    if (err instanceof Anthropic.NotFoundError) return 'That Claude model was not found. Pick another model.'
    if (err instanceof Anthropic.RateLimitError) return 'Claude is rate-limiting requests. Try again in a moment.'
    if (err instanceof Anthropic.APIConnectionError)
      return 'Could not reach the Claude API. Check your internet connection.'
    if (err instanceof Anthropic.InternalServerError) return 'Claude is having trouble right now. Try again shortly.'
    if (err instanceof Anthropic.APIError) return err.message
    if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message))
      return 'No Claude API key set. Add one in Settings → AI Providers.'
    return genericErrorMessage(err)
  }
}
