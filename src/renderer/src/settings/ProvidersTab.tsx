import { useEffect, useState } from 'react'
import type { ProviderConfig, ProviderView } from '../../../shared/types'
import { Row, StatusText, Switch } from './controls'
import type { TabProps } from './SettingsApp'

const PRESETS: { label: string; baseUrl: string; needsKey: boolean }[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', needsKey: true },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true },
  { label: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', needsKey: true },
  { label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', needsKey: true },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { label: 'Custom', baseUrl: '', needsKey: false }
]

export function ProvidersTab({ settings }: TabProps) {
  const [providers, setProviders] = useState<ProviderView[]>([])

  useEffect(() => {
    void window.api.listProviders().then(setProviders)
  }, [settings.providers])

  const add = async (preset: (typeof PRESETS)[number]) => {
    const p: ProviderConfig = {
      id: `custom-${Date.now().toString(36)}`,
      kind: 'openai-compatible',
      label: preset.label === 'Custom' ? 'Custom provider' : preset.label,
      baseUrl: preset.baseUrl,
      extraModels: [],
      enabled: true
    }
    setProviders(await window.api.saveProvider(p))
  }

  return (
    <>
      <h1>AI Providers</h1>
      <p className="lede">
        Choose which AI services your assistant can use. Pick the active model from the menu at the top of the
        chat bubble.
      </p>
      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          active={settings.activeProviderId === p.id}
          onSaved={setProviders}
        />
      ))}
      <div className="card">
        <div className="card-head">
          <h3 className="grow">Add an OpenAI-compatible service</h3>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {PRESETS.map((p) => (
            <button key={p.label} className="btn" onClick={() => void add(p)}>
              + {p.label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function ProviderCard(props: { provider: ProviderView; active: boolean; onSaved(list: ProviderView[]): void }) {
  const { provider } = props
  const [draft, setDraft] = useState(provider)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState((provider.extraModels ?? []).join(', '))
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setDraft(provider)
    setModels((provider.extraModels ?? []).join(', '))
  }, [provider])

  const usesKey = provider.kind !== 'ollama'
  const usesUrl = provider.kind !== 'anthropic'
  const { hasApiKey: _hasKey, ...config } = draft
  const dirty =
    apiKey !== '' ||
    JSON.stringify({ ...config, extraModels: splitModels(models) }) !==
      JSON.stringify({ ...provider, hasApiKey: undefined, extraModels: provider.extraModels ?? [] })

  const save = async (patch: Partial<ProviderConfig> = {}, key?: string | null) => {
    const next: ProviderConfig = {
      id: draft.id,
      kind: draft.kind,
      label: draft.label,
      baseUrl: draft.baseUrl,
      extraModels: provider.kind === 'openai-compatible' ? splitModels(models) : undefined,
      enabled: draft.enabled,
      ...patch
    }
    props.onSaved(await window.api.saveProvider(next, key))
    setApiKey('')
  }

  const test = async () => {
    if (dirty) await save({}, apiKey || undefined)
    setTesting(true)
    setStatus(await window.api.testProvider(provider.id))
    setTesting(false)
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">
          {provider.label} {props.active && <span className="badge">In use</span>}
        </h3>
        <span className="badge">{provider.kind}</span>
        <Switch label="Enabled" checked={draft.enabled} onChange={(v) => void save({ enabled: v })} />
      </div>
      <div className="form-grid">
        {provider.kind === 'openai-compatible' && (
          <>
            <label>Name</label>
            <input className="field" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </>
        )}
        {usesUrl && (
          <>
            <label>Base URL</label>
            <input
              className="field"
              value={draft.baseUrl ?? ''}
              placeholder={provider.kind === 'ollama' ? 'http://localhost:11434' : 'https://…/v1'}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </>
        )}
        {usesKey && (
          <>
            <label>API key</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="field"
                type="password"
                value={apiKey}
                placeholder={provider.hasApiKey ? '•••••••• saved (type to replace)' : provider.kind === 'anthropic' ? 'sk-ant-…' : 'Optional for local servers'}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {provider.hasApiKey && (
                <button className="btn small" onClick={() => void save({}, null)}>
                  Remove
                </button>
              )}
            </div>
          </>
        )}
        {provider.kind === 'openai-compatible' && (
          <>
            <label>Extra models</label>
            <input
              className="field"
              value={models}
              placeholder="Comma-separated, for services without a model list"
              onChange={(e) => setModels(e.target.value)}
            />
          </>
        )}
      </div>
      {provider.kind === 'anthropic' && (
        <p className="muted" style={{ margin: '10px 0 0' }}>
          Get a key at console.anthropic.com. Without one, the ANTHROPIC_API_KEY environment variable is used if set.
        </p>
      )}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0, alignItems: 'center' }}>
        <button className="btn primary" disabled={!dirty} onClick={() => void save({}, apiKey || undefined)}>
          Save
        </button>
        <button className="btn" disabled={testing} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {provider.kind === 'openai-compatible' && (
          <button className="btn danger" onClick={async () => props.onSaved(await window.api.deleteProvider(provider.id))}>
            Remove provider
          </button>
        )}
        <StatusText status={status} />
      </div>
    </div>
  )
}

function splitModels(s: string): string[] {
  return s
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
}
