import { exposedToolName } from '../../shared/mcpConfig'
import type { McpToolInfo, ToolPermission } from '../../shared/types'
import { stripHiddenChars } from '../guards'
import type { ToolCallResult, ToolHost } from '../mcp/manager'
import type { ToolDef } from '../providers/types'

export const SYSTEM_SERVER = 'system'
const MAX_CLIPBOARD = 20_000

export interface SystemDeps {
  platform: string
  osName: string
  osVersion: string
  home: string
  uptimeSeconds(): number
  memory(): { total: number; free: number }
  /** Free and total bytes on the disk that holds `path`. */
  disk(path: string): Promise<{ free: number; total: number }>
  isOnline(): boolean
  darkMode(): boolean
  readClipboard(): string
  writeClipboard(text: string): void
  /** Runs a program (no shell) and resolves with its stdout. */
  exec(file: string, args: string[]): Promise<string>
}

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  permission: ToolPermission
  platforms?: string[]
}

const TOOLS: Tool[] = [
  {
    name: 'system_info',
    description:
      'Get facts about this computer: OS version, battery level and charging, free disk space, memory, ' +
      'whether it is online, dark mode, and the sound volume (macOS).',
    inputSchema: { type: 'object', properties: {} },
    permission: 'allow'
  },
  {
    name: 'set_volume',
    description: 'Set the sound output volume (0-100) and/or mute or unmute it. macOS only.',
    inputSchema: {
      type: 'object',
      properties: { percent: { type: 'number', minimum: 0, maximum: 100 }, muted: { type: 'boolean' } }
    },
    permission: 'allow',
    platforms: ['darwin']
  },
  {
    name: 'set_dark_mode',
    description: 'Turn dark mode on or off for the whole system.',
    inputSchema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
    permission: 'allow',
    platforms: ['darwin', 'win32']
  },
  {
    name: 'read_clipboard',
    description: 'Read the text the user last copied. Only when they ask you to look at what they copied.',
    inputSchema: { type: 'object', properties: {} },
    permission: 'ask'
  },
  {
    name: 'write_clipboard',
    description: 'Put text on the clipboard so the user can paste it.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    permission: 'ask'
  }
]

const exposed = (tool: string) => exposedToolName(SYSTEM_SERVER, tool)

class SystemError extends Error {}

/** Built-in tools for checking and adjusting the computer. */
export class SystemTools implements ToolHost {
  private tools: Tool[]
  private byName: Map<string, Tool>

