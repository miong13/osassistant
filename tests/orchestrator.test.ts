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
