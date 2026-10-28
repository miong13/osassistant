// Types shared by the main process, preload bridge and renderer.

export type ProviderKind = 'anthropic' | 'ollama' | 'openai-compatible'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ProviderConfig {
  id: string
  kind: ProviderKind
  label: string
  /** Base URL for Ollama / OpenAI-compatible providers. */
  baseUrl?: string
  /** Models the user typed in by hand (for services without a model list). */
  extraModels?: string[]
  enabled: boolean
}

/** Provider info sent to the renderer. API keys never leave the main process. */
export interface ProviderView extends ProviderConfig {
  hasApiKey: boolean
}

export interface ModelInfo {
  id: string
  label: string
}

export interface McpServerConfig {
  name: string
  enabled: boolean
  /** stdio servers */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** remote (streamable HTTP) servers */
  url?: string
  headers?: Record<string, string>
}

export type ToolPermission = 'ask' | 'allow' | 'disabled'

export interface TipSettings {
  enabled: boolean
  doNotDisturb: boolean
  minMinutesBetween: number
  greeting: boolean
  breakReminder: boolean
  breakAfterMinutes: number
  clipboard: boolean
  randomTips: boolean
}

export interface Settings {
  hotkey: string
  showDockIcon: boolean
  launchAtLogin: boolean
  /** Opens quick actions (explain, translate…) for copied text. Empty = off. */
  selectionHotkey: string
  /** Check GitHub for new versions in the background. */
  autoUpdate: boolean
  characterId: string
  activeProviderId: string
  activeModel: string
  effort: Effort
  providers: ProviderConfig[]
  mcpServers: McpServerConfig[]
  toolPermissions: Record<string, ToolPermission>
  tips: TipSettings
  /** Top-left of the character on screen, per display id. */
  characterPositions: Record<string, { x: number; y: number }>
}

// ---------- Chat ----------

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
export const IMAGE_MEDIA_TYPES: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

export type ChatPart =
  | { type: 'text'; text: string }
  /** An image the user attached. Stored as a file; `data` (base64) is filled in only when sending to a model. */
  | { type: 'image'; id: string; mediaType: ImageMediaType; data?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; name: string; content: string; isError?: boolean }

export interface RawTurn {
  providerKind: ProviderKind
  model: string
  /** The provider's own content blocks, replayed unchanged on the next request. */
  content: unknown
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'tool'
  parts: ChatPart[]
  raw?: RawTurn
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  characterId: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
}

export type ApprovalDecision = 'allow' | 'deny' | 'always'

export type ChatEvent =
  | { type: 'turn-start'; conversationId: string }
  | { type: 'thinking'; conversationId: string; active: boolean }
  | { type: 'text-delta'; conversationId: string; messageId: string; text: string }
  | { type: 'message'; conversationId: string; message: ChatMessage }
  /** Messages were removed (retry / edit); this is the full list now. */
  | { type: 'history'; conversationId: string; messages: ChatMessage[] }
  | {
      type: 'tool-approval'
      conversationId: string
      requestId: string
      toolCallId: string
      name: string
      input: unknown
    }
  | {
      type: 'tool-status'
      conversationId: string
      toolCallId: string
      status: 'waiting' | 'running' | 'done' | 'error' | 'denied'
    }
  | { type: 'error'; conversationId: string; message: string }
  | { type: 'turn-end'; conversationId: string }
  | { type: 'conversation'; conversation: Conversation }

// ---------- Characters ----------

export type CharacterState =
  | 'idle'
  | 'greet'
  | 'listen'
  | 'think'
  | 'talk'
  | 'tip'
  | 'sleep'
  | 'error'

export type StateAsset =
  | { type: 'image'; src: string }
  | { type: 'sprite'; src: string; frameWidth: number; frameHeight: number; frames: number; fps: number }

export interface CharacterInfo {
  id: string
  name: string
  persona: string
  greeting: string
  tips: string[]
  size: { width: number; height: number }
  /** Missing states fall back to idle. Asset src values are URLs the renderer can load. */
  states: Partial<Record<CharacterState, StateAsset>> & { idle: StateAsset }
  builtIn: boolean
}

export interface CharacterLoadError {
  folder: string
  message: string
}

// ---------- MCP ----------

export interface McpToolInfo {
  /** Name exposed to the model: server__tool */
  name: string
  server: string
  originalName: string
  description: string
  /** Shown when the user hasn't picked a permission. Missing means 'ask'. */
  defaultPermission?: ToolPermission
}

export interface McpServerStatus {
  name: string
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: McpToolInfo[]
  logs: string[]
}

// ---------- Tips ----------

export interface Tip {
  id: string
  text: string
  /** If set, accepting the tip sends this message to the chat. */
  prompt?: string
  /** Button labels, for tips that do something other than open the chat. */
  acceptLabel?: string
  dismissLabel?: string
}

export interface UpdateStatus {
  state: 'idle' | 'unsupported' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  /** Download progress, 0-100. */
  percent?: number
  /** True when this build can't install updates itself (unsigned Mac app): download from the releases page. */
  manual?: boolean
  message?: string
}

// ---------- Window layout ----------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type BubbleMode = 'closed' | 'tip' | 'open'

export interface Layout {
  mode: BubbleMode
  /** Rects relative to the window. */
  character: Rect
  bubble: Rect | null
  /** Which side of the character the bubble is on (for the speech-bubble tail). */
  bubbleSide: 'left' | 'right'
}
