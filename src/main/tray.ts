import { Menu, Tray, app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CharacterInfo, Settings } from '../shared/types'

export interface TrayActions {
  toggleCharacter(): void
  openChat(): void
  newChat(): void
  setCharacter(id: string): void
  setDoNotDisturb(on: boolean): void
  openSettings(): void
  quit(): void
}

export class AppTray {
  private tray: Tray | null = null

  constructor(
    private iconsDir: string,
    private actions: TrayActions
  ) {}

  create(): void {
    const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png'
    const path = join(this.iconsDir, file)
    let image = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
    if (process.platform !== 'darwin' && !image.isEmpty()) image = image.resize({ width: 16, height: 16 })
    if (process.platform === 'darwin') image.setTemplateImage(true)
    this.tray = new Tray(image)
    if (image.isEmpty()) this.tray.setTitle('OSA')
    this.tray.setToolTip('OS Assistant')
    this.tray.on('click', () => {
      if (process.platform !== 'darwin') this.actions.toggleCharacter()
    })
  }

  update(settings: Settings, characters: CharacterInfo[], characterVisible: boolean, hotkey: string): void {
    if (!this.tray) return
    const menu = Menu.buildFromTemplate([
      { label: 'Open Chat', accelerator: hotkey, click: () => this.actions.openChat() },
      { label: 'New Chat', click: () => this.actions.newChat() },
      { type: 'separator' },
      {
        label: characterVisible ? 'Hide Character' : 'Show Character',
        click: () => this.actions.toggleCharacter()
      },
      {
        label: 'Character',
        submenu: characters.map((c) => ({
          label: c.name,
          type: 'radio' as const,
          checked: c.id === settings.characterId,
          click: () => this.actions.setCharacter(c.id)
        }))
      },
      {
        label: 'Do Not Disturb',
        type: 'checkbox',
        checked: settings.tips.doNotDisturb,
        click: (item) => this.actions.setDoNotDisturb(item.checked)
      },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => this.actions.openSettings() },
      { label: `Quit ${app.getName()}`, accelerator: 'CmdOrCtrl+Q', click: () => this.actions.quit() }
    ])
    this.tray.setContextMenu(menu)
  }
}
