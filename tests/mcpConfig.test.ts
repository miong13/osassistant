import { describe, expect, it } from 'vitest'
import { exposedToolName, parseMcpConfig, toMcpConfigJson } from '../src/shared/mcpConfig'
import { formatToolResult } from '../src/main/mcp/manager'

describe('mcp config', () => {
  it('parses Claude Desktop style configs and round-trips', () => {
    const json = JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, disabled: true }
      }
    })
    const servers = parseMcpConfig(json)
    expect(servers).toEqual([
      { name: 'filesystem', enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: undefined },
      { name: 'remote', enabled: false, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }
    ])
    expect(parseMcpConfig(toMcpConfigJson(servers))).toEqual(servers)
  })

  it('rejects servers without command or url', () => {
    expect(() => parseMcpConfig('{"mcpServers":{"x":{}}}')).toThrow(/command/)
  })

  it('makes tool names safe for every provider', () => {
    expect(exposedToolName('my server', 'read.file')).toBe('my_server__read_file')
    expect(exposedToolName('a'.repeat(50), 'b'.repeat(50))).toHaveLength(64)
  })

  it('formats tool results as text', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: '', mimeType: 'image/png' }] })).toBe(
      'hi\n[image returned by tool – not shown]'
    )
    expect(formatToolResult({ content: [], structuredContent: { a: 1 } })).toContain('"a": 1')
  })
})
