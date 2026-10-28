import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalDecision, CharacterInfo, ChatMessage, ChatPart } from '../../../shared/types'
import { IconCopy, IconEdit, IconRetry, IconWrench } from '../lib/icons'
import { Markdown } from './Markdown'
import type { ChatState, PendingApproval, ToolStatus } from './useChat'

type ToolResult = Extract<ChatPart, { type: 'tool_result' }>

const SUGGESTIONS = ['What can you help me with?', 'Explain something simply', 'Help me write an email']

export function MessageList(props: {
  state: ChatState
  character: CharacterInfo
  onApprove(requestId: string, d: ApprovalDecision): void
  onDismissError(): void
  onSuggestion(text: string): void
  onRetry(): void
  onEdit(text: string): void
}) {
  const { state, character } = props
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const turns = useMemo(() => splitTurns(state.messages), [state.messages])

  const results = useMemo(() => {
    const map = new Map<string, ToolResult>()
    for (const m of state.messages)
      for (const p of m.parts) if (p.type === 'tool_result') map.set(p.toolCallId, p)
    return map
  }, [state.messages])

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [state.messages, state.streaming, state.approvals, state.error, state.thinking])

  const renderReply = (m: ChatMessage) => {
    if (m.role !== 'assistant') return null
    return m.parts.map((p, i) => {
      if (p.type === 'text')
        return p.text.trim() ? (
          <div key={`${m.id}-${i}`} className="msg assistant">
            <Markdown text={p.text} />
          </div>
        ) : null
      if (p.type === 'tool_call')
        return (
          <ToolCard
            key={`${m.id}-${i}`}
            name={p.name}
            input={p.input}
            result={results.get(p.id)}
            status={state.toolStatus[p.id]}
            approval={state.approvals.find((a) => a.toolCallId === p.id)}
            onApprove={props.onApprove}
          />
        )
      return null
    })
  }

  const streamingEntries = Object.entries(state.streaming)
  const showTyping =
    state.busy && !state.approvals.length && (state.thinking || streamingEntries.every(([, t]) => !t))

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {state.messages.length === 0 && !state.busy && (
        <div className="greeting">
          <strong>{character.name}</strong>
          {character.greeting}
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => props.onSuggestion(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {turns.map((turn, ti) => {
        const isLast = ti === turns.length - 1
        const idle = !state.busy
        const question = turn.user ? textOf(turn.user.parts) : ''
        const answer = turn.replies
          .filter((m) => m.role === 'assistant')
          .map((m) => textOf(m.parts).trim())
          .filter(Boolean)
          .join('\n\n')
        const canCopy = Boolean(answer) && !(isLast && state.busy)
        const canRetry = isLast && idle && Boolean(turn.user)
        return (
          <div key={turn.user?.id ?? `turn-${ti}`} className={`turn${isLast ? ' last' : ''}`}>
            {turn.user && (
              <div className="user-row">
                {isLast && idle && (
                  <button className="ghost-btn msg-edit" title="Edit message" onClick={() => props.onEdit(question)}>
                    <IconEdit />
                  </button>
                )}
                <div className="user-col">
                  {turn.user.parts.some((p) => p.type === 'image') && (
                    <div className="msg-images">
                      {turn.user.parts.map((p) =>
                        p.type === 'image' ? (
                          <StoredImage key={p.id} conversationId={turn.user!.conversationId} id={p.id} mediaType={p.mediaType} />
                        ) : null
                      )}
                    </div>
                  )}
                  {question && <div className="msg user">{question}</div>}
                </div>
              </div>
            )}
            {turn.replies.map(renderReply)}
            {(canCopy || canRetry) && (
              <div className="msg-actions">
                {canCopy && <CopyButton text={answer} />}
                {canRetry && (
                  <button className="ghost-btn" title="Answer again" onClick={props.onRetry}>
                    <IconRetry /> Retry
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}

      {streamingEntries.map(([id, text]) =>
        text ? (
          <div key={id} className="msg assistant">
            <Markdown text={text} />
          </div>
        ) : null
      )}

      {showTyping && (
        <div className="typing" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}

      {state.error && (
        <div className="error-banner" role="alert">
          <span>{state.error}</span>
          <span style={{ display: 'flex', gap: 4 }}>
            {/settings/i.test(state.error) && (
              <button className="btn small" onClick={() => window.api.openSettings('providers')}>
                Settings
              </button>
            )}
            <button className="btn small" onClick={props.onDismissError}>
              OK
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function ToolCard(props: {
  name: string
  input: unknown
  result?: ToolResult
  status?: ToolStatus
  approval?: PendingApproval
  onApprove(requestId: string, d: ApprovalDecision): void
}) {
  const { name, input, result, approval } = props
  const status = approval ? 'waiting' : props.status ?? (result ? (result.isError ? 'error' : 'done') : 'running')
  // Split at the first "__" only, so no part of the tool's name is hidden.
  const cut = name.indexOf('__')
  const [server, tool] = cut > 0 ? [name.slice(0, cut), name.slice(cut + 2)] : ['', name]
  const label =
    status === 'waiting'
      ? 'Wants to use'
      : status === 'running'
        ? 'Using'
        : status === 'denied'
          ? 'Skipped'
          : status === 'error'
            ? 'Failed'
            : 'Used'
  return (
    <details className="tool-card" open={Boolean(approval)}>
      <summary>
        <span className={`status-dot ${status}`} />
        <IconWrench />
        <span className="tool-name">
          {label} {tool}
          {server && <span className="muted"> · {server}</span>}
        </span>
      </summary>
      <pre>{showHidden(JSON.stringify(input, null, 2) ?? '')}</pre>
      {result && <pre className={result.isError ? 'error-text' : ''}>{result.content}</pre>}
      {approval && (
        <div className="actions">
          <button className="btn small primary" onClick={() => props.onApprove(approval.requestId, 'allow')}>
            Allow once
          </button>
          <button className="btn small" onClick={() => props.onApprove(approval.requestId, 'always')}>
            Always allow
          </button>
          <button className="btn small danger" onClick={() => props.onApprove(approval.requestId, 'deny')}>
            Deny
          </button>
        </div>
      )}
    </details>
  )
}

// Invisible characters could hide data inside a tool input. Show them as escapes
// so the user sees exactly what they are approving.
const HIDDEN = /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu

function showHidden(text: string): string {
  return text.replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
}

/** A user message and everything that answered it. */
function splitTurns(messages: ChatMessage[]): { user?: ChatMessage; replies: ChatMessage[] }[] {
  const turns: { user?: ChatMessage; replies: ChatMessage[] }[] = []
  for (const m of messages) {
    if (m.role === 'user') turns.push({ user: m, replies: [] })
    else if (turns.length) turns[turns.length - 1].replies.push(m)
    else turns.push({ replies: [m] })
  }
  return turns
}

function textOf(parts: ChatPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="ghost-btn"
      title="Copy answer"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      <IconCopy /> {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** An attached image, loaded from the app's data folder when shown. */
function StoredImage(props: { conversationId: string; id: string; mediaType: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void window.api.getImage(props.conversationId, props.id, props.mediaType).then((u) => !cancelled && setUrl(u))
    return () => {
      cancelled = true
    }
  }, [props.conversationId, props.id, props.mediaType])
  if (url === undefined) return null
  if (url === null) return <span className="missing">[image no longer available]</span>
  return <img src={url} alt="Attached image" />
}
