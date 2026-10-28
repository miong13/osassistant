import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

export const RELEASES_URL = 'https://github.com/miong13/osassistant/releases/latest'
const FIRST_CHECK_DELAY = 15_000
const CHECK_EVERY = 4 * 60 * 60_000

/**
 * Checks GitHub Releases for new versions. On Windows, and on a signed Mac build, updates download
 * in the background and install on restart. An unsigned Mac build can't install updates itself
 * (macOS rejects them), so it only reports the new version and links to the download page.
 */
export class Updater extends EventEmitter {
  private status: UpdateStatus = { state: 'idle' }
  private timer: NodeJS.Timeout | undefined
  private manual = false

  constructor(private isEnabled: () => boolean) {
    super()
  }

  get current(): UpdateStatus {
    return this.status
  }

  async start(): Promise<void> {
    if (!app.isPackaged) {
      this.set({ state: 'unsupported', message: 'Updates work in the installed app, not in development.' })
      return
    }
    this.manual = process.platform === 'darwin' && !(await isDeveloperIdSigned())
    autoUpdater.autoDownload = !this.manual
    autoUpdater.autoInstallOnAppQuit = !this.manual
    autoUpdater.logger = null

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('update-available', (info) =>
      this.set(
        this.manual
          ? { state: 'available', version: info.version, manual: true }
          : { state: 'downloading', version: info.version, percent: 0 }
      )
    )
    autoUpdater.on('download-progress', (p) =>
      this.set({ state: 'downloading', version: this.status.version, percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (err) =>
      this.set({ state: 'error', message: friendlyError(err), version: this.status.version })
    )

    setTimeout(() => this.checkIfEnabled(), FIRST_CHECK_DELAY)
    this.timer = setInterval(() => this.checkIfEnabled(), CHECK_EVERY)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  /** Check now (from the menu or the About page). */
  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.status
    // Don't interrupt a download or throw away a finished one.
    if (this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', message: friendlyError(err) })
    }
    return this.status
  }

  /** Restart into the downloaded update. Call only once the app has finished its own cleanup. */
  install(): void {
    if (this.status.state === 'ready') autoUpdater.quitAndInstall()
  }

  private checkIfEnabled(): void {
    if (this.isEnabled()) void this.check()
  }

  private set(status: UpdateStatus): void {
    const before = this.status
    this.status = status
    this.emit('status', status)
    // Tell the app once per version when something needs the user.
    const needsUser = (s: UpdateStatus) => s.state === 'ready' || (s.state === 'available' && s.manual)
    if (needsUser(status) && !(needsUser(before) && before.version === status.version)) this.emit('needs-user', status)
  }
}

/** True when the running .app has a Developer ID signature, which macOS needs to accept updates. */
function isDeveloperIdSigned(): Promise<boolean> {
  // process.execPath is …/OS Assistant.app/Contents/MacOS/OS Assistant
  const bundle = dirname(dirname(dirname(process.execPath)))
  return new Promise((resolve) => {
    execFile('codesign', ['-dvv', bundle], (err, _stdout, stderr) => {
      resolve(!err && /Authority=Developer ID Application/.test(String(stderr)))
    })
  })
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|net::/i.test(msg)) return "Couldn't reach GitHub to check for updates."
  if (/404|Cannot find latest/i.test(msg)) return 'No published releases found yet.'
  return 'Checking for updates failed. You can download the latest version from the releases page.'
}
