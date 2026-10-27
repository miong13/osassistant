import type { Dirent, Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { exposedToolName } from '../../shared/mcpConfig'
import type { McpToolInfo, ToolPermission } from '../../shared/types'
import { stripHiddenChars } from '../guards'
import type { ToolCallResult, ToolHost } from '../mcp/manager'
import type { ToolDef } from '../providers/types'
import { findApp, type InstalledApp } from './apps'
import { CATEGORIES, categoryContaining, categoryFor, pickFromCategory, type CategoryPick } from './categories'

export const DESKTOP_SERVER = 'desktop'

export interface DesktopDeps {
  platform: string
  home: string
  listApps(): Promise<InstalledApp[]>
  /** Opens a file or folder with its default app. Resolves to an error message, or '' on success. */
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): void
  /** Starts an app, optionally handing it files or URLs. */
  launch(app: InstalledApp, args: string[]): Promise<void>
  now?: () => number
}

/** File types that run code (or open other things) when opened with their default app. */
const RUNNABLE = new Set(
  (
    '.app .exe .com .bat .cmd .ps1 .psm1 .vbs .vbe .js .jse .wsf .wsh .hta .msi .msc .cpl .scr .reg .lnk .url ' +
    '.sh .bash .zsh .command .tool .terminal .scpt .applescript .workflow .action .pkg .mpkg .jar .webloc .inetloc'
  ).split(' ')
)

/** Apps that would run a file handed to them instead of showing it. */
const RUNNER_APP =
  /terminal|iterm|warp|wezterm|alacritty|kitty|hyper|powershell|command prompt|^cmd$|script editor|automator|wscript|cscript|installer/i

const SEARCH_SKIP = new Set(['node_modules', 'Library', 'AppData', '$RECYCLE.BIN', 'System Volume Information'])
const BUNDLE_DIR = /\.(app|photoslibrary|musiclibrary|tvlibrary|bundle|framework|xcodeproj|xcworkspace)$/i
const MAX_RESULTS = 40
const MAX_DIRS = 4000
const MAX_DEPTH = 6
const APP_CACHE_MS = 2 * 60_000

/** Links that open an app (a meeting, a call, a calendar feed). None of them run files. */
const APP_LINKS = new Set([
  'mailto:', 'tel:', 'sms:', 'facetime:', 'facetime-audio:', 'msteams:', 'slack:',
  'zoommtg:', 'zoomus:', 'webcal:', 'webcals:', 'whatsapp:', 'tg:'
])

class ToolError extends Error {}

/** What a name resolved to. `replaced` is set when the requested app is missing and a similar one stands in. */
type Target = CategoryPick & { replaced?: string }

const targetName = (t: CategoryPick) => ('app' in t ? t.app.name : `${t.label} in the browser`)

const str = { type: 'string' } as const

