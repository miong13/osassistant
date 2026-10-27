import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { shell } from 'electron'
import {
  MAC_EXTRA_APPS,
  macAppDirs,
  mergeWindowsApps,
  parseStartApps,
  scanMacApps,
  scanWindowsShortcuts,
  windowsStartMenuDirs,
  type InstalledApp
} from './apps'
import type { DesktopDeps } from './tools'

export function desktopDeps(): DesktopDeps {
  return {
    platform: process.platform,
    home: homedir(),
    listApps,
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    launch
  }
}

async function listApps(): Promise<InstalledApp[]> {
  if (process.platform === 'darwin') return scanMacApps(macAppDirs(homedir()), MAC_EXTRA_APPS)
  if (process.platform === 'win32') {
    const [startApps, shortcuts] = await Promise.all([
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | ConvertTo-Json -Compress'])
        .then(parseStartApps)
        .catch(() => []),
      scanWindowsShortcuts(windowsStartMenuDirs(process.env))
    ])
    return mergeWindowsApps(startApps, shortcuts)
  }
  return []
}

async function launch(app: InstalledApp, args: string[]): Promise<void> {
  if (process.platform === 'darwin') {
    if (!app.path) throw new Error(`Don't know where ${app.name} is installed.`)
    await run('open', ['-a', app.path, ...args])
    return
  }
  if (process.platform === 'win32') {
    if (!args.length) {
      if (app.appId) return spawnDetached('explorer.exe', [`shell:AppsFolder\\${app.appId}`])
      if (app.path) {
        const error = await shell.openPath(app.path)
        if (error) throw new Error(error)
        return
      }
    }
    // Files and URLs can only be handed to a desktop app, through its shortcut's .exe.
    if (app.path) {
      const link = shell.readShortcutLink(app.path)
      if (/\.exe$/i.test(link.target))
        return spawnDetached(link.target, [...splitArgs(link.args ?? ''), ...args], link.cwd || undefined)
    }
    throw new Error(
      `${app.name} can't be handed files directly. Open the file with its default app, or open ${app.name} and pick the file there.`
    )
  }
  throw new Error('Opening apps works on macOS and Windows only.')
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
}

function spawnDetached(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function splitArgs(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2])
  return out
}
