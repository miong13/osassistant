import Ajv, { type ValidateFunction } from 'ajv'
import type {
  ApprovalDecision,
  CharacterInfo,
  ChatEvent,
  ChatMessage,
  ChatPart,
  Conversation,
  ProviderConfig,
  Settings
} from '../../shared/types'
import type { ToolHost } from '../mcp/manager'
import { fitHistory } from '../providers/history'
import { historyBudget } from '../providers/index'
import type { ChatProvider } from '../providers/types'
import type { ChatStore } from '../store/chatStore'
import { buildSystemPrompt, makeTitle } from './systemPrompt'

export const MAX_TOOL_ROUNDS = 15

export interface OrchestratorDeps {
  store: ChatStore
  tools: ToolHost
  getSettings(): Settings
  getProvider(providerId: string): { provider: ChatProvider; config: ProviderConfig }
  getCharacter(id: string): CharacterInfo | undefined
  setToolPermission(name: string, permission: 'allow'): void
  emit(e: ChatEvent): void
  /** Called when a tool needs approval, so the UI can open the chat bubble. */
  onApprovalNeeded?(): void
  platform?: string
  now?: () => number
}

type ToolCall = Extract<ChatPart, { type: 'tool_call' }>

export class Orchestrator {
  private running = new Map<string, AbortController>()
  private approvals = new Map<string, { conversationId: string; resolve: (d: ApprovalDecision) => void }>()
  private ajv = new Ajv({ strict: false, allErrors: false })
  private validators = new Map<string, ValidateFunction | null>()
  /** First message sent last time, per conversation, so trimmed history keeps a stable start. */
  private historyStart = new Map<string, string>()

  constructor(private deps: OrchestratorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  get busy(): boolean {
    return this.running.size > 0
  }

  /** Save the user's message and start a turn. Resolves with the conversation id once the turn ends. */
  async send(conversationId: string | null, text: string): Promise<{ conversationId: string; done: Promise<void> }> {
    const settings = this.deps.getSettings()
    const { store, emit } = this.deps
    let conversation: Conversation | undefined = conversationId ? store.getConversation(conversationId) : undefined
    if (conversation && this.running.has(conversation.id)) throw new Error('Still answering the previous message')
    if (!conversation) {
      const t = this.now()
      conversation = {
        id: crypto.randomUUID(),
        title: makeTitle(text),
        characterId: settings.characterId,
        providerId: settings.activeProviderId,
        model: settings.activeModel,
        createdAt: t,
        updatedAt: t
      }
      store.createConversation(conversation)
    }
    const convId = conversation.id
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      conversationId: convId,
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: this.now()
    }
    store.addMessage(userMessage)
    emit({ type: 'message', conversationId: convId, message: userMessage })
    return this.startTurn(convId)
  }

  /** Answer the last user message again, replacing the previous answer. */
  async retry(conversationId: string): Promise<{ conversationId: string; done: Promise<void> }> {
    const lastUser = this.lastUserMessage(conversationId)
    const messages = this.deps.store.getMessages(conversationId)
    const after = messages[messages.findIndex((m) => m.id === lastUser.id) + 1]
    if (after) this.removeFrom(conversationId, after.id)
    return this.startTurn(conversationId)
  }

  /** Replace the last user message (and the answer to it) with new text, then answer that. */
  async editLast(conversationId: string, text: string): Promise<{ conversationId: string; done: Promise<void> }> {
    const lastUser = this.lastUserMessage(conversationId)
    this.removeFrom(conversationId, lastUser.id)
    return this.send(conversationId, text)
  }

  private lastUserMessage(conversationId: string): ChatMessage {
    if (this.running.has(conversationId)) throw new Error('Still answering the previous message')
    const lastUser = this.deps.store
      .getMessages(conversationId)
      .filter((m) => m.role === 'user')
      .pop()
    if (!lastUser) throw new Error('There is no message to redo in this chat.')
    return lastUser
  }

  private removeFrom(conversationId: string, messageId: string): void {
    this.deps.store.deleteMessagesFrom(conversationId, messageId)
    this.historyStart.delete(conversationId)
    this.deps.emit({ type: 'history', conversationId, messages: this.deps.store.getMessages(conversationId) })
  }

