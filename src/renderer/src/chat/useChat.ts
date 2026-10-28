import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ChatEvent, ChatMessage, Conversation } from '../../../shared/types'

export interface PendingApproval {
  requestId: string
  toolCallId: string
  name: string
  input: unknown
}

export type ToolStatus = Extract<ChatEvent, { type: 'tool-status' }>['status']

export interface ChatState {
  conversationId: string | null
  messages: ChatMessage[]
  /** Text streaming in for assistant messages that aren't saved yet. */
  streaming: Record<string, string>
  busy: boolean
  thinking: boolean
  error: string | null
  toolStatus: Record<string, ToolStatus>
  approvals: PendingApproval[]
  /** Time of the last streamed text, used to animate the character "talking". */
  lastDeltaAt: number
  conversations: Conversation[]
}

const initial: ChatState = {
  conversationId: null,
  messages: [],
  streaming: {},
  busy: false,
  thinking: false,
  error: null,
  toolStatus: {},
  approvals: [],
  lastDeltaAt: 0,
  conversations: []
}

export function useChat() {
  const [state, setState] = useState<ChatState>(initial)
  const currentId = useRef<string | null>(null)
  /** Set while the first message of a new chat is in flight, so we adopt its id. */
  const adoptNext = useRef(false)

  const refreshConversations = useCallback(async (query?: string) => {
    const conversations = await window.api.listConversations(query)
    setState((s) => ({ ...s, conversations }))
  }, [])

  useEffect(() => {
    void refreshConversations()
    return window.api.onChatEvent((e) => {
      if (e.type === 'conversation') {
        setState((s) => {
          const others = s.conversations.filter((c) => c.id !== e.conversation.id)
          return { ...s, conversations: [e.conversation, ...others].sort((a, b) => b.updatedAt - a.updatedAt) }
        })
        return
      }
      if (adoptNext.current && e.type === 'message' && currentId.current === null) {
        currentId.current = e.conversationId
        adoptNext.current = false
        setState((s) => ({ ...s, conversationId: e.conversationId }))
      }
      if (e.conversationId !== currentId.current) return
      setState((s) => reduce(s, e))
    })
  }, [refreshConversations])

  const open = useCallback(async (id: string | null) => {
    currentId.current = id
    adoptNext.current = false
    const messages = id ? await window.api.getMessages(id) : []
    setState((s) => ({ ...initial, conversations: s.conversations, conversationId: id, messages }))
  }, [])

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (currentId.current === null) adoptNext.current = true
    setState((s) => ({ ...s, error: null, busy: true }))
    try {
      const id = await window.api.sendMessage(currentId.current, trimmed)
      if (currentId.current === null) {
        currentId.current = id
        adoptNext.current = false
        setState((s) => ({ ...s, conversationId: id }))
      }
    } catch (err) {
      adoptNext.current = false
      setState((s) => ({ ...s, busy: false, error: cleanIpcError(err) }))
    }
  }, [])

  /** Run retry / edit for the open chat, showing any error in the chat. */
  const redo = useCallback(async (action: (id: string) => Promise<void>) => {
    const id = currentId.current
    if (!id) return
    setState((s) => ({ ...s, error: null, busy: true }))
    try {
      await action(id)
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: cleanIpcError(err) }))
    }
  }, [])
  const retry = useCallback(() => redo((id) => window.api.retry(id)), [redo])
  const editLast = useCallback(
    (text: string) => (text.trim() ? redo((id) => window.api.editLast(id, text.trim())) : Promise.resolve()),
    [redo]
  )

  const stop = useCallback(() => {
    if (currentId.current) void window.api.stop(currentId.current)
  }, [])

  const approve = useCallback((requestId: string, decision: ApprovalDecision) => {
    void window.api.approveTool(requestId, decision)
    setState((s) => ({ ...s, approvals: s.approvals.filter((a) => a.requestId !== requestId) }))
  }, [])

  const dismissError = useCallback(() => setState((s) => ({ ...s, error: null })), [])

  const remove = useCallback(
    async (id: string) => {
      await window.api.deleteConversation(id)
      if (currentId.current === id) await open(null)
      await refreshConversations()
    },
    [open, refreshConversations]
  )

  return { state, open, send, retry, editLast, stop, approve, dismissError, remove, refreshConversations }
}

function reduce(s: ChatState, e: ChatEvent): ChatState {
  switch (e.type) {
    case 'turn-start':
      return { ...s, busy: true, error: null }
    case 'thinking':
      return { ...s, thinking: e.active }
    case 'text-delta':
      return {
        ...s,
        thinking: false,
        lastDeltaAt: Date.now(),
        streaming: { ...s.streaming, [e.messageId]: (s.streaming[e.messageId] ?? '') + e.text }
      }
    case 'message': {
      const { [e.message.id]: _done, ...streaming } = s.streaming
      if (s.messages.some((m) => m.id === e.message.id)) return { ...s, streaming }
      return { ...s, streaming, messages: [...s.messages, e.message] }
    }
    case 'history':
      return { ...s, messages: e.messages, streaming: {}, toolStatus: {}, error: null }
    case 'tool-approval':
      return {
        ...s,
        approvals: [
          ...s.approvals,
          { requestId: e.requestId, toolCallId: e.toolCallId, name: e.name, input: e.input }
        ]
      }
    case 'tool-status':
      return { ...s, toolStatus: { ...s.toolStatus, [e.toolCallId]: e.status } }
    case 'error':
      return { ...s, error: e.message }
    case 'turn-end':
      return { ...s, busy: false, thinking: false, streaming: {}, approvals: [] }
    default:
      return s
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
