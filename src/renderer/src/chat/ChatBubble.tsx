import { useEffect, useRef, useState } from 'react'
import type { CharacterInfo, ModelInfo, ProviderView, Rect, Settings } from '../../../shared/types'
import { IconBack, IconClose, IconGear, IconHistory, IconPlus, IconSend, IconStop } from '../lib/icons'
import { BubbleFrame } from './BubbleFrame'
import { HistoryPanel } from './HistoryPanel'
import { MessageList } from './MessageList'
import type { useChat } from './useChat'

export function ChatBubble(props: {
  rect: Rect
  side: 'left' | 'right'
  tailY: number
  character: CharacterInfo
  settings: Settings
  chat: ReturnType<typeof useChat>
  focusToken: number
  onTyping(): void
  onClose(): void
}) {
  const { chat, character } = props
  const [showHistory, setShowHistory] = useState(false)
  const [draft, setDraft] = useState('')
  /** True while the composer is editing the last message instead of writing a new one. */
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!showHistory) input.current?.focus()
  }, [props.focusToken, showHistory, chat.state.conversationId])

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden'
  }, [draft])

  const submit = () => {
    if (!draft.trim() || chat.state.busy) return
    void (editing ? chat.editLast(draft) : chat.send(draft))
    setDraft('')
    setEditing(false)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
  }

  // Editing belongs to the chat it started in.
  useEffect(() => {
    setEditing(false)
  }, [chat.state.conversationId])

  return (
    <BubbleFrame rect={props.rect} side={props.side} tailY={props.tailY}>
      <div className="bubble-header">
        {showHistory ? (
          <>
            <button className="icon-btn" title="Back" onClick={() => setShowHistory(false)}>
              <IconBack />
            </button>
            <span className="bubble-title" style={{ flex: 1 }}>
              Chats
            </span>
          </>
        ) : (
          <>
            <span className="bubble-title">{character.name}</span>
            <ModelPicker settings={props.settings} />
            <button className="icon-btn" title="New chat" onClick={() => void chat.open(null)}>
              <IconPlus />
            </button>
            <button className="icon-btn" title="Chat history" onClick={() => setShowHistory(true)}>
              <IconHistory />
            </button>
          </>
        )}
        <button className="icon-btn" title="Settings" onClick={() => window.api.openSettings()}>
          <IconGear />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
          <IconClose />
        </button>
      </div>

      {showHistory ? (
        <HistoryPanel
          conversations={chat.state.conversations}
          currentId={chat.state.conversationId}
          onSearch={(q) => void chat.refreshConversations(q || undefined)}
          onOpen={(id) => {
            void chat.open(id)
            setShowHistory(false)
          }}
          onDelete={(id) => void chat.remove(id)}
        />
      ) : (
        <>
          <MessageList
            state={chat.state}
            character={character}
            onApprove={chat.approve}
            onDismissError={chat.dismissError}
            onSuggestion={(text) => void chat.send(text)}
            onRetry={() => void chat.retry()}
            onEdit={(text) => {
              setDraft(text)
              setEditing(true)
              input.current?.focus()
            }}
          />
          {editing && (
            <div className="edit-banner">
              <span>Editing your last message. Sending replaces it and its answer.</span>
              <button className="btn small" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          )}
          <div className="composer">
            <textarea
              ref={input}
              rows={1}
              value={draft}
              placeholder={`Ask ${character.name} anything…`}
              onChange={(e) => {
                setDraft(e.target.value)
                props.onTyping()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                } else if (e.key === 'Escape') {
                  if (editing) cancelEdit()
                  else props.onClose()
                }
              }}
            />
            {chat.state.busy ? (
              <button className="send-btn" title="Stop" onClick={chat.stop}>
                <IconStop />
              </button>
            ) : (
              <button className="send-btn" title={editing ? 'Save and resend (Enter)' : 'Send (Enter)'} disabled={!draft.trim()} onClick={submit}>
                <IconSend />
              </button>
            )}
          </div>
        </>
      )}
    </BubbleFrame>
  )
}

function ModelPicker({ settings }: { settings: Settings }) {
  const [groups, setGroups] = useState<{ provider: ProviderView; models: ModelInfo[] }[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const providers = (await window.api.listProviders()).filter((p) => p.enabled)
      const loaded = await Promise.all(
        providers.map(async (provider) => ({
          provider,
          models: await window.api.listModels(provider.id).catch(() => [] as ModelInfo[])
        }))
      )
      if (!cancelled) setGroups(loaded)
    })()
    return () => {
      cancelled = true
    }
  }, [settings.providers])

  const value = `${settings.activeProviderId}::${settings.activeModel}`
  const known = groups.some((g) => g.provider.id === settings.activeProviderId && g.models.some((m) => m.id === settings.activeModel))

  return (
    <select
      className="model-select"
      title="Model"
      value={value}
      onChange={(e) => {
        const [activeProviderId, ...rest] = e.target.value.split('::')
        void window.api.updateSettings({ activeProviderId, activeModel: rest.join('::') })
      }}
    >
      {!known && <option value={value}>{settings.activeModel || 'Choose a model'}</option>}
      {groups.map((g) => (
        <optgroup key={g.provider.id} label={g.provider.label}>
          {g.models.length === 0 && (
            <option disabled value="">
              {g.provider.kind === 'anthropic' && !g.provider.hasApiKey ? 'Add an API key in Settings' : 'No models found'}
            </option>
          )}
          {g.models.map((m) => (
            <option key={m.id} value={`${g.provider.id}::${m.id}`}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
