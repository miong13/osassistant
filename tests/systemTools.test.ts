import { describe, expect, it } from 'vitest'
import {
  SystemTools,
  formatDuration,
  parsePmset,
  parseVolumeSettings,
  parseWindowsBattery,
  type SystemDeps
} from '../src/main/desktop/system'

// Real output captured on a Mac.
const PMSET_AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=7077987)\t100%; charged; 0:00 remaining present: true\n"
const PMSET_BATTERY =
  "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=7077987)\t64%; discharging; 3:12 remaining present: true\n"
const VOLUME = 'output volume:50, input volume:50, alert volume:100, output muted:false'

function fake(platform = 'darwin', overrides: Partial<SystemDeps> = {}) {
  const ran: string[][] = []
  let clipboard = 'copied text'
  const deps: SystemDeps = {
    platform,
    osName: platform === 'darwin' ? 'macOS' : 'Windows',
    osVersion: '26.1',
    home: '/Users/me',
    uptimeSeconds: () => 90_061,
    memory: () => ({ total: 16 * 1024 ** 3, free: 4 * 1024 ** 3 }),
    disk: async () => ({ free: 120 * 1024 ** 3, total: 500 * 1024 ** 3 }),
    isOnline: () => true,
    darkMode: () => false,
    readClipboard: () => clipboard,
    writeClipboard: (t) => {
      clipboard = t
    },
    exec: async (file, args) => {
      ran.push([file, ...args])
      if (file === 'pmset') return PMSET_AC
      if (args.includes('get volume settings')) return VOLUME
      return ''
    },
    ...overrides
  }
  return { tools: new SystemTools(deps), ran, clipboard: () => clipboard }
}

const call = (t: SystemTools, tool: string, input: unknown = {}) =>
  t.callTool(`system__${tool}`, input, new AbortController().signal)

describe('parsers', () => {
  it('reads pmset battery output', () => {
    expect(parsePmset(PMSET_AC)).toEqual({ percent: 100, charging: false, onPower: true })
    expect(parsePmset(PMSET_BATTERY)).toEqual({ percent: 64, charging: false, onPower: false })
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeNull() // desktop Mac
  })

  it('reads Windows battery output', () => {
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":80,"BatteryStatus":1}')).toEqual({
      percent: 80,
      charging: false,
      onPower: false
    })
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":95,"BatteryStatus":6}')).toMatchObject({ charging: true })
    expect(parseWindowsBattery('')).toBeNull()
  })

  it('reads volume settings', () => {
    expect(parseVolumeSettings(VOLUME)).toEqual({ percent: 50, muted: false })
    expect(parseVolumeSettings('output volume:missing value, output muted:missing value')).toBeNull()
  })

  it('formats uptime', () => {
    expect(formatDuration(90_061)).toBe('1 day, 1 hour, 1 min')
    expect(formatDuration(300)).toBe('5 min')
  })
})

describe('SystemTools', () => {
  it('reports system info', async () => {
    const { tools } = fake()
    const r = await call(tools, 'system_info')
    expect(r.isError).toBe(false)
    expect(r.content).toContain('OS: macOS 26.1')
    expect(r.content).toContain('Memory: 12 GB of 16 GB used')
    expect(r.content).toContain('Disk: 120 GB free of 500 GB')
    expect(r.content).toContain('Battery: 100%, plugged in')
    expect(r.content).toContain('Volume: 50%')
  })

  it('still answers when a command fails', async () => {
    const { tools } = fake('darwin', { exec: async () => Promise.reject(new Error('nope')) })
    const r = await call(tools, 'system_info')
    expect(r.content).toContain('Battery: unknown')
    expect(r.content).not.toContain('Volume')
  })

  it('sets the volume with fixed AppleScript, never text from the model', async () => {
    const { tools, ran } = fake()
    expect((await call(tools, 'set_volume', { percent: 30.4, muted: false })).content).toBe('Sound volume set to 30%, unmuted.')
    expect(ran).toEqual([
      ['osascript', '-e', 'set volume output volume 30'],
      ['osascript', '-e', 'set volume output muted false']
    ])
    expect(await call(tools, 'set_volume', { percent: 150 })).toMatchObject({ isError: true })
    expect(await call(tools, 'set_volume', { percent: '1; do shell script "rm -rf ~"' })).toMatchObject({ isError: true })
  })

  it('switches dark mode on Windows through the registry', async () => {
    const { tools, ran } = fake('win32')
    await call(tools, 'set_dark_mode', { on: true })
    expect(ran.map((r) => r.slice(0, 2).concat(r[4], r[8]))).toEqual([
      ['reg.exe', 'add', 'AppsUseLightTheme', '0'],
      ['reg.exe', 'add', 'SystemUsesLightTheme', '0']
    ])
  })

  it('explains the Automation permission when macOS blocks dark mode', async () => {
    const { tools } = fake('darwin', {
      exec: async () => Promise.reject(new Error('execution error: Not authorized to send Apple events to System Events. (-1743)'))
    })
    expect((await call(tools, 'set_dark_mode', { on: true })).content).toMatch(/Privacy & Security → Automation/)
  })

  it('reads and writes the clipboard, but asks first by default', async () => {
    const { tools, clipboard } = fake()
    expect((await call(tools, 'read_clipboard')).content).toBe('copied text')
    await call(tools, 'write_clipboard', { text: 'hello' })
    expect(clipboard()).toBe('hello')
    expect(tools.defaultPermission('system__read_clipboard')).toBe('ask')
    expect(tools.defaultPermission('system__write_clipboard')).toBe('ask')
    expect(tools.defaultPermission('system__system_info')).toBe('allow')
  })

  it('only offers volume control on macOS', () => {
    expect(fake('win32').tools.has('system__set_volume')).toBe(false)
    expect(fake('darwin').tools.has('system__set_volume')).toBe(true)
    expect(fake('linux').tools.has('system__set_dark_mode')).toBe(false)
  })
})
