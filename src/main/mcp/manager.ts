import { EventEmitter } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpServerStatus, McpToolInfo, ToolPermission } from '../../shared/types'
import type { ToolDef } from '../providers/types'
import { exposedToolName } from '../../shared/mcpConfig'
import { stripHiddenChars } from '../guards'

interface ToolEntry extends McpToolInfo {
  inputSchema: Record<string, unknown>
}

interface ServerEntry {
  config: McpServerConfig
  client?: Client
  status: McpServerStatus
  tools: ToolEntry[]
}

export interface ToolCallResult {
  content: string
  isError: boolean
}

export interface ToolHost {
  toolDefs(permissions: Record<string, ToolPermission>): ToolDef[]
  inputSchema(name: string): Record<string, unknown> | undefined
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolCallResult>
}

/** One ToolHost over several (built-in tools first, then MCP). The first host to claim a name wins. */
export function combineToolHosts(hosts: ToolHost[]): ToolHost {
  const owner = (name: string) => hosts.find((h) => h.inputSchema(name))
  return {
    toolDefs(permissions) {
      const seen = new Set<string>()
      return hosts
        .flatMap((h) => h.toolDefs(permissions))
        .filter((t) => !seen.has(t.name) && Boolean(seen.add(t.name)))
    },
    inputSchema: (name) => owner(name)?.inputSchema(name),
    callTool(name, input, signal) {
      const host = owner(name)
      if (!host) return Promise.resolve({ content: `Tool "${name}" is not available.`, isError: true })
      return host.callTool(name, input, signal)
    }
  }
}

const MAX_RESULT_CHARS = 100_000
const MAX_LOG_LINES = 200

export class McpManager extends EventEmitter implements ToolHost {
  private servers = new Map<string, ServerEntry>()

