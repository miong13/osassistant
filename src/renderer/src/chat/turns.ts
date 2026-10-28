import type { ChatMessage, ChatPart } from '../../../shared/types'

export interface Turn {
  user?: ChatMessage
  replies: ChatMessage[]
}

/** Group messages into turns: a user message and everything that answered it. */
export function splitTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user') turns.push({ user: m, replies: [] })
    else if (turns.length) turns[turns.length - 1].replies.push(m)
    else turns.push({ replies: [m] })
  }
  return turns
}

export function textOf(parts: ChatPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** All the assistant text of a turn. */
export function answerText(turn: Turn | undefined): string {
  return (turn?.replies ?? [])
    .filter((m) => m.role === 'assistant')
    .map((m) => textOf(m.parts).trim())
    .filter(Boolean)
    .join('\n\n')
}
