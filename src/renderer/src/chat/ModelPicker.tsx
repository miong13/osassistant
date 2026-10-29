import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo, Settings } from '../../../shared/types'
import { type ModelGroup, filterModelGroups, modelKey } from './modelSearch'

/** The model menu in the bubble header: a button that opens a searchable list, grouped by provider. */
export function ModelPicker({ settings }: { settings: Settings }) {
  const [groups, setGroups] = useState<ModelGroup[] | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

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

  const current = modelKey(settings.activeProviderId, settings.activeModel)
  const currentInfo = groups
    ?.find((g) => g.provider.id === settings.activeProviderId)
    ?.models.find((m) => m.id === settings.activeModel)
  const currentProvider = groups?.find((g) => g.provider.id === settings.activeProviderId)?.provider

  const filtered = useMemo(() => filterModelGroups(groups ?? [], query), [groups, query])
  /** Every selectable row in display order, for the arrow keys. */
  const flat = useMemo(
    () => filtered.flatMap((g) => g.models.map((m) => ({ provider: g.provider, model: m }))),
    [filtered]
  )

  // Start on the current model; after typing, on the first match.
  useEffect(() => {
    if (!open) return
    const i = query ? 0 : flat.findIndex((r) => modelKey(r.provider.id, r.model.id) === current)
    setHighlight(Math.max(0, i))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  // Keep the highlighted row in view.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  // Click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const choose = (providerId: string, modelId: string) => {
    void window.api.updateSettings({ activeProviderId: providerId, activeModel: modelId })
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!flat.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((h) => (h + step + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = flat[highlight]
      if (row) choose(row.provider.id, row.model.id)
    } else if (e.key === 'Escape') {
      // Close the menu only, not the whole chat bubble.
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  const label = currentInfo?.label ?? (settings.activeModel || 'Choose a model')
  let index = 0

  return (
    <div className="model-picker" ref={root}>
      <button
        className="model-select"
        title={currentProvider ? `${currentProvider.label} · ${label}` : label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="model-select-label">{label}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="model-menu" onKeyDown={onKeyDown}>
          <input
            className="model-search"
            autoFocus
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search models"
          />
          <div className="model-list" ref={list} role="listbox">
            {groups === null && <div className="model-empty">Loading models…</div>}
            {groups !== null && query && !flat.length && <div className="model-empty">No models match “{query}”.</div>}
            {filtered.map((g) => (
              <div key={g.provider.id}>
                <div className="model-group">{g.provider.label}</div>
                {/* Providers with nothing to list explain why (search hides them). */}
                {g.models.length === 0 && (
                  <div className="model-empty">
                    {g.provider.kind === 'anthropic' && !g.provider.hasApiKey
                      ? 'Add an API key in Settings'
                      : 'No models found'}
                  </div>
                )}
                {g.models.map((m) => {
                  const i = index++
                  const selected = modelKey(g.provider.id, m.id) === current
                  return (
                    <div
                      key={m.id}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      className={`model-option${i === highlight ? ' active' : ''}${selected ? ' selected' : ''}`}
                      title={m.id}
                      onMouseMove={() => i !== highlight && setHighlight(i)}
                      onClick={() => choose(g.provider.id, m.id)}
                    >
                      <span className="model-option-label">{m.label}</span>
                      {selected && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <path d="m5 12 5 5 9-10" />
                        </svg>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
