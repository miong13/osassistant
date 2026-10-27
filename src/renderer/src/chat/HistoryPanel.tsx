import { useEffect, useState } from 'react'
import type { Conversation } from '../../../shared/types'
import { IconDownload, IconEdit, IconTrash } from '../lib/icons'

export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.round((now - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString()
}

export function HistoryPanel(props: {
  conversations: Conversation[]
  currentId: string | null
  onOpen(id: string): void
  onDelete(id: string): void
  onSearch(query: string): void
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => props.onSearch(query), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const commitRename = async (id: string) => {
    if (draft.trim()) await window.api.renameConversation(id, draft.trim())
    setEditing(null)
  }

  return (
    <div className="history">
      <div className="history-search">
        <input
          className="field"
          placeholder="Search chats…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="history-list">
        {props.conversations.length === 0 && <div className="empty">No chats yet.</div>}
        {props.conversations.map((c) => (
          <div
            key={c.id}
            className={`history-item ${c.id === props.currentId ? 'active' : ''}`}
            onClick={() => editing !== c.id && props.onOpen(c.id)}
          >
            {editing === c.id ? (
              <input
                className="field"
                value={draft}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(c.id)
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <>
                <span className="title">{c.title}</span>
                <span className="when">{relativeTime(c.updatedAt)}</span>
                <button
                  className="icon-btn"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDraft(c.title)
                    setEditing(c.id)
                  }}
                >
                  <IconEdit />
                </button>
                <button
                  className="icon-btn"
                  title="Export as Markdown"
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.api.exportConversation(c.id)
                  }}
                >
                  <IconDownload />
                </button>
                <button
                  className="icon-btn"
                  title={confirmDelete === c.id ? 'Click again to delete' : 'Delete'}
                  style={confirmDelete === c.id ? { opacity: 1, color: 'var(--danger)' } : undefined}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirmDelete === c.id) {
                      props.onDelete(c.id)
                      setConfirmDelete(null)
                    } else {
                      setConfirmDelete(c.id)
                      setTimeout(() => setConfirmDelete((x) => (x === c.id ? null : x)), 3000)
                    }
                  }}
                >
                  <IconTrash />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
