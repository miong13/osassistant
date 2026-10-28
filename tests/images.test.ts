import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AttachmentStore } from '../src/main/attachments'
import { Orchestrator } from '../src/main/chat/orchestrator'
import { toAnthropicMessages } from '../src/main/providers/anthropic'
import { fitHistory, IMAGE_SIZE, messageSize } from '../src/main/providers/history'
import { toOllamaMessages } from '../src/main/providers/ollama'
import { toOpenAIMessages } from '../src/main/providers/openaiCompatible'
import type { ChatProvider, StreamRequest } from '../src/main/providers/types'
import { captureScreen, screenshotSize } from '../src/main/screenshot'
import { MemoryChatStore } from '../src/main/store/chatStore'
import { withDefaults } from '../src/main/store/settings'
import type { ChatMessage } from '../src/shared/types'

const PNG = Buffer.from('fake png bytes').toString('base64')
const conv = '11111111-2222-3333-4444-555555555555'
const tempStore = () => new AttachmentStore(mkdtempSync(join(tmpdir(), 'osa-att-')))

describe('AttachmentStore', () => {
  it('saves, reads and deletes images per conversation', () => {
    const store = tempStore()
    const { id, mediaType } = store.save(conv, { mediaType: 'image/png', data: PNG })
    expect(store.read(conv, id, mediaType)).toBe(PNG)
    store.deleteConversation(conv)
    expect(store.read(conv, id, mediaType)).toBeNull()
  })

  it('rejects bad attachments before anything is saved', () => {
    expect(() => AttachmentStore.validate([{ mediaType: 'image/svg+xml', data: PNG }])).toThrow(/JPEG, PNG/)
    expect(() => AttachmentStore.validate([{ mediaType: 'image/png', data: 'not base64!' }])).toThrow(/Invalid image/)
    expect(() => AttachmentStore.validate(Array(5).fill({ mediaType: 'image/png', data: PNG }))).toThrow(/up to 4/)
    expect(() => AttachmentStore.validate('nope')).toThrow()
    expect(AttachmentStore.validate(undefined)).toEqual([])
  })

  it("can't be tricked into paths outside its folder", () => {
    const store = tempStore()
    expect(store.read(conv, '../../etc/passwd', 'image/png')).toBeNull()
    expect(() => store.save('../escape', { mediaType: 'image/png', data: PNG })).toThrow(/Invalid conversation/)
  })

  it('fills in image data only on the copies sent to a model', () => {
    const store = tempStore()
    const saved = store.save(conv, { mediaType: 'image/png', data: PNG })
    const msg: ChatMessage = { id: 'm', conversationId: conv, role: 'user', createdAt: 0, parts: [{ type: 'image', ...saved }] }
    const [hydrated] = store.hydrate([msg])
    expect(hydrated.parts[0]).toMatchObject({ type: 'image', data: PNG })
    expect(msg.parts[0]).not.toHaveProperty('data')
  })
})

describe('images in provider requests', () => {
  const msg: ChatMessage = {
    id: 'm',
    conversationId: conv,
    role: 'user',
    createdAt: 0,
    parts: [
      { type: 'image', id: 'i', mediaType: 'image/png', data: PNG },
      { type: 'text', text: "What's this?" }
    ]
  }

  it('anthropic: base64 image block', () => {
    expect(toAnthropicMessages([msg])[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: "What's this?" }
    ])
  })

  it('openai: content parts with a data URL', () => {
    expect(toOpenAIMessages('sys', [msg])[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: "What's this?" },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }
      ]
    })
  })

  it('ollama: images array', () => {
    expect(toOllamaMessages('sys', [msg])[1]).toEqual({ role: 'user', content: "What's this?", images: [PNG] })
  })

  it('counts an image at a fixed size when trimming history, not by its data', () => {
    const stored: ChatMessage = { ...msg, parts: [{ type: 'image', id: 'i', mediaType: 'image/png' }] }
    expect(messageSize(stored)).toBe(IMAGE_SIZE)
    expect(fitHistory([stored], IMAGE_SIZE + 10).trimmed).toBe(false)
  })
})

