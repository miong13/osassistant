import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** An app the assistant can open. Found by scanning the system, so it works without config. */
export interface InstalledApp {
  name: string
  /** macOS: the .app bundle. Windows: a Start Menu shortcut (.lnk). */
  path?: string
  /** Windows: the AppUserModelID from Get-StartApps, launched through shell:AppsFolder. */
  appId?: string
}

export function macAppDirs(home: string): string[] {
  return ['/Applications', '/System/Applications', join(home, 'Applications')]
}

export const MAC_EXTRA_APPS = ['/System/Library/CoreServices/Finder.app']

/** Finds .app bundles in each folder and one level of subfolders (e.g. Utilities, Adobe folders). */
export async function scanMacApps(dirs: string[], extras: string[] = []): Promise<InstalledApp[]> {
  const out: InstalledApp[] = []
  const visit = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.name.endsWith('.app')) out.push({ name: e.name.slice(0, -4), path: full })
      else if (e.isDirectory() && depth > 0) await visit(full, depth - 1)
    }
  }
  for (const d of dirs) await visit(d, 1)
  for (const p of extras) out.push({ name: p.split('/').pop()!.replace(/\.app$/, ''), path: p })
  return dedupeByName(out)
}

export function windowsStartMenuDirs(env: NodeJS.ProcessEnv): string[] {
  const rel = join('Microsoft', 'Windows', 'Start Menu', 'Programs')
  return [env.APPDATA, env.ProgramData].filter((d): d is string => Boolean(d)).map((d) => join(d, rel))
}

/** Start Menu shortcuts (.lnk), skipping uninstallers. */
export async function scanWindowsShortcuts(dirs: string[]): Promise<InstalledApp[]> {
  const out: InstalledApp[] = []
  const visit = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth > 0) await visit(full, depth - 1)
      } else if (/\.lnk$/i.test(e.name) && !/uninstall/i.test(e.name)) {
        out.push({ name: e.name.replace(/\.lnk$/i, ''), path: full })
      }
    }
  }
  for (const d of dirs) await visit(d, 3)
  return dedupeByName(out)
}

/** Parses `Get-StartApps | ConvertTo-Json` (a single app comes back as an object, not a list). */
export function parseStartApps(json: string): InstalledApp[] {
  if (!json.trim()) return []
  const data = JSON.parse(json) as unknown
  const list = Array.isArray(data) ? data : [data]
  return list
    .filter((a): a is { Name: string; AppID: string } => typeof a?.Name === 'string' && typeof a?.AppID === 'string')
    .filter((a) => !/uninstall/i.test(a.Name))
    .map((a) => ({ name: a.Name, appId: a.AppID }))
}

/** Start apps (which include Store apps like Notepad) get the matching shortcut's path, so files can be passed. */
export function mergeWindowsApps(startApps: InstalledApp[], shortcuts: InstalledApp[]): InstalledApp[] {
  const byName = new Map(shortcuts.map((s) => [s.name.toLowerCase(), s]))
  const merged = startApps.map((a) => ({ ...a, path: byName.get(a.name.toLowerCase())?.path }))
  const seen = new Set(merged.map((a) => a.name.toLowerCase()))
  return [...merged, ...shortcuts.filter((s) => !seen.has(s.name.toLowerCase()))]
}

function dedupeByName(apps: InstalledApp[]): InstalledApp[] {
  const seen = new Set<string>()
  return apps.filter((a) => {
    const key = a.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------- matching a name the model gives ----------

const ALIASES: Record<string, string> = {
  vscode: 'visual studio code',
  'vs code': 'visual studio code',
  ppt: 'microsoft powerpoint',
  cmd: 'command prompt'
}

const VENDOR = /^(microsoft|google|adobe|apple|mozilla) /

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(app|exe|lnk)$/, '')
    .replace(/\s+/g, ' ')
    .trim()

function score(appName: string, q: string): number | null {
  const n = norm(appName)
  if (n === q) return 0
  if (n.replace(VENDOR, '') === q) return 1
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(n)) return 2
  if (n.includes(q)) return 3
  return null
}

export type AppMatch = { app: InstalledApp } | { error: string }

/** True when `query` names this app exactly or without its vendor ("Excel" ↔ "Microsoft Excel"). */
export function appNameMatches(appName: string, query: string): boolean {
  const raw = norm(query)
  const q = ALIASES[raw] ?? raw
  const s = score(appName, q)
  if (s !== null && s <= 1) return true
  // Also the other way round: "Microsoft Word" asked for, app installed as "Word".
  return norm(appName) === q.replace(VENDOR, '')
}

/**
 * Finds one app by name: exact, then without the vendor ("Word" → "Microsoft Word"), then partial.
 * `strict` stops before partial matches.
 */
export function findApp(apps: InstalledApp[], query: string, opts: { strict?: boolean } = {}): AppMatch {
  const raw = norm(query)
  if (!raw) return { error: 'Give an app name.' }
  const q = ALIASES[raw] ?? raw
  let best: { app: InstalledApp; s: number }[] = []
  for (const app of apps) {
    const s = opts.strict ? (appNameMatches(app.name, query) ? 0 : null) : score(app.name, q)
    if (s === null) continue
    if (!best.length || s < best[0].s) best = [{ app, s }]
    else if (s === best[0].s) best.push({ app, s })
  }
  if (!best.length) return { error: `No installed app called "${query}". Use list_apps to see what's installed.` }
  if (best.length === 1 || best[0].s <= 1) return { app: best[0].app }
  const names = best
    .map((b) => b.app.name)
    .sort((a, b) => a.length - b.length)
    .slice(0, 8)
  return { error: `"${query}" matches several apps: ${names.join(', ')}. Use the full name.` }
}
