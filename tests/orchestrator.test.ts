import { describe, expect, it, vi } from 'vitest'
import { Orchestrator } from '../src/main/chat/orchestrator'
import type { ToolHost } from '../src/main/mcp/manager'
import type { ChatProvider, StreamRequest, TurnResult } from '../src/main/providers/types'
import { MemoryChatStore } from '../src/main/store/chatStore'
import { withDefaults } from '../src/main/store/settings'
import type { ChatEvent, Settings } from '../src/shared/types'

function fakeProvider(turns: TurnResult[]): ChatProvider & { requests: StreamRequest[] } {
  const requests: StreamRequest[] = []
  return {
    requests,
    listModels: async () => [],
    describeError: (e) => `failed: ${String(e)}`,
    async stream(req, h) {
      requests.push({ ...req, messages: [...req.messages] })
      const turn = turns.shift()
      if (!turn) throw new Error('no more turns')
      for (const p of turn.parts) if (p.type === 'text') h.onText(p.text)
      return turn
    }
  }
}

const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }

function fakeTools(): ToolHost & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    toolDefs: () => [{ name: 'fs__read', description: 'read', inputSchema: schema }],
    inputSchema: (n) => (n === 'fs__read' ? schema : undefined),
    callTool: async (_n, input) => {
      calls.push(input)
      return { content: 'file contents', isError: false }
    }
  }
}

function setup(turns: TurnResult[], settingsPatch: Partial<Settings> = {}) {
  const store = new MemoryChatStore()
  const provider = fakeProvider(turns)
  const tools = fakeTools()
  let settings = withDefaults(settingsPatch)
  const events: ChatEvent[] = []
  const orch = new Orchestrator({
    store,
    tools,
    getSettings: () => settings,
    getProvider: () => ({ provider, config: settings.providers[0] }),
    getCharacter: () => undefined,
    setToolPermission: (name, p) => {
      settings = { ...settings, toolPermissions: { ...settings.toolPermissions, [name]: p } }
    },
    emit: (e) => {
      events.push(e)
      if (e.type === 'tool-approval') onApproval?.(e)
    },
    platform: 'darwin'
  })
  let onApproval: ((e: Extract<ChatEvent, { type: 'tool-approval' }>) => void) | undefined
  return { store, provider, tools, events, orch, setOnApproval: (f: typeof onApproval) => (onApproval = f) }
}

