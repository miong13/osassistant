import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findApp, mergeWindowsApps, parseStartApps, scanMacApps, type InstalledApp } from '../src/main/desktop/apps'
import { categoryContaining, categoryFor, pickFromCategory } from '../src/main/desktop/categories'
import { DesktopTools, type DesktopDeps } from '../src/main/desktop/tools'
import { combineToolHosts, type ToolHost } from '../src/main/mcp/manager'

const APPS: InstalledApp[] = [
  'Microsoft Word',
  'Microsoft Excel',
  'Google Chrome',
  'Chrome Remote Desktop',
  'Visual Studio Code',
  'TextEdit',
  'Terminal',
  'Microsoft OneNote',
  'Microsoft Outlook'
].map((name) => ({ name, path: `/Applications/${name}.app` }))

const pick = (q: string) => {
  const m = findApp(APPS, q)
  return 'app' in m ? m.app.name : m.error
}

describe('findApp', () => {
  it('matches common short names', () => {
    expect(pick('word')).toBe('Microsoft Word')
    expect(pick('Excel')).toBe('Microsoft Excel')
    expect(pick('chrome')).toBe('Google Chrome')
    expect(pick('vscode')).toBe('Visual Studio Code')
    expect(pick('VS Code')).toBe('Visual Studio Code')
    expect(pick('textedit.app')).toBe('TextEdit')
  })

  it('reports unknown and ambiguous names', () => {
    expect(pick('photoshop')).toMatch(/No installed app/)
    expect(pick('microsoft')).toMatch(/matches several apps/)
  })
})

describe('app discovery', () => {
  it('finds .app bundles one folder deep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osa-apps-'))
    mkdirSync(join(dir, 'Safari.app'))
    mkdirSync(join(dir, 'Utilities', 'Terminal.app'), { recursive: true })
    mkdirSync(join(dir, 'Adobe', 'Deep', 'Hidden.app'), { recursive: true })
    const apps = await scanMacApps([dir, join(dir, 'missing')])
    expect(apps.map((a) => a.name).sort()).toEqual(['Safari', 'Terminal'])
    rmSync(dir, { recursive: true })
  })

  it('reads Get-StartApps output and adds shortcut paths', () => {
    expect(parseStartApps('{"Name":"Notepad","AppID":"Microsoft.WindowsNotepad!App"}')).toEqual([
      { name: 'Notepad', appId: 'Microsoft.WindowsNotepad!App' }
    ])
    const merged = mergeWindowsApps(
      parseStartApps('[{"Name":"Word","AppID":"Microsoft.Office.WINWORD.EXE.15"},{"Name":"Uninstall Foo","AppID":"x"}]'),
      [
        { name: 'Word', path: 'C:\\Start\\Word.lnk' },
        { name: 'Old Tool', path: 'C:\\Start\\Old Tool.lnk' }
      ]
    )
    expect(merged).toEqual([
      { name: 'Word', appId: 'Microsoft.Office.WINWORD.EXE.15', path: 'C:\\Start\\Word.lnk' },
      { name: 'Old Tool', path: 'C:\\Start\\Old Tool.lnk' }
    ])
  })
})

