import { useEffect, useMemo, useRef } from 'react'
import type { ApprovalDecision, CharacterInfo, ChatPart } from '../../../shared/types'
import { IconWrench } from '../lib/icons'
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
}) {
  const { state, character } = props
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

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

      {state.messages.map((m) => {
        if (m.role === 'tool') return null
        if (m.role === 'user') {
          const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
          return (
            <div key={m.id} className="msg user">
              {text}
            </div>
          )
        }
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