const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'list_apps',
    description:
      'List apps installed on this computer (Word, Excel, browsers, code editors, calendar, chat…). Without a filter it also shows which app opens for each type ("spreadsheet", "calendar"…).',
    inputSchema: {
      type: 'object',
      properties: { query: { ...str, description: 'Part of an app name, e.g. "office" or "code"' } },
      additionalProperties: false
    }
  },
  {
    name: 'open_app',
    description:
      'Open an app by name ("Word", "Excel", "Chrome", "VS Code", "Outlook", "Teams", "Zoom") or by type ("spreadsheet", "document", "presentation", "text editor", "code editor", "browser", "email", "calendar", "chat", "video call", "messaging"). If the app isn\'t installed, a similar installed app (or its website) opens instead and the result says which.',
    inputSchema: {
      type: 'object',
      properties: { name: { ...str, description: 'App name' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'open_file',
    description:
      'Open a document, spreadsheet, text file, image, folder etc. with its default app, or with a specific app (e.g. open a .csv in Excel, or a .txt in Visual Studio Code). Needs a full path; use find_files first if you only know the name. Does not run programs or scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { ...str, description: 'Full path, ~ allowed (e.g. ~/Documents/report.docx)' },
        app: { ...str, description: 'Optional app to open it with. If missing, a similar installed app or the default app is used.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'open_url',
    description:
      'Open a web page (http/https) in the default browser or a chosen one ("Google Chrome", "Safari", "Firefox", "Microsoft Edge"). Also opens app links: mailto:, tel:, sms:, facetime:, msteams:, slack:, zoommtg:, webcal:, whatsapp:, tg:. Meeting invites (Zoom, Teams, Meet) are normal https links.',
    inputSchema: {
      type: 'object',
      properties: { url: str, browser: { ...str, description: 'Optional browser app name' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'find_files',
    description:
      "Find files and folders by name. Searches Desktop, Documents and Downloads unless a folder is given. Every word in the query must appear in the name. Newest first.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { ...str, description: 'Words from the file name, e.g. "budget 2026"' },
        folder: { ...str, description: 'Optional folder to search instead, e.g. ~/Projects' },
        extensions: {
          type: 'array',
          items: str,
          description: 'Optional file types, e.g. ["docx", "xlsx"]'
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'show_in_folder',
    description: 'Show a file in Finder (macOS) or File Explorer (Windows), selected.',
    inputSchema: {
      type: 'object',
      properties: { path: { ...str, description: 'Full path, ~ allowed' } },
      required: ['path'],
      additionalProperties: false
    }
  }
]

const exposed = (tool: string) => exposedToolName(DESKTOP_SERVER, tool)

/** Built-in tools for opening apps, files and websites. Same approval flow as MCP tools. */
export class DesktopTools implements ToolHost {
  private appCache?: { at: number; apps: Promise<InstalledApp[]> }
  private byName = new Map(TOOLS.map((t) => [exposed(t.name), t]))

  constructor(private deps: DesktopDeps) {}

  has(name: string): boolean {
    return this.byName.has(name)
  }

  /** For the settings screen. */
  info(): McpToolInfo[] {
    return TOOLS.map((t) => ({
      name: exposed(t.name),
      server: DESKTOP_SERVER,
      originalName: t.name,
      description: t.description
    }))
  }

  toolDefs(permissions: Record<string, ToolPermission>): ToolDef[] {
    return TOOLS.filter((t) => permissions[exposed(t.name)] !== 'disabled').map((t) => ({
      name: exposed(t.name),
      description: `[${DESKTOP_SERVER}] ${t.description}`,
      inputSchema: t.inputSchema
    }))
  }

  inputSchema(name: string): Record<string, unknown> | undefined {
    return this.byName.get(name)?.inputSchema
  }

  async callTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolCallResult> {
    const tool = this.byName.get(name)
    if (!tool) return { content: `Tool "${name}" is not available.`, isError: true }
    const args = (input ?? {}) as Record<string, any>
    try {
      const content = await this.run(tool.name, args, signal)
      return { content: stripHiddenChars(content), isError: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: stripHiddenChars(message), isError: true }
    }
  }

  private run(tool: string, a: Record<string, any>, signal: AbortSignal): Promise<string> {
    switch (tool) {
      case 'list_apps':
        return this.listApps(a.query)
      case 'open_app':
        return this.openApp(a.name)
      case 'open_file':
        return this.openFile(a.path, a.app)
      case 'open_url':
        return this.openUrl(a.url, a.browser)
      case 'find_files':
        return this.findFiles(a.query, a.folder, a.extensions, signal)
      case 'show_in_folder':
        return this.showInFolder(a.path)
      default:
        throw new ToolError(`Unknown tool "${tool}".`)
    }
  }

  // ---------- apps ----------

  private apps(): Promise<InstalledApp[]> {
    const now = this.deps.now?.() ?? Date.now()
    if (!this.appCache || now - this.appCache.at > APP_CACHE_MS) {
      const apps = this.deps.listApps()
      this.appCache = { at: now, apps }
      apps.catch(() => (this.appCache = undefined))
    }
    return this.appCache.apps
  }

  private async listApps(query?: string): Promise<string> {
    const q = query?.trim().toLowerCase()
    const names = (await this.apps())
      .map((a) => a.name)
      .filter((n) => !q || n.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b))
    if (!names.length) return q ? `No installed apps match "${query}".` : 'No apps found.'
    const list = `${names.length} app${names.length === 1 ? '' : 's'}:\n${names.join('\n')}`
    if (q) return list
    const apps = await this.apps()
    const byType = CATEGORIES.map((c) => {
      const pick = pickFromCategory(c, apps, this.deps.platform, true)
      return `${c.id}: ${pick ? targetName(pick) : 'none installed'}`
    })
    return `${list}\n\nOpened for each type:\n${byType.join('\n')}`
  }

  /**
   * An exact app name wins, then a type of app ("spreadsheet"), then a partial name. When the app
   * isn't installed but is a known kind ("Excel"), the first installed app of that kind stands in.
   */
  private async resolveTarget(name: string, allowWeb: boolean): Promise<Target> {
    const apps = await this.apps()
    const exact = findApp(apps, name, { strict: true })
    if ('app' in exact) return exact
    const type = categoryFor(name)
    if (type) {
      const pick = pickFromCategory(type, apps, this.deps.platform, allowWeb)
      if (pick) return pick
      throw new ToolError(`No ${type.label} is installed.`)
    }
    const loose = findApp(apps, name)
    if ('app' in loose) return loose
    const similar = categoryContaining(name)
    const pick = similar && pickFromCategory(similar, apps, this.deps.platform, allowWeb)
    if (pick) return { ...pick, replaced: name.trim() }
    throw new ToolError(loose.error)
  }

  private async openApp(name: string): Promise<string> {
    const target = await this.resolveTarget(name, true)
    if ('web' in target) await this.deps.openExternal(target.web)
    else await this.deps.launch(target.app, [])
    return target.replaced
      ? `${target.replaced} isn't installed, so ${targetName(target)} was opened instead.`
      : `Opened ${targetName(target)}.`
  }

  // ---------- files ----------

  private resolvePath(p: string): string {
    let s = p.trim()
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = join(this.deps.home, s.slice(1))
    if (!isAbsolute(s)) throw new ToolError(`Use a full path (like ~/Documents/report.docx), not "${p}".`)
    return resolve(s)
  }

  private async statPath(path: string): Promise<Stats> {
    try {
      return await stat(path)
    } catch {
      throw new ToolError(`Nothing found at ${path}.`)
    }
  }

  private async openFile(rawPath: string, appName?: string): Promise<string> {
    const path = this.resolvePath(rawPath)
    const info = await this.statPath(path)
    let missingApp = ''
    if (appName?.trim()) {
      const target = await this.resolveTarget(appName, false).catch((err) => {
        if (err instanceof ToolError) return undefined
        throw err
      })
      if (target && 'app' in target) {
        const app = target.app
        if (RUNNER_APP.test(app.name))
          throw new ToolError(`For safety, files can't be handed to ${app.name}, since it would run them.`)
        await this.deps.launch(app, [path])
        return target.replaced
          ? `${target.replaced} isn't installed, so ${basename(path)} was opened in ${app.name} instead.`
          : `Opened ${basename(path)} in ${app.name}.`
      }
      missingApp = appName.trim()
    }
    if (!info.isDirectory()) {
      const ext = extname(path).toLowerCase()
      if (RUNNABLE.has(ext))
        throw new ToolError(
          `For safety, ${ext} files can't be opened this way because opening them runs a program. ` +
            (ext === '.app' ? 'Use open_app instead.' : 'To view it, open it in an editor with the app option.')
        )
      if (this.deps.platform !== 'win32' && info.mode & 0o111)
        throw new ToolError(
          `For safety, ${basename(path)} can't be opened this way because it's marked as a program. To view it, open it in an editor with the app option.`
        )
    } else if (BUNDLE_DIR.test(path)) {
      throw new ToolError(`${basename(path)} is an app or package. Use open_app for apps.`)
    }
    const error = await this.deps.openPath(path)
    if (error) throw new ToolError(`Couldn't open ${basename(path)}: ${error}`)
    return missingApp
      ? `${missingApp} isn't installed and no similar app was found, so ${basename(path)} was opened with its default app.`
      : `Opened ${basename(path)}.`
  }

  private async showInFolder(rawPath: string): Promise<string> {
    const path = this.resolvePath(rawPath)
    await this.statPath(path)
    this.deps.showItemInFolder(path)
    return `Showing ${basename(path)} in ${this.deps.platform === 'win32' ? 'File Explorer' : 'Finder'}.`
  }

  private async findFiles(
    query: string,
    folder: string | undefined,
    extensions: string[] | undefined,
    signal: AbortSignal
  ): Promise<string> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) throw new ToolError('Give some words from the file name.')
    const exts = extensions?.map((e) => '.' + e.trim().replace(/^\./, '').toLowerCase()).filter((e) => e.length > 1)
    const roots = folder?.trim()
      ? [this.resolvePath(folder)]
      : ['Desktop', 'Documents', 'Downloads'].map((d) => join(this.deps.home, d))

    const found: { path: string; dir: boolean; mtime: number; size: number }[] = []
    const queue = roots.map((dir) => ({ dir, depth: 0 }))
    let visited = 0
    let truncated = false
    while (queue.length) {
      if (signal.aborted) throw new ToolError('Cancelled.')
      if (visited++ >= MAX_DIRS) {
        truncated = true
        break
      }
      const { dir, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
        const full = join(dir, e.name)
        const isDir = e.isDirectory()
        const lower = e.name.toLowerCase()
        const nameMatches = words.every((w) => lower.includes(w))
        const typeMatches = exts ? !isDir && exts.includes(extname(lower)) : true
        if (nameMatches && typeMatches) {
          try {
            const s = await stat(full)
            found.push({ path: full, dir: isDir, mtime: s.mtimeMs, size: s.size })
          } catch {
            /* vanished or unreadable */
          }
        }
        if (isDir && depth < MAX_DEPTH && !SEARCH_SKIP.has(e.name) && !BUNDLE_DIR.test(e.name))
          queue.push({ dir: full, depth: depth + 1 })
      }
    }

    if (!found.length)
      return `No files matching "${query}"${exts ? ` (${exts.join(', ')})` : ''} in ${roots.join(', ')}.` +
        (truncated ? ' The search stopped early; try a more specific folder.' : '')
    found.sort((a, b) => b.mtime - a.mtime)
    const lines = found
      .slice(0, MAX_RESULTS)
      .map((f) => `${f.path}${f.dir ? ' (folder)' : ''} · modified ${new Date(f.mtime).toISOString().slice(0, 10)}${f.dir ? '' : ` · ${formatSize(f.size)}`}`)
    const more = found.length > MAX_RESULTS ? `\n…and ${found.length - MAX_RESULTS} more. Narrow the search to see them.` : ''
    const early = truncated ? '\nThe search stopped early; try a more specific folder.' : ''
    return lines.join('\n') + more + early
  }

  // ---------- web ----------

  private async openUrl(raw: string, browserName?: string): Promise<string> {
    let url: URL
    try {
      url = new URL(raw.trim())
    } catch {
      throw new ToolError(`"${raw}" is not a valid URL. Include https://.`)
    }
    const link = url.toString()
    const isWeb = url.protocol === 'http:' || url.protocol === 'https:'
    if (!isWeb && !APP_LINKS.has(url.protocol))
      throw new ToolError(`${url.protocol} links can't be opened. Allowed: http, https, ${[...APP_LINKS].map((p) => p.slice(0, -1)).join(', ')}.`)

    let fallback = ''
    if (isWeb && browserName?.trim()) {
      const target = await this.resolveTarget(browserName, false).catch((err) => {
        if (err instanceof ToolError) return undefined
        throw err
      })
      if (target && 'app' in target) {
        if (RUNNER_APP.test(target.app.name)) throw new ToolError(`${target.app.name} is not a browser.`)
        await this.deps.launch(target.app, [link])
        return target.replaced
          ? `${target.replaced} isn't installed, so ${link} was opened in ${target.app.name} instead.`
          : `Opened ${link} in ${target.app.name}.`
      }
      fallback = `${browserName.trim()} isn't installed, so `
    }
    try {
      await this.deps.openExternal(link)
    } catch (err) {
      if (!isWeb) throw new ToolError(`No app on this computer opens ${url.protocol} links.`)
      throw err
    }
    return fallback ? `${fallback}${link} was opened in the default browser.` : `Opened ${link}.`
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