describe('DesktopTools', () => {
  let home: string
  let calls: { kind: string; args: unknown[] }[]
  let tools: DesktopTools
  const signal = new AbortController().signal

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'osa-home-'))
    calls = []
    const deps: DesktopDeps = {
      platform: 'darwin',
      home,
      listApps: async () => APPS,
      openPath: async (p) => (calls.push({ kind: 'openPath', args: [p] }), ''),
      openExternal: async (u) => void calls.push({ kind: 'openExternal', args: [u] }),
      showItemInFolder: (p) => void calls.push({ kind: 'show', args: [p] }),
      launch: async (app, args) => void calls.push({ kind: 'launch', args: [app.name, ...args] })
    }
    tools = new DesktopTools(deps)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const call = (tool: string, input: unknown) => tools.callTool(`desktop__${tool}`, input, signal)

  it('exposes its tools and hides disabled ones', () => {
    expect(tools.toolDefs({}).map((t) => t.name)).toContain('desktop__open_app')
    expect(tools.toolDefs({ desktop__open_app: 'disabled' }).map((t) => t.name)).not.toContain('desktop__open_app')
    expect(tools.has('desktop__open_file')).toBe(true)
  })

  it('opens apps by name', async () => {
    expect(await call('open_app', { name: 'excel' })).toEqual({ content: 'Opened Microsoft Excel.', isError: false })
    expect(calls).toEqual([{ kind: 'launch', args: ['Microsoft Excel'] }])
    expect((await call('open_app', { name: 'nope' })).isError).toBe(true)
  })

  it('opens documents with the default app or a chosen one', async () => {
    const doc = join(home, 'Documents', 'Report.docx')
    mkdirSync(join(home, 'Documents'))
    writeFileSync(doc, 'x')
    expect((await call('open_file', { path: '~/Documents/Report.docx' })).isError).toBe(false)
    expect((await call('open_file', { path: doc, app: 'code' })).content).toBe('Opened Report.docx in Visual Studio Code.')
    expect(calls).toEqual([
      { kind: 'openPath', args: [doc] },
      { kind: 'launch', args: ['Visual Studio Code', doc] }
    ])
  })

  it('refuses to run programs and scripts', async () => {
    const script = join(home, 'run.command')
    const binary = join(home, 'tool')
    writeFileSync(script, 'echo hi')
    writeFileSync(binary, 'echo hi')
    chmodSync(binary, 0o755)
    expect((await call('open_file', { path: script })).content).toMatch(/runs a program/)
    expect((await call('open_file', { path: binary })).content).toMatch(/marked as a program/)
    expect((await call('open_file', { path: script, app: 'Terminal' })).content).toMatch(/would run them/)
    expect((await call('open_file', { path: 'relative.txt' })).content).toMatch(/full path/)
    expect((await call('open_file', { path: join(home, 'missing.txt') })).content).toMatch(/Nothing found/)
    // Opening a script in an editor is fine.
    expect((await call('open_file', { path: script, app: 'TextEdit' })).isError).toBe(false)
    expect(calls).toEqual([{ kind: 'launch', args: ['TextEdit', script] }])
  })

  it('opens web links only', async () => {
    expect((await call('open_url', { url: 'https://example.com' })).isError).toBe(false)
    expect((await call('open_url', { url: 'https://example.com/a', browser: 'chrome' })).content).toBe(
      'Opened https://example.com/a in Google Chrome.'
    )
    expect((await call('open_url', { url: 'file:///etc/passwd' })).isError).toBe(true)
    expect((await call('open_url', { url: 'javascript:alert(1)' })).isError).toBe(true)
    expect((await call('open_url', { url: 'https://x.com', browser: 'Terminal' })).isError).toBe(true)
    expect(calls).toEqual([
      { kind: 'openExternal', args: ['https://example.com/'] },
      { kind: 'launch', args: ['Google Chrome', 'https://example.com/a'] }
    ])
  })

  it('finds files by name, newest first, skipping hidden and dependency folders', async () => {
    const docs = join(home, 'Documents')
    mkdirSync(join(docs, 'Finance', '2026'), { recursive: true })
    mkdirSync(join(docs, 'node_modules'))
    mkdirSync(join(docs, '.hidden'))
    const older = join(docs, 'Finance', 'Budget 2025.xlsx')
    const newer = join(docs, 'Finance', '2026', 'budget-2026.xlsx')
    writeFileSync(older, 'x')
    writeFileSync(newer, 'x')
    writeFileSync(join(docs, 'Finance', 'budget notes.docx'), 'x')
    writeFileSync(join(docs, 'node_modules', 'budget.xlsx'), 'x')
    writeFileSync(join(docs, '.hidden', 'budget.xlsx'), 'x')
    utimesSync(older, new Date('2025-01-01'), new Date('2025-01-01'))

    const r = await call('find_files', { query: 'budget', extensions: ['xlsx'] })
    expect(r.isError).toBe(false)
    const lines = r.content.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(newer)
    expect(lines[1]).toContain(older)

    expect((await call('find_files', { query: 'nothing here' })).content).toMatch(/No files matching/)
  })

  it('shows files in Finder', async () => {
    writeFileSync(join(home, 'a.txt'), 'x')
    expect((await call('show_in_folder', { path: '~/a.txt' })).content).toBe('Showing a.txt in Finder.')
  })
})

