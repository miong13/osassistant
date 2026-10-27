import type { McpServerConfig } from './types'

/**
 * Parse an MCP config in the Claude Desktop shape:
 * { "mcpServers": { "name": { "command", "args", "env" } | { "url", "headers" } } }
 */
export function parseMcpConfig(json: string): McpServerConfig[] {
  const data = JSON.parse(json) as { mcpServers?: Record<string, Record<string, unknown>> }
  const servers = data.mcpServers ?? (data as Record<string, Record<string, unknown>>)
  if (!servers || typeof servers !== 'object') throw new Error('No "mcpServers" object found')
  return Object.entries(servers).map(([name, s]) => {
    if (!s || typeof s !== 'object') throw new Error(`Server "${name}" is not an object`)
    if (typeof s.url === 'string') {
      return {
        name,
        enabled: s.disabled !== true,
        url: s.url,
        headers: (s.headers as Record<string, string>) ?? undefined
      }
    }
    if (typeof s.command !== 'string') throw new Error(`Server "${name}" needs a "command" or a "url"`)
    return {
      name,
      enabled: s.disabled !== true,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.map(String) : [],
      env: (s.env as Record<string, string>) ?? undefined
    }
  })
}

export function toMcpConfigJson(servers: McpServerConfig[]): string {
  const out: Record<string, unknown> = {}
  for (const s of servers) {
    const entry: Record<string, unknown> = s.url
      ? { url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
      : { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}) }
    if (!s.enabled) entry.disabled = true
    out[s.name] = entry
  }
  return JSON.stringify({ mcpServers: out }, null, 2)
}

/** Tool names the model sees: server__tool, limited to characters every provider accepts. */
export function exposedToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${clean(server)}__${clean(tool)}`.slice(0, 64)
}
