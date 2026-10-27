import { BrowserWindow, app, screen, shell } from 'electron'
import { join } from 'node:path'
import type { BubbleMode, Layout, Rect } from '../shared/types'
import { clampToArea, computeLayout } from './layout'
import type { SettingsStore } from './store/settings'

const preload = join(__dirname, '../preload/index.js')

function loadRoute(win: BrowserWindow, route: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}#/${route}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
}

function hardenNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
}

/** The always-on-top transparent window holding the character and its speech bubble. */
export class CharacterWindow {
  win: BrowserWindow | null = null
  mode: BubbleMode = 'closed'
  private pos = { x: 0, y: 0 }
  private size = { width: 140, height: 140 }
  private lastLayout: Layout | null = null

  constructor(private settings: SettingsStore) {}

  create(): BrowserWindow {
    this.pos = this.initialPosition()
    const { bounds } = computeLayout(this.characterRect(), 'closed', this.workArea())
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // An NSPanel can float over full-screen apps on macOS.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    hardenNavigation(win)
    win.webContents.on('did-finish-load', () => this.apply())
    win.once('ready-to-show', () => win.showInactive())
    loadRoute(win, 'character')
    this.win = win

    screen.on('display-removed', () => this.reclamp())
    screen.on('display-metrics-changed', () => this.reclamp())
    return win
  }

  setCharacterSize(size: { width: number; height: number }): void {
    this.size = size
    this.pos = clampToArea(this.pos, size, this.workArea())
    this.apply()
  }

  setMode(mode: BubbleMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.apply()
  }

  get visible(): boolean {
    return Boolean(this.win?.isVisible())
  }

  show(focus: boolean): void {
    if (!this.win) return
    if (focus) {
      this.win.show()
      this.win.focus()
      app.focus({ steal: true })
    } else {
      this.win.showInactive()
    }
  }

  hide(): void {
    this.win?.hide()
  }

  dragBy(dx: number, dy: number): void {
    if (!this.win) return
    this.pos = { x: this.pos.x + dx, y: this.pos.y + dy }
    const b = this.win.getBounds()
    this.win.setBounds({ ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) })
  }

  dragEnd(): void {
    this.reclamp()
    const display = screen.getDisplayNearestPoint(this.center())
    const positions = { ...this.settings.get().characterPositions, [String(display.id)]: this.pos }
    this.settings.update({ characterPositions: positions })
  }

  send(channel: string, payload?: unknown): void {
    this.win?.webContents.send(channel, payload)
  }

  get layout(): Layout | null {
    return this.lastLayout
  }

  private reclamp(): void {
    this.pos = clampToArea(this.pos, this.size, this.workArea())
    this.apply()
  }

  private apply(): void {
    if (!this.win) return
    const { bounds, layout } = computeLayout(this.characterRect(), this.mode, this.workArea())
    this.win.setBounds(bounds)
    this.lastLayout = layout
    this.send('layout', layout)
  }

  private characterRect(): Rect {
    return { ...this.pos, ...this.size }
  }

  private center(): { x: number; y: number } {
    return { x: Math.round(this.pos.x + this.size.width / 2), y: Math.round(this.pos.y + this.size.height / 2) }
  }

  private workArea(): Rect {
    return screen.getDisplayNearestPoint(this.center()).workArea
  }

  private initialPosition(): { x: number; y: number } {
    const saved = this.settings.get().characterPositions
    for (const d of screen.getAllDisplays()) {
      const p = saved[String(d.id)]
      if (p) return clampToArea(p, this.size, d.workArea)
    }
    const area = screen.getPrimaryDisplay().workArea
    return { x: area.x + area.width - this.size.width - 40, y: area.y + area.height - this.size.height - 40 }
  }
}

let settingsWin: BrowserWindow | null = null

export function openSettingsWindow(tab?: string): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (tab) settingsWin.webContents.send('settings-tab', tab)
    settingsWin.show()
    settingsWin.focus()
    app.focus({ steal: true })
    return settingsWin
  }
  const win = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 500,
    title: 'OS Assistant Settings',
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  hardenNavigation(win)
  win.once('ready-to-show', () => {
    win.show()
    app.focus({ steal: true })
  })
  loadRoute(win, tab ? `settings/${tab}` : 'settings')
  win.on('closed', () => {
    settingsWin = null
  })
  settingsWin = win
  return win
}