describe('Orchestrator', () => {
  const say = (text: string): TurnResult => ({ parts: [{ type: 'text', text }], stopReason: 'end' })
  const texts = (store: MemoryChatStore, id: string) =>
    store.getMessages(id).map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))

  it('retry replaces the last answer and keeps earlier turns', async () => {
    const { orch, store, events, provider } = setup([say('A1'), say('A2'), say('A2 again')])
    const first = await orch.send(null, 'Q1')
    await first.done
    await (await orch.send(first.conversationId, 'Q2')).done
    await (await orch.retry(first.conversationId)).done
    expect(texts(store, first.conversationId)).toEqual(['Q1', 'A1', 'Q2', 'A2 again'])
    // The retried request ends with the question, not the old answer.
    expect(provider.requests[2].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const history = events.find((e) => e.type === 'history')
    expect(history && history.type === 'history' && history.messages.length).toBe(3)
  })

  it('retry works when the last turn failed without an answer', async () => {
    const turns = [say('A1')]
    const { orch, store, events } = setup(turns)
    const first = await orch.send(null, 'Q1')
    await first.done
    await (await orch.send(first.conversationId, 'Q2')).done // provider has no turn left: error, no answer
    expect(texts(store, first.conversationId)).toEqual(['Q1', 'A1', 'Q2'])
    expect(events.some((e) => e.type === 'error')).toBe(true)
    turns.push(say('A2'))
    await (await orch.retry(first.conversationId)).done
    expect(texts(store, first.conversationId)).toEqual(['Q1', 'A1', 'Q2', 'A2'])
  })

  it('retry also removes tool calls and results from the old answer', async () => {
    const { orch, store } = setup(
      [
        { parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { path: '/a' } }], stopReason: 'tool_use' },
        say('Read it'),
        say('Fresh answer')
      ],
      { toolPermissions: { fs__read: 'allow' } }
    )
    const first = await orch.send(null, 'read /a')
    await first.done
    expect(store.getMessages(first.conversationId).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    await (await orch.retry(first.conversationId)).done
    expect(store.getMessages(first.conversationId).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(texts(store, first.conversationId)).toEqual(['read /a', 'Fresh answer'])
  })

  it('editLast on the first message keeps the chat and its id', async () => {
    const { orch, store } = setup([say('A1'), say('A1 edited')])
    const first = await orch.send(null, 'Q1 typo')
    await first.done
    const again = await orch.editLast(first.conversationId, 'Q1 fixed')
    await again.done
    expect(again.conversationId).toBe(first.conversationId)
    expect(texts(store, first.conversationId)).toEqual(['Q1 fixed', 'A1 edited'])
  })

  it('refuses to edit while a reply is still running, and changes nothing', async () => {
    const { orch, store } = setup([say('A1')])
    const first = await orch.send(null, 'Q1')
    await expect(orch.editLast(first.conversationId, 'other')).rejects.toThrow(/Still answering/)
    await first.done
    expect(texts(store, first.conversationId)).toEqual(['Q1', 'A1'])
  })

  it('refuses to retry or edit a chat with no messages', async () => {
    const { orch, store } = setup([])
    store.createConversation({
      id: 'empty',
      title: 'Empty',
      characterId: 'sticky',
      providerId: 'anthropic',
      model: 'm',
      createdAt: 0,
      updatedAt: 0
    })
    await expect(orch.retry('empty')).rejects.toThrow(/no message to redo/)
    await expect(orch.editLast('empty', 'hi')).rejects.toThrow(/no message to redo/)
  })

  it('sends only recent turns of a long chat and tells the model', async () => {
    const big = 'x'.repeat(250_000) // two of these are over Claude's 400k-character history budget
    const { orch, provider } = setup([say('A1'), say('A2')])
    const first = await orch.send(null, `${big} 1`)
    await first.done
    expect(provider.requests[0].system).not.toMatch(/oldest messages were left out/)
    await (await orch.send(first.conversationId, `${big} 2`)).done
    const req = provider.requests[1]
    expect(req.messages.map((m) => m.role)).toEqual(['user'])
    expect(req.messages[0].parts[0]).toMatchObject({ text: `${big} 2` })
    expect(req.system).toMatch(/oldest messages were left out/)
  })

  it('editLast swaps the last question and its answer', async () => {
    const { orch, store } = setup([say('A1'), say('A2'), say('A2 edited')])
    const first = await orch.send(null, 'Q1')
    await first.done
    await (await orch.send(first.conversationId, 'Q2 typo')).done
    await (await orch.editLast(first.conversationId, 'Q2 fixed')).done
    expect(texts(store, first.conversationId)).toEqual(['Q1', 'A1', 'Q2 fixed', 'A2 edited'])
  })

  it('refuses to retry while a reply is still running', async () => {
    const { orch } = setup([say('A1')])
    const first = await orch.send(null, 'Q1')
    await expect(orch.retry(first.conversationId)).rejects.toThrow(/Still answering/)
    await first.done
  })

  it('runs a plain chat turn and saves both messages', async () => {
    const { orch, store, events } = setup([{ parts: [{ type: 'text', text: 'Hello!' }], stopReason: 'end' }])
    const { conversationId, done } = await orch.send(null, 'Hi there')
    await done
    const msgs = store.getMessages(conversationId)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(store.getConversation(conversationId)?.title).toBe('Hi there')
    expect(events.some((e) => e.type === 'text-delta' && e.text === 'Hello!')).toBe(true)
    expect(events.at(-1)?.type).toBe('turn-end')
  })

  it('asks for approval, runs the tool, then continues', async () => {
    const { orch, store, tools, provider, setOnApproval } = setup([
      { parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { path: '/a' } }], stopReason: 'tool_use' },
      { parts: [{ type: 'text', text: 'It says: file contents' }], stopReason: 'end' }
    ])
    setOnApproval((e) => orch.resolveApproval(e.requestId, 'allow'))
    const { conversationId, done } = await orch.send(null, 'read /a')
    await done
    expect(tools.calls).toEqual([{ path: '/a' }])
    expect(store.getMessages(conversationId).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // second request includes the tool result
    expect(provider.requests[1].messages.at(-1)?.role).toBe('tool')
  })

  it('does not run a denied tool', async () => {
    const { orch, store, tools, setOnApproval } = setup([
      { parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { path: '/a' } }], stopReason: 'tool_use' },
      { parts: [{ type: 'text', text: 'OK, I will not.' }], stopReason: 'end' }
    ])
    setOnApproval((e) => orch.resolveApproval(e.requestId, 'deny'))
    const { conversationId, done } = await orch.send(null, 'read /a')
    await done
    expect(tools.calls).toEqual([])
    const result = store.getMessages(conversationId)[2].parts[0]
    expect(result).toMatchObject({ type: 'tool_result', isError: true })
  })

  it('skips approval for always-allowed tools', async () => {
    const approval = vi.fn()
    const { orch, tools, setOnApproval } = setup(
      [
        { parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { path: '/a' } }], stopReason: 'tool_use' },
        { parts: [{ type: 'text', text: 'done' }], stopReason: 'end' }
      ],
      { toolPermissions: { fs__read: 'allow' } }
    )
    setOnApproval(approval)
    const { done } = await orch.send(null, 'read')
    await done
    expect(approval).not.toHaveBeenCalled()
    expect(tools.calls).toHaveLength(1)
  })

  it('rejects tool input that does not match the schema without running it', async () => {
    const { orch, store, tools } = setup(
      [
        { parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { nope: 1 } }], stopReason: 'tool_use' },
        { parts: [{ type: 'text', text: 'sorry' }], stopReason: 'end' }
      ],
      { toolPermissions: { fs__read: 'allow' } }
    )
    const { conversationId, done } = await orch.send(null, 'read')
    await done
    expect(tools.calls).toEqual([])
    const part = store.getMessages(conversationId)[2].parts[0]
    expect(part).toMatchObject({ isError: true })
    expect((part as { content: string }).content).toMatch(/Invalid tool input/)
  })

  it('does not run tools when the reply was cut off at max_tokens', async () => {
    const { orch, tools, events } = setup(
      [{ parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { path: '/a' } }], stopReason: 'max_tokens' }],
      { toolPermissions: { fs__read: 'allow' } }
    )
    const { done } = await orch.send(null, 'read')
    await done
    expect(tools.calls).toEqual([])
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('stop() during approval cancels the tool and ends the turn', async () => {
    const { orch, tools, setOnApproval } = setup([
      { parts: [{ type: 'tool_call', id: 'c1', name: 'fs__read', input: { path: '/a' } }], stopReason: 'tool_use' }
    ])
    setOnApproval((e) => orch.stop(e.conversationId))
    const { done, conversationId } = await orch.send(null, 'read')
    await done
    expect(tools.calls).toEqual([])
    expect(orch.isRunning(conversationId)).toBe(false)
  })

  it('reports provider errors', async () => {
    const { orch, events } = setup([])
    const { done } = await orch.send(null, 'hi')
    await done
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'failed: Error: no more turns' })
  })
})

describe('MemoryChatStore.deleteMessagesFrom', () => {
  const msg = (id: string, conversationId: string) => ({
    id,
    conversationId,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: id }],
    createdAt: 0
  })

  it('removes the message and later ones in that chat only', () => {
    const store = new MemoryChatStore()
    for (const m of [msg('a1', 'a'), msg('b1', 'b'), msg('a2', 'a'), msg('a3', 'a'), msg('b2', 'b')]) store.addMessage(m)
    store.deleteMessagesFrom('a', 'a2')
    expect(store.getMessages('a').map((m) => m.id)).toEqual(['a1'])
    expect(store.getMessages('b').map((m) => m.id)).toEqual(['b1', 'b2'])
  })

  it('does nothing for an unknown message or a message from another chat', () => {
    const store = new MemoryChatStore()
    for (const m of [msg('a1', 'a'), msg('b1', 'b')]) store.addMessage(m)
    store.deleteMessagesFrom('a', 'missing')
    store.deleteMessagesFrom('a', 'b1')
    expect(store.messages.map((m) => m.id)).toEqual(['a1', 'b1'])
  })
})
