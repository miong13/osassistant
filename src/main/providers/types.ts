import type { ChatMessage, ChatPart, Effort, ModelInfo, RawTurn } from '../../shared/types'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface StreamRequest {
  model: string
  system: string
  messages: ChatMessage[]
  tools: ToolDef[]
  effort: Effort
  signal: AbortSignal
  /** Stable per conversation; some services use it for routing and caching. */
  conversationId?: string
}

export interface StreamHandlers {
  onText(delta: string): void
  onThinking?(active: boolean): void
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'

export interface TurnResult {
  parts: ChatPart[]
  raw?: RawTurn
  stopReason: StopReason
}

/** Every AI service implements this. Adding a new service = one new file + a registry entry. */
export interface ChatProvider {
  listModels(): Promise<ModelInfo[]>
  stream(req: StreamRequest, handlers: StreamHandlers): Promise<TurnResult>
  /** Turn a thrown error into a short message for the chat bubble. */
  describeError(err: unknown): string
}

export class ProviderError extends Error {}

export function newToolCallId(): string {
  return 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24)
}

export function genericErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (/ECONNREFUSED|fetch failed/i.test(err.message))
      return 'Could not connect to the AI service. Is it running and reachable?'
    return err.message
  }
  return String(err)
}
