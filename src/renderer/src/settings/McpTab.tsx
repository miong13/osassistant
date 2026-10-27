import { useEffect, useState } from 'react'
import { parseMcpConfig, toMcpConfigJson } from '../../../shared/mcpConfig'
import type { McpServerConfig, McpServerStatus, McpToolInfo, ToolPermission } from '../../../shared/types'
import { Switch } from './controls'
import type { TabProps } from './SettingsApp'

export function McpTab({ settings, update }: TabProps) {
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [builtin, setBuiltin] = useState<McpToolInfo[]>([])
  const [adding, setAdding] = useState(false)
  const [jsonMode, setJsonMode] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void window.api.mcpStatus().then(setStatus)
    void window.api.builtinTools().then(setBuiltin)
    return window.api.onMcpStatus(setStatus)
  }, [])

  const servers = settings.mcpServers
  const saveServers = (next: McpServerConfig[]) => update({ mcpServers: next })
  const setPermission = (tool: string, p: ToolPermission) =>
    void update({ toolPermissions: { ...settings.toolPermissions, [tool]: p } })

  return (
    <>
      <h1>Tools</h1>
      <p className="lede">
        Tools let your assistant do things on your computer, like opening apps, files and websites. Add more from
        MCP servers. Tools work with every AI provider. You approve each tool call unless you choose “Always allow”.
      </p>
      {builtin.length > 0 && (
        <div className="card">
          <div className="card-head">
            <span className="status-dot connected" />
            <h3 className="grow">Desktop</h3>
            <span className="badge">built-in</span>
          </div>
          <div className="muted">
            Open apps (Word, Excel, browsers, code editors, calendar, Teams, Zoom…), files, websites and meeting
            links. If an app isn’t installed, a similar one opens instead, like Numbers or LibreOffice for Excel.
          </div>
          <div className="note">
            These tools open apps but can’t see or change what’s inside them, like calendar events, emails or chat
            messages. For that, add an MCP server below, for example one for Google Calendar, Microsoft 365 or Slack.
          </div>
          <ToolRows tools={builtin} permissions={settings.toolPermissions} onPermission={setPermission} />
        </div>
      )}
      <h2 className="section-title">MCP servers</h2>
      <div className="toolbar">
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add server
        </button>
        <button
          className="btn"
          onClick={async () => setMessage((await window.api.importClaudeDesktopMcp()).message)}
        >
          Import from Claude Desktop
        </button>
        <button className="btn" onClick={() => setJsonMode(!jsonMode)}>
          {jsonMode ? 'Back to list' : 'Edit as JSON'}
        </button>
        {servers.length > 0 && (
          <button className="btn" onClick={() => void window.api.restartMcp()}>
            Restart all
          </button>
        )}
        {message && <span className="muted" style={{ alignSelf: 'center' }}>{message}</span>}
      </div>

      {adding && (
        <AddServerForm
          existing={servers.map((s) => s.name)}
          onCancel={() => setAdding(false)}
          onAdd={async (s) => {
            await saveServers([...servers, s])
            setAdding(false)
          }}
        />
      )}

      {jsonMode ? (
        <JsonEditor servers={servers} onSave={saveServers} />
      ) : (
        <>
          {servers.length === 0 && !adding && (
            <div className="card empty">
              No servers yet. Try adding the filesystem server: command <code>npx</code>, arguments{' '}
              <code>-y @modelcontextprotocol/server-filesystem ~/Desktop</code>
            </div>
          )}
          {servers.map((s) => (
            <ServerCard
              key={s.name}
              server={s}
              status={status.find((x) => x.name === s.name)}
              permissions={settings.toolPermissions}
              onToggle={(enabled) => void saveServers(servers.map((x) => (x.name === s.name ? { ...x, enabled } : x)))}
              onRemove={() => void saveServers(servers.filter((x) => x.name !== s.name))}
              onPermission={setPermission}
            />
          ))}
        </>
      )}
    </>
  )
}