  private startTurn(convId: string): { conversationId: string; done: Promise<void> } {
    const { emit } = this.deps
    const settings = this.deps.getSettings()
    this.touch(convId, {
      providerId: settings.activeProviderId,
      model: settings.activeModel,
      characterId: settings.characterId
    })

    const controller = new AbortController()
    this.running.set(convId, controller)
    const done = this.runTurn(convId, controller.signal).finally(() => {
      this.running.delete(convId)
      emit({ type: 'thinking', conversationId: convId, active: false })
      emit({ type: 'turn-end', conversationId: convId })
    })
    return { conversationId: convId, done }
  }

  stop(conversationId: string): void {
    this.running.get(conversationId)?.abort()
    for (const [id, a] of this.approvals) {
      if (a.conversationId === conversationId) {
        a.resolve('deny')
        this.approvals.delete(id)
      }
    }
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id)
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): void {
    const a = this.approvals.get(requestId)
    if (!a) return
    this.approvals.delete(requestId)
    a.resolve(decision)
  }

  private touch(id: string, patch: Partial<Conversation> = {}): void {
    const updated = { ...patch, updatedAt: this.now() }
    this.deps.store.updateConversation(id, updated)
    const c = this.deps.store.getConversation(id)
    if (c) this.deps.emit({ type: 'conversation', conversation: c })
  }

  private async runTurn(convId: string, signal: AbortSignal): Promise<void> {
    const { store, emit } = this.deps
    emit({ type: 'turn-start', conversationId: convId })
    const settings = this.deps.getSettings()

    let provider: ChatProvider
    let budget: number
    try {
      const p = this.deps.getProvider(settings.activeProviderId)
      provider = p.provider
      budget = historyBudget(p.config)
    } catch (err) {
      emit({ type: 'error', conversationId: convId, message: err instanceof Error ? err.message : String(err) })
      return
    }

    const tools = this.deps.tools.toolDefs(settings.toolPermissions)
    const system = buildSystemPrompt({
      character: this.deps.getCharacter(settings.characterId),
      hasTools: tools.length > 0,
      platform: this.deps.platform ?? process.platform,
      date: new Date(this.now())
    })

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const messageId = crypto.randomUUID()
      let streamed = ''
      emit({ type: 'thinking', conversationId: convId, active: true })

      const history = fitHistory(store.getMessages(convId), budget, this.historyStart.get(convId))
      if (history.messages[0]) this.historyStart.set(convId, history.messages[0].id)

      let result
      try {
        result = await provider.stream(
          {
            model: settings.activeModel,
            system: history.trimmed ? `${system}\n\n${TRIMMED_NOTE}` : system,
            messages: history.messages,
            tools,
            effort: settings.effort,
            signal
          },
          {
            onText: (text) => {
              if (!streamed) emit({ type: 'thinking', conversationId: convId, active: false })
              streamed += text
              emit({ type: 'text-delta', conversationId: convId, messageId, text })
            },
            onThinking: (active) => emit({ type: 'thinking', conversationId: convId, active })
          }
        )
      } catch (err) {
        if (streamed) {
          // Keep what was already shown. No raw blocks, so it is replayed as plain text.
          this.save({
            id: messageId,
            conversationId: convId,
            role: 'assistant',
            parts: [{ type: 'text', text: streamed + (signal.aborted ? '' : ' …') }],
            createdAt: this.now()
          })
        }
        if (!signal.aborted) emit({ type: 'error', conversationId: convId, message: provider.describeError(err) })
        return
      }

      this.save({
        id: messageId,
        conversationId: convId,
        role: 'assistant',
        parts: result.parts,
        raw: result.raw,
        createdAt: this.now()
      })
      this.touch(convId)

      if (result.stopReason === 'refusal') {
        emit({ type: 'error', conversationId: convId, message: 'The model declined to answer this request.' })
        return
      }
      const calls = result.parts.filter((p): p is ToolCall => p.type === 'tool_call')
      if (!calls.length) {
        if (result.stopReason === 'max_tokens')
          emit({ type: 'error', conversationId: convId, message: 'The reply was cut off because it got too long.' })
        return
      }
      if (result.stopReason === 'max_tokens') {
        // A tool input cut off mid-way can still look valid; don't run it.
        this.saveToolResults(
          convId,
          calls.map((c) => errorResult(c, 'Not run: the request was cut off before the tool input was complete.'))
        )
        emit({ type: 'error', conversationId: convId, message: 'The reply was cut off before a tool call finished.' })
        return
      }

      emit({ type: 'thinking', conversationId: convId, active: true })
      const results = await Promise.all(calls.map((c) => this.runTool(convId, c, signal)))
      this.saveToolResults(convId, results)
      if (signal.aborted) return
    }
    emit({
      type: 'error',
      conversationId: convId,
      message: `Stopped after ${MAX_TOOL_ROUNDS} rounds of tool calls. Send another message to continue.`
    })
  }

  private save(m: ChatMessage): void {
    this.deps.store.addMessage(m)
    this.deps.emit({ type: 'message', conversationId: m.conversationId, message: m })
  }

  /** All results of one round go in a single message. */
  private saveToolResults(convId: string, parts: ChatPart[]): void {
    this.save({ id: crypto.randomUUID(), conversationId: convId, role: 'tool', parts, createdAt: this.now() })
  }

  private async runTool(convId: string, call: ToolCall, signal: AbortSignal): Promise<ChatPart> {
    const { emit } = this.deps
    const status = (s: Extract<ChatEvent, { type: 'tool-status' }>['status']) =>
      emit({ type: 'tool-status', conversationId: convId, toolCallId: call.id, status: s })

    if (signal.aborted) return errorResult(call, 'Cancelled by the user.')

    const schema = this.deps.tools.inputSchema(call.name)
    if (!schema) {
      status('error')
      return errorResult(call, `Unknown tool "${call.name}".`)
    }
    const invalid = this.validate(call.name, schema, call.input)
    if (invalid) {
      status('error')
      return errorResult(call, `Invalid tool input: ${invalid}. Fix the arguments and try again.`)
    }

    const permission =
      this.deps.getSettings().toolPermissions[call.name] ?? this.deps.tools.defaultPermission?.(call.name) ?? 'ask'
    if (permission === 'disabled') {
      status('denied')
      return errorResult(call, 'This tool is disabled by the user.')
    }
    if (permission === 'ask') {
      status('waiting')
      const decision = await this.askApproval(convId, call)
      if (decision === 'deny' || signal.aborted) {
        status('denied')
        return errorResult(call, signal.aborted ? 'Cancelled by the user.' : 'The user denied this tool call.')
      }
      if (decision === 'always') this.deps.setToolPermission(call.name, 'allow')
    }

    status('running')
    try {
      const r = await this.deps.tools.callTool(call.name, call.input, signal)
      status(r.isError ? 'error' : 'done')
      return { type: 'tool_result', toolCallId: call.id, name: call.name, content: r.content, isError: r.isError }
    } catch (err) {
      status('error')
      return errorResult(call, `Tool failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private askApproval(convId: string, call: ToolCall): Promise<ApprovalDecision> {
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      this.approvals.set(requestId, { conversationId: convId, resolve })
      this.deps.onApprovalNeeded?.()
      this.deps.emit({
        type: 'tool-approval',
        conversationId: convId,
        requestId,
        toolCallId: call.id,
        name: call.name,
        input: call.input
      })
    })
  }

  /** Returns an error message, or null when the input matches the tool's schema. */
  private validate(name: string, schema: Record<string, unknown>, input: unknown): string | null {
    if (input && typeof input === 'object' && '__invalid_json' in input) return 'arguments were not valid JSON'
    const key = name + JSON.stringify(schema)
    let fn = this.validators.get(key)
    if (fn === undefined) {
      try {
        const { $schema: _ignored, ...rest } = schema
        fn = this.ajv.compile(rest)
      } catch {
        fn = null // schema we can't compile: let the server validate it
      }
      this.validators.set(key, fn)
    }
    if (!fn || fn(input ?? {})) return null
    return this.ajv.errorsText(fn.errors, { dataVar: 'input' })
  }
}

const TRIMMED_NOTE =
  'This is a long chat, so its oldest messages were left out to save space. If the user refers to something you can no longer see, say so and ask them to repeat it.'

function errorResult(call: ToolCall, message: string): ChatPart {
  return { type: 'tool_result', toolCallId: call.id, name: call.name, content: message, isError: true }
}