describe('combineToolHosts', () => {
  const host = (name: string, reply: string): ToolHost => ({
    toolDefs: () => [{ name, description: reply, inputSchema: { type: 'object' } }],
    inputSchema: (n) => (n === name ? { type: 'object' } : undefined),
    callTool: async () => ({ content: reply, isError: false })
  })

  it('routes calls to the owning host and keeps the first of duplicate names', async () => {
    const combined = combineToolHosts([host('a__x', 'first'), host('b__y', 'second'), host('a__x', 'shadow')])
    expect(combined.toolDefs({}).map((t) => t.description)).toEqual(['first', 'second'])
    const signal = new AbortController().signal
    expect((await combined.callTool('b__y', {}, signal)).content).toBe('second')
    expect((await combined.callTool('a__x', {}, signal)).content).toBe('first')
    expect((await combined.callTool('zzz', {}, signal)).isError).toBe(true)
  })
})

describe('app categories and fallbacks', () => {
  const apps = (...names: string[]): InstalledApp[] => names.map((name) => ({ name, path: `/Apps/${name}` }))

  function make(installed: InstalledApp[], platform = 'darwin', openExternal?: (u: string) => Promise<void>) {
    const calls: { kind: string; args: unknown[] }[] = []
    const tools = new DesktopTools({
      platform,
      home: tmpdir(),
      listApps: async () => installed,
      openPath: async (p) => (calls.push({ kind: 'openPath', args: [p] }), ''),
      openExternal: openExternal ?? (async (u) => void calls.push({ kind: 'openExternal', args: [u] })),
      showItemInFolder: () => {},
      launch: async (app, args) => void calls.push({ kind: 'launch', args: [app.name, ...args] })
    })
    const call = (tool: string, input: unknown) =>
      tools.callTool(`desktop__${tool}`, input, new AbortController().signal)
    return { calls, call }
  }

  it('recognizes types of apps and which type an app belongs to', () => {
    expect(categoryFor('a spreadsheet')?.id).toBe('spreadsheets')
    expect(categoryFor('Calendar app')?.id).toBe('calendar')
    expect(categoryFor('video call')?.id).toBe('video-calls')
    expect(categoryFor('photoshop')).toBeUndefined()
    expect(categoryContaining('Excel')?.id).toBe('spreadsheets')
    expect(categoryContaining('Microsoft Word')?.id).toBe('documents')
    expect(categoryContaining('Notepad')?.id).toBe('text-editor')
    expect(categoryContaining('Outlook')?.id).toBe('email')
    expect(categoryContaining('Teams')?.id).toBe('team-chat')
  })

  it('picks the first installed app, then a website', () => {
    const sheets = categoryFor('spreadsheet')!
    expect(pickFromCategory(sheets, apps('Numbers Creator Studio', 'LibreOffice'), 'darwin', true)).toEqual({
      app: { name: 'Numbers Creator Studio', path: '/Apps/Numbers Creator Studio' }
    })
    expect(pickFromCategory(sheets, apps('LibreOffice Calc'), 'win32', true)).toMatchObject({ app: { name: 'LibreOffice Calc' } })
    expect(pickFromCategory(sheets, [], 'win32', true)).toMatchObject({ label: 'Google Sheets' })
    expect(pickFromCategory(sheets, [], 'win32', false)).toBeUndefined()
  })

  it('opens a stand-in when the app is missing, and says so', async () => {
    const { call, calls } = make(apps('Numbers', 'Calendar', 'Google Chrome', 'TextEdit'))
    expect((await call('open_app', { name: 'Excel' })).content).toBe("Excel isn't installed, so Numbers was opened instead.")
    expect((await call('open_app', { name: 'a spreadsheet' })).content).toBe('Opened Numbers.')
    expect((await call('open_app', { name: 'calendar' })).content).toBe('Opened Calendar.')
    expect((await call('open_app', { name: 'Zoom' })).content).toBe(
      "Zoom isn't installed, so Google Meet in the browser was opened instead."
    )
    expect(calls).toEqual([
      { kind: 'launch', args: ['Numbers'] },
      { kind: 'launch', args: ['Numbers'] },
      { kind: 'launch', args: ['Calendar'] },
      { kind: 'openExternal', args: ['https://meet.google.com'] }
    ])
    expect((await call('open_app', { name: 'Photoshop' })).content).toMatch(/No installed app/)
  })

  it('uses the Windows lists on Windows', async () => {
    const { call } = make(apps('Notepad', 'Microsoft Edge'), 'win32')
    expect((await call('open_app', { name: 'TextEdit' })).content).toBe("TextEdit isn't installed, so Notepad was opened instead.")
    expect((await call('open_app', { name: 'browser' })).content).toBe('Opened Microsoft Edge.')
    expect((await call('open_app', { name: 'email' })).content).toBe('Opened Outlook on the web in the browser.')
  })

  it('falls back for files and browsers too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osa-fb-'))
    const csv = join(dir, 'data.csv')
    const script = join(dir, 'run.sh')
    writeFileSync(csv, 'a,b')
    writeFileSync(script, 'echo')
    const { call, calls } = make(apps('Numbers', 'Google Chrome'))
    expect((await call('open_file', { path: csv, app: 'Excel' })).content).toBe(
      "Excel isn't installed, so data.csv was opened in Numbers instead."
    )
    const none = make(apps('Google Chrome'))
    expect((await none.call('open_file', { path: csv, app: 'Excel' })).content).toBe(
      "Excel isn't installed and no similar app was found, so data.csv was opened with its default app."
    )
    // A missing app never lets a script through to its default app.
    expect((await none.call('open_file', { path: script, app: 'Nonexistent' })).content).toMatch(/runs a program/)
    expect((await call('open_url', { url: 'https://a.com', browser: 'Microsoft Edge' })).content).toBe(
      "Microsoft Edge isn't installed, so https://a.com/ was opened in Google Chrome instead."
    )
    expect(calls).toEqual([
      { kind: 'launch', args: ['Numbers', csv] },
      { kind: 'launch', args: ['Google Chrome', 'https://a.com/'] }
    ])
    rmSync(dir, { recursive: true })
  })

  it('opens meeting, call and calendar links, but nothing that runs files', async () => {
    const { call, calls } = make([])
    for (const url of ['msteams:/l/meetup-join/abc', 'zoommtg://zoom.us/join?confno=1', 'tel:+15551234', 'webcal://example.com/cal.ics'])
      expect((await call('open_url', { url })).isError).toBe(false)
    expect(calls.map((c) => c.args[0])).toEqual([
      'msteams:/l/meetup-join/abc',
      'zoommtg://zoom.us/join?confno=1',
      'tel:+15551234',
      'webcal://example.com/cal.ics'
    ])
    for (const url of ['file:///Applications/Calculator.app', 'smb://server/share', 'vscode://file/x', 'ms-msdt:/id'])
      expect((await call('open_url', { url })).isError).toBe(true)

    const noHandler = make([], 'darwin', async () => {
      throw new Error('no handler')
    })
    expect((await noHandler.call('open_url', { url: 'slack://open' })).content).toBe('No app on this computer opens slack: links.')
  })
})