  constructor(private deps: SystemDeps) {
    this.tools = TOOLS.filter((t) => !t.platforms || t.platforms.includes(deps.platform))
    this.byName = new Map(this.tools.map((t) => [exposed(t.name), t]))
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  info(): McpToolInfo[] {
    return this.tools.map((t) => ({
      name: exposed(t.name),
      server: SYSTEM_SERVER,
      originalName: t.name,
      description: t.description,
      defaultPermission: t.permission
    }))
  }

  defaultPermission(name: string): ToolPermission | undefined {
    return this.byName.get(name)?.permission
  }

  toolDefs(permissions: Record<string, ToolPermission>): ToolDef[] {
    return this.tools
      .filter((t) => (permissions[exposed(t.name)] ?? t.permission) !== 'disabled')
      .map((t) => ({ name: exposed(t.name), description: `[${SYSTEM_SERVER}] ${t.description}`, inputSchema: t.inputSchema }))
  }

  inputSchema(name: string): Record<string, unknown> | undefined {
    return this.byName.get(name)?.inputSchema
  }

  async callTool(name: string, input: unknown, _signal?: AbortSignal): Promise<ToolCallResult> {
    const tool = this.byName.get(name)
    if (!tool) return { content: `Tool "${name}" is not available.`, isError: true }
    try {
      const content = await this.run(tool.name, (input ?? {}) as Record<string, unknown>)
      return { content: stripHiddenChars(content), isError: false }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  private async run(tool: string, a: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case 'system_info':
        return this.systemInfo()
      case 'set_volume':
        return this.setVolume(a.percent, a.muted)
      case 'set_dark_mode':
        return this.setDarkMode(a.on === true)
      case 'read_clipboard': {
        const text = this.deps.readClipboard()
        if (!text.trim()) return 'The clipboard has no text.'
        return text.length > MAX_CLIPBOARD ? `${text.slice(0, MAX_CLIPBOARD)}\n… (cut off)` : text
      }
      case 'write_clipboard': {
        const text = String(a.text ?? '')
        if (!text) throw new SystemError('text is required.')
        this.deps.writeClipboard(text)
        return `Copied ${text.length} characters to the clipboard.`
      }
      default:
        throw new SystemError(`Unknown tool "${tool}".`)
    }
  }

  private async systemInfo(): Promise<string> {
    const d = this.deps
    const mem = d.memory()
    const lines = [
      `OS: ${d.osName} ${d.osVersion}`,
      `Up for: ${formatDuration(d.uptimeSeconds())}`,
      `Memory: ${gb(mem.total - mem.free)} of ${gb(mem.total)} used`,
      `Online: ${d.isOnline() ? 'yes' : 'no'}`,
      `Dark mode: ${d.darkMode() ? 'on' : 'off'}`
    ]
    const [disk, battery, volume] = await Promise.all([
      d.disk(d.home).catch(() => null),
      this.battery().catch(() => null),
      d.platform === 'darwin' ? this.volume().catch(() => null) : Promise.resolve(null)
    ])
    if (disk) lines.push(`Disk: ${gb(disk.free)} free of ${gb(disk.total)}`)
    lines.push(`Battery: ${battery ? describeBattery(battery) : 'unknown'}`)
    if (volume) lines.push(`Volume: ${volume.muted ? 'muted' : `${volume.percent}%`}`)
    return lines.join('\n')
  }

  private async battery(): Promise<Battery | null> {
    if (this.deps.platform === 'darwin') return parsePmset(await this.deps.exec('pmset', ['-g', 'batt']))
    if (this.deps.platform === 'win32')
      return parseWindowsBattery(
        await this.deps.exec('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'
        ])
      )
    return null
  }

  private async volume(): Promise<{ percent: number; muted: boolean } | null> {
    return parseVolumeSettings(await this.deps.exec('osascript', ['-e', 'get volume settings']))
  }

  private async setVolume(percent: unknown, muted: unknown): Promise<string> {
    if (percent === undefined && muted === undefined) throw new SystemError('Give percent and/or muted.')
    const parts: string[] = []
    if (percent !== undefined) {
      const p = Number(percent)
      if (!Number.isFinite(p) || p < 0 || p > 100) throw new SystemError('percent must be 0-100.')
      await this.deps.exec('osascript', ['-e', `set volume output volume ${Math.round(p)}`])
      parts.push(`volume set to ${Math.round(p)}%`)
    }
    if (typeof muted === 'boolean') {
      await this.deps.exec('osascript', ['-e', `set volume output muted ${muted}`])
      parts.push(muted ? 'muted' : 'unmuted')
    }
    return `Sound ${parts.join(', ')}.`
  }

  private async setDarkMode(on: boolean): Promise<string> {
    if (this.deps.platform === 'darwin') {
      try {
        await this.deps.exec('osascript', [
          '-e',
          `tell application "System Events" to tell appearance preferences to set dark mode to ${on}`
        ])
      } catch (err) {
        if (/-1743|not allowed|not authori[sz]ed/i.test(String(err instanceof Error ? err.message : err)))
          throw new SystemError(
            'macOS blocked this. Allow OS Assistant to control "System Events" in System Settings → Privacy & Security → Automation, then try again.'
          )
        throw err
      }
    } else {
      const value = on ? '0' : '1'
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
      for (const name of ['AppsUseLightTheme', 'SystemUsesLightTheme'])
        await this.deps.exec('reg.exe', ['add', key, '/v', name, '/t', 'REG_DWORD', '/d', value, '/f'])
    }
    return `Dark mode is now ${on ? 'on' : 'off'}.`
  }
}

export interface Battery {
  percent: number
  charging: boolean
  /** True when plugged in (charging or full). */
  onPower: boolean
}

/** `pmset -g batt` (macOS). Null on Macs without a battery. */
export function parsePmset(out: string): Battery | null {
  const m = /(\d+)%;\s*([^;]+);/.exec(out)
  if (!m) return null
  const state = m[2].trim().toLowerCase()
  return {
    percent: Number(m[1]),
    charging: state === 'charging',
    onPower: /AC Power/.test(out) || state === 'charged' || state === 'charging' || state === 'finishing charge'
  }
}

/** Win32_Battery as JSON. Null on PCs without a battery. BatteryStatus 1 means it's running on battery. */
export function parseWindowsBattery(out: string): Battery | null {
  if (!out.trim()) return null
  const data = JSON.parse(out)
  const b = Array.isArray(data) ? data[0] : data
  if (!b || typeof b.EstimatedChargeRemaining !== 'number') return null
  return { percent: b.EstimatedChargeRemaining, charging: b.BatteryStatus === 6 || b.BatteryStatus === 7, onPower: b.BatteryStatus !== 1 }
}

/** `get volume settings` from osascript. */
export function parseVolumeSettings(out: string): { percent: number; muted: boolean } | null {
  const v = /output volume:(\d+|missing value)/.exec(out)
  if (!v || v[1] === 'missing value') return null
  return { percent: Number(v[1]), muted: /output muted:true/.test(out) }
}

function describeBattery(b: Battery): string {
  return `${b.percent}%, ${b.charging ? 'charging' : b.onPower ? 'plugged in' : 'on battery'}`
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} hour${h === 1 ? '' : 's'}`, `${m} min`].filter(Boolean).join(', ')
}
