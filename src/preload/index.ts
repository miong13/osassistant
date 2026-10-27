import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '../shared/api'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: Api = {
  platform: process.platform,

  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  onSettings: (cb) => on('settings', cb),

  listProviders: () => invoke('providers:list'),
  saveProvider: (p, apiKey) => invoke('providers:save', p, apiKey),
  deleteProvider: (id) => invoke('providers:delete', id),
  listModels: (id) => invoke('providers:models', id),
  testProvider: (id) => invoke('providers:test', id),

  listConversations: (query) => invoke('chat:list', query),
  getMessages: (id) => invoke('chat:messages', id),
  sendMessage: (id, text) => invoke('chat:send', id, text),
  stop: (id) => invoke('chat:stop', id),
  approveTool: (requestId, decision) => invoke('chat:approve', requestId, decision),
  renameConversation: (id, title) => invoke('chat:rename', id, title),
  deleteConversation: (id) => invoke('chat:delete', id),
  exportConversation: (id) => invoke('chat:export', id),
  onChatEvent: (cb) => on('chat-event', cb),

  listCharacters: () => invoke('characters:list'),
  reloadCharacters: () => invoke('characters:reload'),
  openCharactersFolder: () => invoke('characters:open-folder'),

  builtinTools: () => invoke('tools:builtin'),
  mcpStatus: () => invoke('mcp:status'),
  restartMcp: (name) => invoke('mcp:restart', name),
  importClaudeDesktopMcp: () => invoke('mcp:import-claude'),
  onMcpStatus: (cb) => on('mcp-status', cb),

  setBubble: (mode) => invoke('window:set-bubble', mode),
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:ignore-mouse', ignore),
  dragBy: (dx, dy) => ipcRenderer.send('window:drag-by', dx, dy),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  getLayout: () => invoke('window:get-layout'),
  onLayout: (cb) => on('layout', cb),
  onOpenBubble: (cb) => on('open-bubble', cb),
  onNewChat: (cb) => on('new-chat', () => cb()),
  onTip: (cb) => on('tip', cb),
  dismissTip: () => ipcRenderer.send('tip:dismiss'),
  acceptTip: (tip) => ipcRenderer.send('tip:accept', tip),
  openSettings: (tab) => ipcRenderer.send('settings:open', tab),
  onSettingsTab: (cb) => on('settings-tab', cb),

  checkHotkey: (accelerator) => invoke('hotkey:check', accelerator)
}

contextBridge.exposeInMainWorld('api', api)
