import type {
  ApprovalDecision,
  CharacterInfo,
  CharacterLoadError,
  ChatEvent,
  ChatMessage,
  Conversation,
  Layout,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  ProviderConfig,
  ProviderView,
  Settings,
  Tip
} from './types'

export type SettingsPatch = Partial<Omit<Settings, 'providers'>>

/** The bridge exposed on window.api by the preload script. */
export interface Api {
  platform: string

  // settings
  getSettings(): Promise<Settings>
  updateSettings(patch: SettingsPatch): Promise<Settings>
  onSettings(cb: (s: Settings) => void): () => void

  // providers
  listProviders(): Promise<ProviderView[]>
  saveProvider(p: ProviderConfig, apiKey?: string | null): Promise<ProviderView[]>
  deleteProvider(id: string): Promise<ProviderView[]>
  listModels(providerId: string): Promise<ModelInfo[]>
  testProvider(providerId: string): Promise<{ ok: boolean; message: string }>

  // chat
  listConversations(query?: string): Promise<Conversation[]>
  getMessages(conversationId: string): Promise<ChatMessage[]>
  sendMessage(conversationId: string | null, text: string): Promise<string>
  stop(conversationId: string): Promise<void>
  approveTool(requestId: string, decision: ApprovalDecision): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  exportConversation(id: string): Promise<boolean>
  onChatEvent(cb: (e: ChatEvent) => void): () => void

  // characters
  listCharacters(): Promise<{ characters: CharacterInfo[]; errors: CharacterLoadError[] }>
  reloadCharacters(): Promise<{ characters: CharacterInfo[]; errors: CharacterLoadError[] }>
  openCharactersFolder(): Promise<void>

  // tools
  builtinTools(): Promise<McpToolInfo[]>
  mcpStatus(): Promise<McpServerStatus[]>
  restartMcp(name?: string): Promise<void>
  importClaudeDesktopMcp(): Promise<{ imported: number; message: string }>
  onMcpStatus(cb: (s: McpServerStatus[]) => void): () => void

  // character window
  setBubble(mode: 'closed' | 'open'): Promise<void>
  setIgnoreMouse(ignore: boolean): void
  dragBy(dx: number, dy: number): void
  dragEnd(): void
  getLayout(): Promise<Layout | null>
  onLayout(cb: (l: Layout) => void): () => void
  onOpenBubble(cb: (opts: { focus: boolean; prompt?: string }) => void): () => void
  onNewChat(cb: () => void): () => void
  onTip(cb: (tip: Tip | null) => void): () => void
  dismissTip(): void
  acceptTip(tip: Tip): void
  openSettings(tab?: string): void
  onSettingsTab(cb: (tab: string) => void): () => void

  // misc
  checkHotkey(accelerator: string): Promise<{ ok: boolean; message: string }>
}
