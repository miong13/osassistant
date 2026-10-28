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

/** An image costs roughly this many characters' worth of context (about 1,600 tokens). */
export const IMAGE_SIZE = 6_400

/** Rough size of a message as sent to a model, in characters (about 4 per token). */
export function messageSize(m: ChatMessage): number {
  let size = m.raw ? JSON.stringify(m.raw.content).length : 0
  for (const p of m.parts) size += p.type === 'image' ? IMAGE_SIZE : JSON.stringify(p).length
  return size
}

export type ImagePart = Extract<ChatPart, { type: 'image' }>

/** Images that were loaded for sending (parts without data are skipped). */
export function imagesOf(parts: ChatPart[]): (ImagePart & { data: string })[] {
  return parts.filter((p): p is ImagePart & { data: string } => p.type === 'image' && Boolean(p.data))
}

/** When history is over budget, it is cut down to this share of it, so the cut point stays put for a while. */
const REFILL = 0.6

/**
 * Keep the newest part of a chat that fits in `budget` characters. Cuts only right before a user
 * message, so tool calls stay paired with their results, and always keeps the latest user message.
 * `startId` is the first message kept last time: reusing it keeps the start of the history stable,
 * which lets providers reuse their prompt cache.
 */
export function fitHistory(
  messages: ChatMessage[],
  budget: number,
  startId?: string
): { messages: ChatMessage[]; trimmed: boolean } {
  const turnStarts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  if (!turnStarts.length) return { messages, trimmed: false }
  const sizes = messages.map(messageSize)
  const sizeFrom = (i: number) => sizes.slice(i).reduce((a, b) => a + b, 0)

  const prev = startId ? messages.findIndex((m) => m.id === startId) : -1
  let start = prev > 0 && turnStarts.includes(prev) ? prev : 0
  if (sizeFrom(start) > budget) {
    const last = turnStarts[turnStarts.length - 1]
    for (const t of turnStarts) {
      if (t <= start) continue
      start = t
      if (t === last || sizeFrom(t) <= budget * REFILL) break
    }
  }
  return start === 0 ? { messages, trimmed: false } : { messages: messages.slice(start), trimmed: true }
}

export function textOf(parts: ChatPart[]): string {
  return parts
    .filter((p): p is Extract<ChatPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}
