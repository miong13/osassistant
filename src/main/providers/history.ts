import type { ChatMessage, ChatPart } from '../../shared/types'

/**
 * Make history safe to send: every tool call must be followed by a result.
 * If a turn was stopped before its tools finished, add "cancelled" results to the
 * outgoing request (the stored history itself is never edited).
 */
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    out.push(m)
    if (m.role !== 'assistant') continue
    const calls = m.parts.filter((p) => p.type === 'tool_call')
    if (!calls.length) continue
    const next = messages[i + 1]
    const answered = new Set(
      next?.role === 'tool'
        ? next.parts.flatMap((p) => (p.type === 'tool_result' ? [p.toolCallId] : []))
        : []
    )
    const missing: ChatPart[] = calls
      .filter((c) => !answered.has(c.id))
      .map((c) => ({
        type: 'tool_result',
        toolCallId: c.id,
        name: c.name,
        content: 'Cancelled: the user stopped this before the tool ran.',
        isError: true
      }))
    if (!missing.length) continue
    if (next?.role === 'tool') {
      out.push({ ...next, parts: [...next.parts, ...missing] })
      i++
    } else {
      out.push({
        id: m.id + '-cancelled',
        conversationId: m.conversationId,
        role: 'tool',
        parts: missing,
        createdAt: m.createdAt
      })
    }
  }
  return out
}

export function textOf(parts: ChatPart[]): string {
  return parts
    .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
