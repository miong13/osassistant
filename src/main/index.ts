import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  net,
  powerMonitor,
  protocol,
  shell
} from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SettingsPatch } from '../shared/api'
import type { ApprovalDecision, ChatEvent, ProviderConfig, ProviderView, Settings, Tip } from '../shared/types'
import { ASSET_SCHEME, CharacterLibrary } from './characters/loader'
import { Orchestrator } from './chat/orchestrator'
import { toMarkdown } from './chat/exportMarkdown'
import { parseMcpConfig } from '../shared/mcpConfig'
import { McpManager, combineToolHosts } from './mcp/manager'
import { desktopDeps } from './desktop/launch'
import { DesktopTools } from './desktop/tools'
import { createProvider } from './providers'
import { loadShellPath } from './shellEnv'
import { SecretStore } from './store/secrets'
import { SettingsStore } from './store/settings'
import { SqliteChatStore } from './store/sqliteStore'
import { TipEngine } from './tips/engine'
import { AppTray } from './tray'
import { CharacterWindow, openSettingsWindow } from './windows'

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName('OS Assistant')
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox('OS Assistant failed to start', String(err?.stack ?? err))
    app.quit()
  })
}

async function main(): Promise<void> {
  const userData = app.getPath('userData')
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')

  const settings = new SettingsStore(join(userData, 'settings.json'))
  const secrets = new SecretStore(join(userData, 'secrets.json'))
  const store = new SqliteChatStore(join(userData, 'assistant.db'))
  const characters = new CharacterLibrary(join(resourcesDir, 'characters'), join(userData, 'characters'))
  characters.load()

  let shellPath = process.env.PATH ?? ''
  const desktop = new DesktopTools(desktopDeps())
  const mcp = new McpManager(() => shellPath, (name) => desktop.has(name))
  const characterWindow = new CharacterWindow(settings)

  const broadcast = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }

  // ---------- characters ----------
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url)
    const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const path = characters.assetPath(url.hostname, file)
    if (!path || !existsSync(path)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })

  const currentCharacter = () => characters.get(settings.get().characterId)
  const applyCharacterSize = () => {
    const c = currentCharacter()
    if (c) characterWindow.setCharacterSize(c.size)
  }

  // ---------- providers ----------
  const getProvider = (id: string) => {
    const config = settings.get().providers.find((p) => p.id === id)
    if (!config) throw new Error('No AI provider selected. Pick one in Settings → AI Providers.')
    return { config, provider: createProvider(config, secrets.get(config.id)) }
  }
  const isProviderReady = (id: string) => {
    const config = settings.get().providers.find((p) => p.id === id)
    return !!config && (config.kind !== 'openai-compatible' || !!config.baseUrl)
  }
  const providerViews = (): ProviderView[] =>
    settings.get().providers.map((p) => ({ ...p, hasApiKey: secrets.has(p.id) }))

  // ---------- chat ----------
  const orchestrator = new Orchestrator({
    store,
    tools: combineToolHosts([desktop, mcp]),
    getSettings: () => settings.get(),
    getProvider,
    getCharacter: (id) => characters.get(id),
    setToolPermission: (name, permission) =>
      settings.update({ toolPermissions: { ...settings.get().toolPermissions, [name]: permission } }),
    emit: (e: ChatEvent) => broadcast('chat-event', e),
    onApprovalNeeded: () => openBubble(false)
  })

  // ---------- bubble / tips ----------
  let tipTimer: NodeJS.Timeout | undefined
  const openBubble = (focus: boolean, prompt?: string) => {
    clearTimeout(tipTimer)
    characterWindow.show(focus)
    characterWindow.setMode('open')
    characterWindow.send('tip', null)
    characterWindow.send('open-bubble', { focus, prompt })
    refreshTray()
  }
  const closeBubble = () => {
    characterWindow.setMode('closed')
  }
  const showTip = (tip: Tip) => {
    characterWindow.setMode('tip')
    characterWindow.send('tip', tip)
    clearTimeout(tipTimer)
    tipTimer = setTimeout(dismissTip, 20_000)
  }
  const dismissTip = () => {
    clearTimeout(tipTimer)
    if (characterWindow.mode === 'tip') characterWindow.setMode('closed')
    characterWindow.send('tip', null)
  }

  const tips = new TipEngine({
    getSettings: () => settings.get().tips,
    getCharacterTips: () => currentCharacter()?.tips ?? [],
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    readClipboard: () => clipboard.readText(),
    canShow: () => characterWindow.visible && characterWindow.mode === 'closed' && !orchestrator.busy,
    show: showTip
  })

  // ---------- hotkey ----------
  let registeredHotkey = ''
  const toggleFromHotkey = () => {
    if (characterWindow.visible && characterWindow.mode === 'open') closeBubble()
    else openBubble(true)
  }
  const registerHotkey = (accelerator: string): boolean => {
    if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
    registeredHotkey = ''
    try {
      if (accelerator && globalShortcut.register(accelerator, toggleFromHotkey)) {
        registeredHotkey = accelerator
        return true
      }
    } catch {
      /* invalid accelerator */
    }
    return false
  }

  // ---------- tray ----------
  const tray = new AppTray(join(resourcesDir, 'icons'), {
    toggleCharacter: () => {
      if (characterWindow.visible) characterWindow.hide()
      else characterWindow.show(false)
      refreshTray()
    },
    openChat: () => openBubble(true),
    newChat: () => {
      openBubble(true)
      characterWindow.send('new-chat')
    },
    setCharacter: (id) => settings.update({ characterId: id }),
    setDoNotDisturb: (on) => settings.update({ tips: { ...settings.get().tips, doNotDisturb: on } }),
    openSettings: () => openSettingsWindow(),
    quit: () => app.quit()
  })
  const refreshTray = () =>
    tray.update(settings.get(), characters.list().characters, characterWindow.visible, registeredHotkey)

  // ---------- react to settings changes ----------
  let previous: Settings = settings.get()
  const applySystemSettings = (s: Settings) => {
    if (process.platform === 'darwin') {
      if (s.showDockIcon) void app.dock?.show()
      else app.dock?.hide()
    }
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin })
  }
  settings.on('change', (s: Settings) => {
    if (s.hotkey !== previous.hotkey) registerHotkey(s.hotkey)
    if (JSON.stringify(s.mcpServers) !== JSON.stringify(previous.mcpServers)) void mcp.sync(s.mcpServers)
    if (s.characterId !== previous.characterId) applyCharacterSize()
    if (s.showDockIcon !== previous.showDockIcon || s.launchAtLogin !== previous.launchAtLogin)
      applySystemSettings(s)
    previous = s
    broadcast('settings', s)
    refreshTray()
  })
  mcp.on('status', (status) => broadcast('mcp-status', status))

  // ---------- IPC ----------
  // Only our own pages may call in. The renderer can change settings that start
  // MCP servers (i.e. run commands), so a stray frame or page must never reach this.
  const rendererFile = resolve(__dirname, '../renderer/index.html')
  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL']?.replace(/\/$/, '') : undefined
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const frame = e.senderFrame
    if (!frame || frame.parent) return false
    const url = frame.url.split('#')[0]
    if (devUrl && (url === devUrl || url.startsWith(devUrl + '/'))) return true
    try {
      return url.startsWith('file:') && resolve(fileURLToPath(url)) === rendererFile
    } catch {
      return false
    }
  }
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('Blocked IPC from an untrusted page')
      return fn(...args)
    })
  const listen = (channel: string, fn: (e: IpcMainEvent, ...args: any[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (trusted(e)) fn(e, ...args)
    })

  handle('settings:get', () => settings.get())
  handle('settings:update', (patch: SettingsPatch) => {
    // Providers (and their base URLs) only change through providers:save.
    const { providers: _ignored, ...rest } = (patch ?? {}) as Partial<Settings>
    return settings.update(rest)
  })

  handle('providers:list', () => providerViews())
  handle('providers:save', (p: ProviderConfig, apiKey?: string | null) => {
    const list = settings.get().providers
    const next = list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]
    if (apiKey !== undefined) secrets.set(p.id, apiKey)
    settings.update({ providers: next })
    return providerViews()
  })
  handle('providers:delete', (id: string) => {
    const s = settings.get()
    secrets.set(id, null)
    const providers = s.providers.filter((p) => p.id !== id)
    settings.update({
      providers,
      ...(s.activeProviderId === id ? { activeProviderId: providers[0]?.id ?? '' } : {})
    })
    return providerViews()
  })
  handle('providers:models', (id: string) => {
    // A provider still being set up (e.g. a custom one with no URL yet) just has no models.
    if (!isProviderReady(id)) return []
    return getProvider(id).provider.listModels()
  })
  handle('providers:test', async (id: string) => {
    if (!isProviderReady(id)) return { ok: false, message: 'Add a base URL first.' }
    const { provider } = getProvider(id)
    try {
      const models = await provider.listModels()
      return { ok: true, message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` }
    } catch (err) {
      return { ok: false, message: provider.describeError(err) }
    }
  })

  handle('chat:list', (query?: string) => store.listConversations(query))
  handle('chat:messages', (id: string) => store.getMessages(id))
  handle('chat:send', async (conversationId: string | null, text: string) => {
    const { conversationId: id } = await orchestrator.send(conversationId, text)
    return id
  })
  handle('chat:stop', (id: string) => orchestrator.stop(id))
  handle('chat:approve', (requestId: string, decision: ApprovalDecision) =>
    orchestrator.resolveApproval(requestId, decision)
  )
  handle('chat:rename', (id: string, title: string) => {
    store.updateConversation(id, { title })
    const c = store.getConversation(id)
    if (c) broadcast('chat-event', { type: 'conversation', conversation: c } satisfies ChatEvent)
  })
  handle('chat:delete', (id: string) => {
    orchestrator.stop(id)
    store.deleteConversation(id)
  })
  handle('chat:export', async (id: string) => {
    const c = store.getConversation(id)
    if (!c) return false
    const result = await dialog.showSaveDialog({
      defaultPath: join(app.getPath('documents'), `${c.title.replace(/[\\/:*?"<>|]/g, '-')}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, toMarkdown(c, store.getMessages(id)))
    return true
  })

  handle('characters:list', () => characters.list())
  handle('characters:reload', () => {
    const result = characters.load()
    applyCharacterSize()
    broadcast('settings', settings.get())
    refreshTray()
    return result
  })
  handle('characters:open-folder', () => shell.openPath(characters.userDir))

  handle('tools:builtin', () => desktop.info())
  handle('mcp:status', () => mcp.status())
  handle('mcp:restart', (name?: string) => mcp.restart(name))
  handle('mcp:import-claude', () => {
    const file =
      process.platform === 'win32'
        ? join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json')
        : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    if (!existsSync(file)) return { imported: 0, message: 'Claude Desktop config not found.' }
    try {
      const found = parseMcpConfig(readFileSync(file, 'utf8'))
      const existing = settings.get().mcpServers
      const added = found.filter((f) => !existing.some((e) => e.name === f.name))
      settings.update({ mcpServers: [...existing, ...added] })
      return {
        imported: added.length,
        message: added.length
          ? `Imported ${added.length} server${added.length === 1 ? '' : 's'}.`
          : 'No new servers to import.'
      }
    } catch (err) {
      return { imported: 0, message: `Could not read Claude Desktop config: ${String(err)}` }
    }
  })

  handle('window:get-layout', () => characterWindow.layout)
  handle('window:set-bubble', (mode: 'open' | 'closed') => (mode === 'open' ? openBubble(true) : closeBubble()))
  handle('hotkey:check', (accelerator: string) => {
    if (accelerator === registeredHotkey) return { ok: true, message: 'Current hotkey.' }
    try {
      const ok = globalShortcut.register(accelerator, () => {})
      if (ok) globalShortcut.unregister(accelerator)
      return ok
        ? { ok: true, message: 'Available.' }
        : { ok: false, message: 'Another app is already using this shortcut.' }
    } catch {
      return { ok: false, message: 'Not a valid shortcut.' }
    }
  })

  listen('window:ignore-mouse', (e, ignore: boolean) => {
    BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(ignore, { forward: true })
  })
  listen('window:drag-by', (_e, dx: number, dy: number) => characterWindow.dragBy(dx, dy))
  listen('window:drag-end', () => characterWindow.dragEnd())
  listen('tip:dismiss', () => dismissTip())
  listen('tip:accept', (_e, tip: Tip) => openBubble(true, tip.prompt))
  listen('settings:open', (_e, tab?: string) => openSettingsWindow(tab))

  // ---------- start ----------
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  )
  applySystemSettings(settings.get())
  characterWindow.create()
  applyCharacterSize()
  if (!registerHotkey(settings.get().hotkey)) {
    console.warn(`Could not register hotkey ${settings.get().hotkey}`)
  }
  tray.create()
  refreshTray()
  tips.start()

  shellPath = await loadShellPath()
  void mcp.sync(settings.get().mcpServers)

  app.on('second-instance', () => openBubble(true))
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    tips.stop()
    orchestrator.stopAll()
    globalShortcut.unregisterAll()
    void mcp.closeAll().finally(() => {
      store.close()
      app.exit(0)
    })
  })
}
