import { useEffect, useState } from 'react'
import type { MemoryItem } from '../../../shared/types'
import { IconTrash } from '../lib/icons'
import { Row, Switch } from './controls'
import type { TabProps } from './SettingsApp'

export function MemoryTab({ settings, update }: TabProps) {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    void window.api.listMemory().then(setItems)
    return window.api.onMemory(setItems)
  }, [])

  const run = async (action: () => Promise<MemoryItem[]>) => {
    setError(null)
    try {
      setItems(await action())
      return true
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      return false
    }
  }

  const add = async () => {
    if (draft.trim() && (await run(() => window.api.addMemory(draft)))) setDraft('')
  }

  return (
    <>
      <h1>Memory</h1>
      <p className="lede">
        Facts your assistant remembers across chats, like your name, your job, or how you like answers. They're
        stored on this computer and sent to your AI provider with each message.
      </p>
      <div className="card">
        <Row label="Remember things about me" hint="The assistant saves facts when you share them or ask it to remember something.">
          <Switch checked={settings.memoryEnabled} onChange={(v) => void update({ memoryEnabled: v })} />
        </Row>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="grow">
            Saved facts <span className="muted">({items.length})</span>
          </h3>
          {items.length > 0 &&
            (confirmClear ? (
              <>
                <span className="muted">Delete all {items.length}?</span>
                <button
                  className="btn small danger"
                  onClick={() => {
                    setConfirmClear(false)
                    void run(() => window.api.clearMemory())
                  }}
                >
                  Forget everything
                </button>
                <button className="btn small" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn small" onClick={() => setConfirmClear(true)}>
                Forget everything
              </button>
            ))}
        </div>
        {items.length === 0 && (
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            {settings.memoryEnabled ? 'Nothing yet. Tell your assistant something about yourself, or add a fact below.' : 'Nothing saved.'}
          </p>
        )}
        <ul className="memory-list">
          {items.map((m) => (
            <li key={m.id}>
              <span className="grow">{m.text}</span>
              <span className="muted">{new Date(m.createdAt).toLocaleDateString()}</span>
              <button className="icon-btn" title="Forget this" onClick={() => void run(() => window.api.removeMemory(m.id))}>
                <IconTrash />
              </button>
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <input
            className="field"
            style={{ flex: 1 }}
            placeholder='Add a fact, e.g. "I prefer short answers"'
            value={draft}
            maxLength={300}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button className="btn" disabled={!draft.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
        {error && <p className="error-text" style={{ margin: '8px 0 0' }}>{error}</p>}
      </div>
    </>
  )
}