  /** `isReserved` names belong to built-in tools, so servers can't take them over. */
  constructor(
    private getPath: () => string,
    private isReserved: (toolName: string) => boolean = () => false
  ) {
    super()
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({ ...s.status, tools: s.tools.map(stripSchema) }))
  }

  /** Connect/disconnect servers so they match the given config. */
  async sync(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Map(configs.map((c) => [c.name, c]))
    for (const [name, entry] of this.servers) {
      const next = wanted.get(name)
      if (!next || JSON.stringify(next) !== JSON.stringify(entry.config)) await this.disconnect(name)
    }
    await Promise.all(
      configs.filter((c) => !this.servers.has(c.name)).map((c) => this.connect(c))
    )
  }

  async restart(name?: string): Promise<void> {
    const targets = name ? [name] : [...this.servers.keys()]
    await Promise.all(
      targets.map(async (n) => {
        const entry = this.servers.get(n)
        if (!entry) return
        await this.disconnect(n)
        await this.connect(entry.config)
      })
    )
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((n) => this.disconnect(n)))
  }

  toolDefs(permissions: Record<string, ToolPermission>): ToolDef[] {
    return [...this.servers.values()]
      .filter((s) => s.status.status === 'connected')
      .flatMap((s) => s.tools)
      .filter((t) => permissions[t.name] !== 'disabled')
      .map((t) => ({
        name: t.name,
        description: `[${t.server}] ${t.description}`.slice(0, 1024),
        inputSchema: t.inputSchema
      }))
  }

  inputSchema(name: string): Record<string, unknown> | undefined {
    return this.findTool(name)?.tool.inputSchema
  }

  async callTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolCallResult> {
    const found = this.findTool(name)
    if (!found?.server.client) return { content: `Tool "${name}" is not available.`, isError: true }
    const result = await found.server.client.callTool(
      { name: found.tool.originalName, arguments: (input ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: 120_000 }
    )
    return { content: formatToolResult(result), isError: Boolean(result.isError) }
  }

  private findTool(name: string): { server: ServerEntry; tool: ToolEntry } | undefined {
    for (const server of this.servers.values()) {
      const tool = server.tools.find((t) => t.name === name)
      if (tool) return { server, tool }
    }
    return undefined
  }

  private changed(): void {
    this.emit('status', this.status())
  }

  private log(entry: ServerEntry, line: string): void {
    const logs = entry.status.logs
    for (const l of line.split('\n')) if (l.trim()) logs.push(l)
    if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES)
  }

  private async connect(config: McpServerConfig): Promise<void> {
    const entry: ServerEntry = {
      config,
      tools: [],
      status: { name: config.name, status: config.enabled ? 'connecting' : 'disabled', tools: [], logs: [] }
    }
    this.servers.set(config.name, entry)
    this.changed()
    if (!config.enabled) return

    const client = new Client({ name: 'os-assistant', version: '0.1.0' })
    try {
      let transport
      if (config.url) {
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined
        })
      } else if (config.command) {
        const stdio = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...getDefaultEnvironment(), PATH: this.getPath(), ...(config.env ?? {}) },
          stderr: 'pipe'
        })
        stdio.stderr?.on('data', (chunk: Buffer) => this.log(entry, chunk.toString()))
        transport = stdio
      } else {
        throw new Error('Server needs a command or a URL')
      }
      client.onerror = (err) => this.log(entry, `error: ${err.message}`)
      client.onclose = () => {
        if (this.servers.get(config.name) === entry && entry.status.status === 'connected') {
          entry.status = { ...entry.status, status: 'error', error: 'Server stopped' }
          this.changed()
        }
      }
      await withTimeout(client.connect(transport), 60_000, 'Timed out connecting')
      entry.client = client
      await this.loadTools(entry)
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        await this.loadTools(entry).catch((e) => this.log(entry, String(e)))
        this.changed()
      })
      entry.status = { ...entry.status, status: 'connected', error: undefined }
      this.log(entry, `connected (${entry.tools.length} tools)`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(entry, `failed: ${message}`)
      entry.status = { ...entry.status, status: 'error', error: message }
      await client.close().catch(() => {})
    }
    if (this.servers.get(config.name) === entry) this.changed()
  }

  private async loadTools(entry: ServerEntry): Promise<void> {
    if (!entry.client) return
    const tools: ToolEntry[] = []
    let cursor: string | undefined
    do {
      const page = await entry.client.listTools(cursor ? { cursor } : undefined)
      for (const t of page.tools) {
        const name = exposedToolName(entry.config.name, t.name)
        // Permissions are stored by this name, so a clash would let one server's tool
        // inherit another's "Always allow". Skip the newcomer instead.
        const owner = this.findTool(name)?.server
        if (this.isReserved(name) || (owner && owner !== entry) || tools.some((x) => x.name === name)) {
          this.log(entry, `skipped tool "${t.name}": its name clashes with another tool (${name})`)
          continue
        }
        tools.push({
          name,
          server: entry.config.name,
          originalName: t.name,
          description: stripHiddenChars(t.description ?? t.title ?? t.name),
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    entry.tools = tools
  }

  private async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name)
    this.servers.delete(name)
    if (entry?.client) await entry.client.close().catch(() => {})
    this.changed()
  }
}

function stripSchema(t: ToolEntry): McpToolInfo {
  return { name: t.name, server: t.server, originalName: t.originalName, description: t.description }
}

export function formatToolResult(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : []
  const pieces = content.map((c: Record<string, unknown>) => {
    if (c.type === 'text') return String(c.text)
    if (c.type === 'resource') {
      const r = c.resource as Record<string, unknown> | undefined
      return typeof r?.text === 'string' ? r.text : `[resource ${String(r?.uri ?? '')}]`
    }
    if (c.type === 'resource_link') return `[link ${String(c.uri)}]`
    if (c.type === 'image') return '[image returned by tool – not shown]'
    if (c.type === 'audio') return '[audio returned by tool – not shown]'
    return JSON.stringify(c)
  })
  let text = stripHiddenChars(pieces.join('\n'))
  if (!text && result.structuredContent) text = stripHiddenChars(JSON.stringify(result.structuredContent, null, 2))
  if (!text && 'toolResult' in result) text = stripHiddenChars(JSON.stringify(result.toolResult, null, 2))
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n…[truncated]'
  return text || '(no output)'
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}
