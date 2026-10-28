import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { fitHistory, messageSize, normalizeHistory } from '../src/main/providers/history'
import { historyBudget } from '../src/main/providers/index'
import { toAnthropicMessages } from '../src/main/providers/anthropic'
import { toOllamaMessages } from '../src/main/providers/ollama'
import { toOpenAIMessages } from '../src/main/providers/openaiCompatible'

const base = { conversationId: 'c', createdAt: 0 }
const user = (id: string, text: string): ChatMessage => ({ ...base, id, role: 'user', parts: [{ type: 'text', text }] })

const withTool: ChatMessage[] = [
  user('1', 'list files'),
  {
    ...base,
    id: '2',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Sure' },
      { type: 'tool_call', id: 'call_1', name: 'fs__list', input: { path: '/' } }
    ]
  },
  { ...base, id: '3', role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'call_1', name: 'fs__list', content: 'a.txt' }] },
  { ...base, id: '4', role: 'assistant', parts: [{ type: 'text', text: 'Found a.txt' }] }
]

describe('normalizeHistory', () => {
  it('adds cancelled results for tool calls that never got one', () => {
    const msgs = [...withTool.slice(0, 2), user('5', 'never mind')]
    const out = normalizeHistory(msgs)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(out[2].parts[0]).toMatchObject({ type: 'tool_result', toolCallId: 'call_1', isError: true })
  })

  it('leaves complete history alone', () => {
    expect(normalizeHistory(withTool)).toEqual(withTool)
  })
})

describe('fitHistory', () => {
  const reply = (id: string, text: string): ChatMessage => ({ ...base, id, role: 'assistant', parts: [{ type: 'text', text }] })
  // Five turns of roughly 100 characters each.
  const long: ChatMessage[] = [1, 2, 3, 4, 5].flatMap((n) => [user(`u${n}`, 'q'.repeat(30)), reply(`a${n}`, 'a'.repeat(30))])
  const turn = messageSize(long[0]) + messageSize(long[1])

  it('sends everything when it fits', () => {
    expect(fitHistory(long, turn * 10)).toEqual({ messages: long, trimmed: false })
  })

  it('drops whole old turns, down to 60% of the budget', () => {
    const out = fitHistory(long, turn * 4)
    expect(out.trimmed).toBe(true)
    expect(out.messages.map((m) => m.id)).toEqual(['u4', 'a4', 'u5', 'a5'])
  })

  it('never cuts between a tool call and its result', () => {
    const msgs = [...withTool, user('5', 'thanks'), reply('6', 'ok')]
    const out = fitHistory(msgs, messageSize(msgs[4]) + messageSize(msgs[5]) + 10)
    expect(out.messages[0].role).toBe('user')
    expect(out.messages.map((m) => m.id)).toEqual(['5', '6'])
  })

  it('keeps the latest user message even when it alone is too big', () => {
    const out = fitHistory(long, 10)
    expect(out.messages.map((m) => m.id)).toEqual(['u5', 'a5'])
  })

  it('keeps the previous start while it still fits', () => {
    const more = [...long, user('u6', 'q'.repeat(30)), reply('a6', 'a'.repeat(30))]
    expect(fitHistory(more, turn * 4, 'u4').messages[0].id).toBe('u4')
  })

  it('gives local models a smaller budget', () => {
    const ollama = historyBudget({ id: 'o', kind: 'ollama', label: 'Ollama', enabled: true })
    const lmStudio = historyBudget({ id: 'l', kind: 'openai-compatible', label: 'LM', baseUrl: 'http://localhost:1234/v1', enabled: true })
    const openai = historyBudget({ id: 'x', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: true })
    expect(ollama).toBe(lmStudio)
    expect(openai).toBeGreaterThan(lmStudio)
  })
})

describe('provider conversion', () => {
  it('anthropic: tool results become user turns', () => {
    const out = toAnthropicMessages(withTool)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt', is_error: undefined }])
  })

  it('anthropic: replays raw content blocks unchanged', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Hi' }]
    const out = toAnthropicMessages([
      user('1', 'hi'),
      { ...base, id: '2', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }], raw: { providerKind: 'anthropic', model: 'm', content: raw } }
    ])
    expect(out[1].content).toBe(raw)
  })

  it('anthropic: merges back-to-back user messages', () => {
    const out = toAnthropicMessages([user('1', 'a'), user('2', 'b')])
    expect(out).toHaveLength(1)
    expect(out[0].content).toHaveLength(2)
  })

  it('ollama: system first, tool results as tool messages', () => {
    const out = toOllamaMessages('sys', withTool)
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant'])
    expect(out[2].tool_calls?.[0].function).toEqual({ name: 'fs__list', arguments: { path: '/' } })
    expect(out[3]).toMatchObject({ content: 'a.txt', tool_name: 'fs__list' })
  })

  it('openai: tool calls carry ids and JSON arguments', () => {
    const out = toOpenAIMessages('sys', withTool)
    expect(out[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs__list', arguments: '{"path":"/"}' } }]
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'a.txt' })
  })
})
