import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { exposedToolName } from '../shared/mcpConfig'
import type { McpToolInfo, MemoryItem, ToolPermission } from '../shared/types'
import { looksLikeSecret, singleLine } from './guards'
import type { ToolCallResult, ToolHost } from './mcp/manager'
import type { ToolDef } from './providers/types'

export const MEMORY_SERVER = 'memory'
export const MAX_MEMORIES = 100
export const MAX_MEMORY_CHARS = 300

const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'remember',
    description:
      'Save one short, lasting fact about the user for future chats, e.g. "Prefers metric units" or ' +
      '"Works in Excel at a bank". Use it when they share a lasting preference or fact, or ask you to remember something. ' +
      "Don't save passwords, keys, or sensitive details (health, money, other people's private info) unless they ask.",
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'One fact, one short sentence' } },
      required: ['fact']
    }
  },
  {
    name: 'forget',
    description: 'Delete a saved fact by its id, when the user asks you to forget it or it is no longer true.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  }
]

const exposed = (tool: string) => exposedToolName(MEMORY_SERVER, tool)

/**
 * Facts the assistant remembers across chats. Off unless the user turns it on; the user can see,
 * add and delete every fact in Settings → Memory. Emits 'change' with the new list.
 */
export class Memory extends EventEmitter implements ToolHost {
  private items: MemoryItem[]
  private byName = new Map(TOOLS.map((t) => [exposed(t.name), t]))

  constructor(
    private opts: { file?: string; isEnabled: () => boolean; now?: () => number }
  ) {
    super()
    this.items = this.load()
  }

  list(): MemoryItem[] {
    return [...this.items]
  }

  /** Throws a message for the user or model when the fact can't be saved. */
  add(text: string): MemoryItem {
    const fact = singleLine(text.replace(/\s+/g, ' '), MAX_MEMORY_CHARS + 1)
    if (!fact) throw new Error('The fact is empty.')
    if (fact.length > MAX_MEMORY_CHARS) throw new Error(`Keep it under ${MAX_MEMORY_CHARS} characters.`)
    if (looksLikeSecret(fact)) throw new Error("That looks like a password or key, so it wasn't saved.")
    const same = this.items.find((m) => m.text.toLowerCase() === fact.toLowerCase())
    if (same) return same
    if (this.items.length >= MAX_MEMORIES) throw new Error('Memory is full. Delete some facts in Settings → Memory first.')
    const item: MemoryItem = { id: crypto.randomUUID().slice(0, 8), text: fact, createdAt: this.opts.now?.() ?? Date.now() }
    this.items.push(item)
    this.changed()
    return item
  }

  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((m) => m.id !== id)
    if (this.items.length === before) return false
    this.changed()
    return true
  }

  clear(): void {
    this.items = []
    this.changed()
  }

  /** The facts for the system prompt, or null when memory is off. */
  forPrompt(): MemoryItem[] | null {
    return this.opts.isEnabled() ? this.list() : null
  }

  // ---------- tools (only while memory is on) ----------

  has(name: string): boolean {
    return this.byName.has(name)
  }

  info(): McpToolInfo[] {
    return TOOLS.map((t) => ({
      name: exposed(t.name),
      server: MEMORY_SERVER,
      originalName: t.name,
      description: t.description,
      defaultPermission: 'allow'
    }))
  }

  /** Memory is opt-in and every fact shows in Settings, so saving doesn't need approval each time. */
  defaultPermission(name: string): ToolPermission | undefined {
    return this.byName.has(name) ? 'allow' : undefined
  }

  toolDefs(permissions: Record<string, ToolPermission>): ToolDef[] {
    if (!this.opts.isEnabled()) return []
    return TOOLS.filter((t) => permissions[exposed(t.name)] !== 'disabled').map((t) => ({
      name: exposed(t.name),
      description: `[${MEMORY_SERVER}] ${t.description}`,
      inputSchema: t.inputSchema
    }))
  }

  inputSchema(name: string): Record<string, unknown> | undefined {
    return this.opts.isEnabled() ? this.byName.get(name)?.inputSchema : undefined
  }

  async callTool(name: string, input: unknown, _signal?: AbortSignal): Promise<ToolCallResult> {
    if (!this.opts.isEnabled() || !this.byName.has(name)) return { content: 'Memory is turned off.', isError: true }
    const args = (input ?? {}) as Record<string, unknown>
    try {
      if (name === exposed('remember')) {
        const item = this.add(String(args.fact ?? ''))
        return { content: `Remembered (id ${item.id}): ${item.text}`, isError: false }
      }
      const id = String(args.id ?? '')
      return this.remove(id)
        ? { content: `Forgot fact ${id}.`, isError: false }
        : { content: `No saved fact with id ${id}.`, isError: true }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  // ---------- storage ----------

  private changed(): void {
    this.save()
    this.emit('change', this.list())
  }

  private load(): MemoryItem[] {
    const file = this.opts.file
    if (!file || !existsSync(file)) return []
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(data)
        ? data.filter((m): m is MemoryItem => m && typeof m.id === 'string' && typeof m.text === 'string').slice(0, MAX_MEMORIES)
        : []
    } catch {
      return []
    }
  }

  private save(): void {
    const file = this.opts.file
    if (!file) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(this.items, null, 2))
    renameSync(`${file}.tmp`, file)
  }
}