function ServerCard(props: {
  server: McpServerConfig
  status?: McpServerStatus
  permissions: Record<string, ToolPermission>
  onToggle(enabled: boolean): void
  onRemove(): void
  onPermission(tool: string, p: ToolPermission): void
}) {
  const { server, status } = props
  const [showLogs, setShowLogs] = useState(false)
  const state = status?.status ?? (server.enabled ? 'connecting' : 'disabled')
  const summary = server.url ?? [server.command, ...(server.args ?? [])].join(' ')
  return (
    <div className="card">
      <div className="card-head">
        <span className={`status-dot ${state}`} title={state} />
        <h3 className="grow">{server.name}</h3>
        <span className="badge">{state}</span>
        <Switch label="Enabled" checked={server.enabled} onChange={props.onToggle} />
      </div>
      <div className="muted" style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
        {summary}
      </div>
      {status?.error && <div className="error-text" style={{ marginTop: 6 }}>{status.error}</div>}
      {status && status.tools.length > 0 && (
        <ToolRows tools={status.tools} permissions={props.permissions} onPermission={props.onPermission} />
      )}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
        <button className="btn small" onClick={() => void window.api.restartMcp(server.name)}>
          Restart
        </button>
        <button className="btn small" onClick={() => setShowLogs(!showLogs)}>
          {showLogs ? 'Hide logs' : 'Show logs'}
        </button>
        <button className="btn small danger" onClick={props.onRemove}>
          Remove
        </button>
      </div>
      {showLogs && <div className="logs">{status?.logs.join('\n') || 'No output yet.'}</div>}
    </div>
  )
}

function ToolRows(props: {
  tools: McpToolInfo[]
  permissions: Record<string, ToolPermission>
  onPermission(tool: string, p: ToolPermission): void
}) {
  return (
    <div className="tool-list">
      {props.tools.map((t) => (
        <div key={t.name} className="tool-row">
          <div className="info">
            <code>{t.originalName}</code>
            <div className="desc" title={t.description}>
              {t.description}
            </div>
          </div>
          <select
            className="field"
            style={{ width: 130 }}
            value={props.permissions[t.name] ?? 'ask'}
            onChange={(e) => props.onPermission(t.name, e.target.value as ToolPermission)}
          >
            <option value="ask">Ask first</option>
            <option value="allow">Always allow</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      ))}
    </div>
  )
}

function AddServerForm(props: { existing: string[]; onAdd(s: McpServerConfig): void; onCancel(): void }) {
  const [type, setType] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('npx')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const n = name.trim()
    if (!n) return setError('Give the server a name.')
    if (props.existing.includes(n)) return setError('A server with this name already exists.')
    if (type === 'stdio') {
      if (!command.trim()) return setError('Enter a command.')
      props.onAdd({
        name: n,
        enabled: true,
        command: command.trim(),
        args: splitArgs(args),
        env: parsePairs(env, '=')
      })
    } else {
      try {
        new URL(url)
      } catch {
        return setError('Enter a valid URL.')
      }
      props.onAdd({ name: n, enabled: true, url: url.trim(), headers: parsePairs(headers, ':') })
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">New MCP server</h3>
      </div>
      <div className="form-grid">
        <label>Name</label>
        <input className="field" value={name} placeholder="filesystem" onChange={(e) => setName(e.target.value)} />
        <label>Type</label>
        <select className="field" value={type} onChange={(e) => setType(e.target.value as 'stdio' | 'http')}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Remote URL (streamable HTTP)</option>
        </select>
        {type === 'stdio' ? (
          <>
            <label>Command</label>
            <input className="field" value={command} onChange={(e) => setCommand(e.target.value)} />
            <label>Arguments</label>
            <input
              className="field"
              value={args}
              placeholder='-y @modelcontextprotocol/server-filesystem "~/My Files"'
              onChange={(e) => setArgs(e.target.value)}
            />
            <label>Environment</label>
            <textarea className="field" rows={2} value={env} placeholder="KEY=value (one per line)" onChange={(e) => setEnv(e.target.value)} />
          </>
        ) : (
          <>
            <label>URL</label>
            <input className="field" value={url} placeholder="https://example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
            <label>Headers</label>
            <textarea
              className="field"
              rows={2}
              value={headers}
              placeholder="Authorization: Bearer … (one per line)"
              onChange={(e) => setHeaders(e.target.value)}
            />
          </>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
        <button className="btn primary" onClick={submit}>
          Add server
        </button>
        <button className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function JsonEditor(props: { servers: McpServerConfig[]; onSave(s: McpServerConfig[]): Promise<void> }) {
  const [text, setText] = useState(() => toMcpConfigJson(props.servers))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  return (
    <div className="card">
      <p className="muted" style={{ marginTop: 0 }}>
        Same format as Claude Desktop’s <code>claude_desktop_config.json</code>.
      </p>
      <textarea className="field" rows={18} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      {error && <p className="error-text">{error}</p>}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, alignItems: 'center' }}>
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await props.onSave(parseMcpConfig(text))
              setError(null)
              setSaved(true)
              setTimeout(() => setSaved(false), 1500)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          Save
        </button>
        {saved && <span className="ok-text">Saved</span>}
      </div>
    </div>
  )
}

/** Split a command line into arguments, keeping "quoted parts" together. */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function parsePairs(s: string, sep: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of s.split('\n')) {
    const i = line.indexOf(sep)
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}
