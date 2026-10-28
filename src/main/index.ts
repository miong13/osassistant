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
  desktopCapturer,
  nativeTheme,
  net,
  Notification,
  screen,
  session,
  systemPreferences,
  powerMonitor,
  protocol,
  shell
} from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SettingsPatch } from '../shared/api'
import type { ApprovalDecision, ChatEvent, ImageMediaType, ProviderConfig, ProviderView, Settings, Tip, UpdateStatus } from '../shared/types'
import { IMAGE_MEDIA_TYPES } from '../shared/types'
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
import { RELEASES_URL, Updater } from './updater'
import { looksLikeSecret, stripHiddenChars } from './guards'
import { buildQuickActionPrompt } from './quickActions'
import { AttachmentStore } from './attachments'
import { captureScreen } from './screenshot'
import { canTranscribe, defaultTranscribeModel, transcribe } from './transcribe'
import { SystemTools } from './desktop/system'
import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { freemem, totalmem, uptime } from 'node:os'
import { Reminders, formatWhen, type Reminder } from './reminders'
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
  // Web permissions: only the microphone (voice input) and writing to the clipboard (Copy buttons).
  // Without a handler, Electron would grant everything, including the camera.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      return callback(types.length > 0 && types.every((t) => t === 'audio'))
    }
    callback(permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, _origin, details) =>
      permission === 'clipboard-sanitized-write' ||
      (permission === 'media' && (details as { mediaType?: string }).mediaType !== 'video')
  )

  const userData = app.getPath('userData')
  const resourcesDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')

  const settings = new SettingsStore(join(userData, 'settings.json'))
  const secrets = new SecretStore(join(userData, 'secrets.json'))
  const store = new SqliteChatStore(join(userData, 'assistant.db'))
  const characters = new CharacterLibrary(join(resourcesDir, 'characters'), join(userData, 'characters'))
  characters.load()

  let shellPath = process.env.PATH ?? ''
  const desktop = new DesktopTools(desktopDeps())
  const reminders = new Reminders({ file: join(app.getPath('userData'), 'reminders.json') })
  const attachments = new AttachmentStore(join(app.getPath('userData'), 'attachments'))
  const system = new SystemTools({
    platform: process.platform,
    osName: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform,
    osVersion: process.getSystemVersion(),
    home: homedir(),
    uptimeSeconds: uptime,
    memory: () => ({ total: totalmem(), free: freemem() }),
    disk: async (path) => {
      const s = await statfs(path)
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
    },
    isOnline: () => net.isOnline(),
    darkMode: () => nativeTheme.shouldUseDarkColors,
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    exec: (file, args) =>
      new Promise((resolve, reject) =>
        execFile(file, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) =>
          err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))
        )
      )
  })
  const mcp = new McpManager(() => shellPath, (name) => desktop.has(name) || reminders.has(name) || system.has(name))
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
    tools: combineToolHosts([desktop, system, reminders, mcp]),
    attachments,
    getSettings: () => settings.get(),
    getProvider,
    getCharacter: (id) => characters.get(id),
    setToolPermission: (name, permission) =>
      settings.update({ toolPermissions: { ...settings.get().toolPermissions, [name]: permission } }),
    emit: (e: ChatEvent) => broadcast('chat-event', e),
    onApprovalNeeded: () => openBubble(false)
  })

  // ---------- bubble / tips ----------
  const MAX_COPIED_CHARS = 20_000
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
  /** Sticky tips (reminders) stay until the user answers them. */
  const showTip = (tip: Tip, sticky = false) => {
    characterWindow.setMode('tip')
    characterWindow.send('tip', tip)
    clearTimeout(tipTimer)
    if (!sticky) tipTimer = setTimeout(dismissTip, 20_000)
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
  // Selection hotkey: act on text the user just copied.
  let registeredSelectionHotkey = ''
  let copiedText = ''
  const openQuickActions = () => {
    const text = stripHiddenChars(clipboard.readText()).trim()
    copiedText = text.slice(0, MAX_COPIED_CHARS)
    openBubble(true)
    characterWindow.send('quick-actions', {
      preview: text.slice(0, 400),
      length: text.length,
      truncated: text.length > MAX_COPIED_CHARS,
      looksSecret: text ? looksLikeSecret(text) : false
    })
  }
  const registerSelectionHotkey = (accelerator: string): boolean => {
    if (registeredSelectionHotkey) globalShortcut.unregister(registeredSelectionHotkey)
    registeredSelectionHotkey = ''
    try {
      if (accelerator && accelerator !== registeredHotkey && globalShortcut.register(accelerator, openQuickActions)) {
        registeredSelectionHotkey = accelerator
        return true
      }
    } catch {
      /* invalid accelerator */
    }
    return !accelerator
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
    checkForUpdates: () => void updater.check(),
    installUpdate: () => installUpdate(),
    openReleasesPage: () => void shell.openExternal(RELEASES_URL),
    quit: () => app.quit()
  })
  const refreshTray = () =>
    tray.update(settings.get(), characters.list().characters, characterWindow.visible, registeredHotkey, updater.current)

  // ---------- reminders ----------
  const firedReminders = new Map<string, Reminder>()
  const fireReminder = (r: Reminder, late: boolean) => {
    const text = late ? `Reminder from ${formatWhen(r.dueAt)}: ${r.message}` : `Reminder: ${r.message}`
    // The character says it when it's free; otherwise (chat open, another tip showing, hidden) use a notification.
    if (characterWindow.visible && characterWindow.mode === 'closed') {
      const id = `reminder:${r.id}`
      firedReminders.set(id, r)
      showTip({ id, text, acceptLabel: 'Snooze 10 min', dismissLabel: 'Done' }, true)
    } else if (Notification.isSupported()) {
      const n = new Notification({ title: 'Reminder', body: late ? text : r.message })
      n.on('click', () => openBubble(true))
      n.show()
    }
  }

  // ---------- quitting ----------
  let quitting = false
  const shutdown = async () => {
    tips.stop()
    reminders.stop()
    updater.stop()
    orchestrator.stopAll()
    globalShortcut.unregisterAll()
    await mcp.closeAll().catch(() => undefined)
    store.close()
  }
  const installUpdate = () => {
    if (quitting || updater.current.state !== 'ready') return
    quitting = true
    void shutdown().finally(() => updater.install())
  }

  // ---------- updates ----------
  const updater = new Updater(() => settings.get().autoUpdate)
  updater.on('status', (s: UpdateStatus) => {
    broadcast('update-status', s)
    refreshTray()
  })
  updater.on('needs-user', (s: UpdateStatus) => {
    // The character mentions it, unless it's busy; the tray and About page always show it too.
    if (!characterWindow.visible || characterWindow.mode !== 'closed' || orchestrator.busy) return
    showTip(
      s.state === 'ready'
        ? { id: 'update', text: `Version ${s.version} is ready! Restart now to update?`, acceptLabel: 'Restart', dismissLabel: 'Later' }
        : { id: 'update', text: `Version ${s.version} is out! Want to download it?`, acceptLabel: 'Download', dismissLabel: 'Later' }
    )
  })

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
    if (s.selectionHotkey !== previous.selectionHotkey) registerSelectionHotkey(s.selectionHotkey)
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
  handle('chat:send', async (conversationId: string | null, text: string, images?: unknown) => {
    const { conversationId: id } = await orchestrator.send(conversationId, text, images)
    return id
  })
  handle('chat:image', (conversationId: string, id: string, mediaType: string) => {
    if (!IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType)) return null
    try {
      const data = attachments.read(conversationId, id, mediaType as ImageMediaType)
      return data ? `data:${mediaType};base64,${data}` : null
    } catch {
      return null
    }
  })
  handle('voice:providers', () =>
    settings
      .get()
      .providers.filter(canTranscribe)
      .map((p) => ({ id: p.id, label: p.label, defaultModel: defaultTranscribeModel(p.baseUrl) }))
  )
  handle('voice:microphone', async () => {
    if (process.platform !== 'darwin') return { ok: true }
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return { ok: true }
    if (status === 'not-determined' && (await systemPreferences.askForMediaAccess('microphone'))) return { ok: true }
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    return {
      ok: false,
      message: 'To talk to the assistant, turn on OS Assistant in System Settings → Privacy & Security → Microphone.'
    }
  })
  handle('voice:transcribe', async (audio: unknown, mimeType: unknown) => {
    const voice = settings.get().voice
    const config = settings.get().providers.find((p) => p.id === voice.transcribeProviderId)
    if (!config || !canTranscribe(config))
      throw new Error('Voice input is off. Choose a speech-to-text service in Settings → General.')
    const apiKey = secrets.get(config.id)
    try {
      return await transcribe({ config, apiKey, model: voice.transcribeModel, audio, mimeType })
    } catch (err) {
      throw new Error(createProvider(config, apiKey).describeError(err))
    }
  })
  handle('screen:capture', () =>
    captureScreen({
      platform: process.platform,
      screenAccess: () => (process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'),
      openPrivacySettings: () =>
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
      display: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
      getSources: (opts) => desktopCapturer.getSources(opts),
      setInvisible: (v) => characterWindow.setInvisible(v)
    })
  )
  handle('chat:stop', (id: string) => orchestrator.stop(id))
  handle('chat:retry', async (id: string) => {
    await orchestrator.retry(id)
  })
  handle('chat:edit', async (id: string, text: string) => {
    await orchestrator.editLast(id, text)
  })
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
    attachments.deleteConversation(id)
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

  handle('tools:builtin', () => [...desktop.info(), ...system.info(), ...reminders.info()])
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
  handle('quick-actions:prompt', (id: string, extra?: string) => buildQuickActionPrompt(id, extra, copiedText))
  handle('hotkey:check', (accelerator: string, kind: 'chat' | 'selection' = 'chat') => {
    const mine = kind === 'chat' ? registeredHotkey : registeredSelectionHotkey
    const other = kind === 'chat' ? registeredSelectionHotkey : registeredHotkey
    if (accelerator === mine) return { ok: true, message: 'Current hotkey.' }
    if (accelerator === other) return { ok: false, message: 'Already used by the other hotkey.' }
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
  listen('tip:dismiss', () => {
    firedReminders.clear() // "Done" on a reminder
    dismissTip()
  })
  listen('tip:accept', (_e, tip: Tip) => {
    const reminder = firedReminders.get(tip.id)
    if (reminder) {
      firedReminders.delete(tip.id)
      dismissTip()
      reminders.add(reminder.message, Date.now() + 10 * 60_000)
      return
    }
    if (tip.id === 'update') {
      dismissTip()
      if (updater.current.state === 'ready') installUpdate()
      else void shell.openExternal(RELEASES_URL)
      return
    }
    openBubble(true, tip.prompt)
  })
  listen('settings:open', (_e, tab?: string) => openSettingsWindow(tab))
  handle('updates:status', () => updater.current)
  handle('updates:check', () => updater.check())
  listen('updates:install', () => installUpdate())
  listen('updates:open-page', () => void shell.openExternal(RELEASES_URL))

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
  if (!registerSelectionHotkey(settings.get().selectionHotkey)) {
    console.warn(`Could not register selection hotkey ${settings.get().selectionHotkey}`)
  }
  tray.create()
  refreshTray()
  tips.start()
  void updater.start()
  reminders.start(fireReminder)

  shellPath = await loadShellPath()
  void mcp.sync(settings.get().mcpServers)

  app.on('second-instance', () => openBubble(true))
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    // Quit for real once cleaned up (quitting is set, so this handler lets it through).
    // A normal quit, unlike app.exit(), lets a downloaded update install.
    void shutdown().finally(() => app.quit())
  })
}