describe('Orchestrator with images', () => {
  function setup() {
    const store = new MemoryChatStore()
    const attachments = tempStore()
    const requests: StreamRequest[] = []
    const provider: ChatProvider = {
      listModels: async () => [],
      describeError: (e) => String(e),
      async stream(req) {
        requests.push(req)
        return { parts: [{ type: 'text', text: 'A cat.' }], stopReason: 'end' }
      }
    }
    const settings = withDefaults({})
    const orch = new Orchestrator({
      store,
      tools: { toolDefs: () => [], inputSchema: () => undefined, callTool: async () => ({ content: '', isError: true }) },
      getSettings: () => settings,
      getProvider: () => ({ provider, config: settings.providers[0] }),
      getCharacter: () => undefined,
      setToolPermission: () => undefined,
      emit: () => undefined,
      attachments,
      platform: 'darwin'
    })
    return { store, orch, requests }
  }

  it('saves the image as a file and sends its data to the model', async () => {
    const { store, orch, requests } = setup()
    const { conversationId, done } = await orch.send(null, '', [{ mediaType: 'image/png', data: PNG }])
    await done
    const [user] = store.getMessages(conversationId)
    expect(user.parts).toEqual([{ type: 'image', id: expect.any(String), mediaType: 'image/png' }])
    expect(requests[0].messages[0].parts[0]).toMatchObject({ type: 'image', data: PNG })
    expect(store.listConversations()[0].title).toBe('Image')
  })

  it('keeps the images when the last message is edited', async () => {
    const { store, orch } = setup()
    const first = await orch.send(null, 'whats this', [{ mediaType: 'image/png', data: PNG }])
    await first.done
    await (await orch.editLast(first.conversationId, "What's this?")).done
    const [user] = store.getMessages(first.conversationId)
    expect(user.parts.map((p) => p.type)).toEqual(['image', 'text'])
  })

  it('refuses an empty message', async () => {
    const { orch } = setup()
    await expect(orch.send(null, '  ')).rejects.toThrow(/Type a message/)
  })
})

describe('captureScreen', () => {
  const display = { id: 7, size: { width: 1728, height: 1117 }, scaleFactor: 2 }
  const shot = { display_id: '7', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') } }

  it('scales big displays down to 1568px on the long side', () => {
    expect(screenshotSize(display)).toEqual({ width: 1568, height: 1014 })
    expect(screenshotSize({ size: { width: 800, height: 600 }, scaleFactor: 1 })).toEqual({ width: 800, height: 600 })
  })

  it('hides the character while capturing, then shows it again', async () => {
    const calls: string[] = []
    const result = await captureScreen({
      platform: 'darwin',
      screenAccess: () => 'granted',
      openPrivacySettings: () => calls.push('settings'),
      display: () => display,
      getSources: async () => {
        calls.push('capture')
        return [shot]
      },
      setInvisible: (v) => calls.push(v ? 'hide' : 'show'),
      wait: async () => undefined
    })
    expect(result).toEqual({ mediaType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') })
    expect(calls).toEqual(['hide', 'capture', 'show'])
  })

  it('explains how to allow screen recording on macOS', async () => {
    let opened = false
    const result = await captureScreen({
      platform: 'darwin',
      screenAccess: () => 'denied',
      openPrivacySettings: () => (opened = true),
      display: () => display,
      getSources: async () => [shot],
      setInvisible: () => undefined
    })
    expect(result).toMatchObject({ error: expect.stringMatching(/Screen & System Audio Recording/) })
    expect(opened).toBe(true)
  })

  it('shows the character again even if capturing fails', async () => {
    let visible = true
    const result = await captureScreen({
      platform: 'win32',
      screenAccess: () => 'granted',
      openPrivacySettings: () => undefined,
      display: () => display,
      getSources: async () => {
        throw new Error('boom')
      },
      setInvisible: (v) => (visible = !v),
      wait: async () => undefined
    })
    expect(result).toEqual({ error: "Couldn't capture the screen." })
    expect(visible).toBe(true)
  })
})

it('temp dirs are cleaned up per conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osa-att-'))
  const store = new AttachmentStore(dir)
  store.save(conv, { mediaType: 'image/png', data: PNG })
  expect(existsSync(join(dir, conv))).toBe(true)
  store.deleteConversation(conv)
  expect(existsSync(join(dir, conv))).toBe(false)
})
