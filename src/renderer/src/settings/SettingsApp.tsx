import { useEffect, useState } from 'react'
import type { SettingsPatch } from '../../../shared/api'
import type { Effort, Settings, UpdateStatus } from '../../../shared/types'
import { CharactersTab } from './CharactersTab'
import { Row, StatusText, Switch } from './controls'
import { HotkeyRecorder } from './HotkeyRecorder'
import { McpTab } from './McpTab'
import { ProvidersTab } from './ProvidersTab'

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'AI Providers' },
  { id: 'mcp', label: 'Tools' },
  { id: 'characters', label: 'Characters' },
  { id: 'tips', label: 'Tips' },
  { id: 'about', label: 'About' }
]

export function SettingsApp({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState(TABS.some((t) => t.id === initialTab) ? initialTab! : 'general')
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    document.title = 'OS Assistant Settings'
    void window.api.getSettings().then(setSettings)
    const offs = [window.api.onSettings(setSettings), window.api.onSettingsTab(setTab)]
    return () => offs.forEach((o) => o())
  }, [])

  const update = async (patch: SettingsPatch) => setSettings(await window.api.updateSettings(patch))

  if (!settings) return null
  return (
    <div className="settings">
      <nav className="settings-nav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        {tab === 'general' && <GeneralTab settings={settings} update={update} />}
        {tab === 'providers' && <ProvidersTab settings={settings} update={update} />}
        {tab === 'mcp' && <McpTab settings={settings} update={update} />}
        {tab === 'characters' && <CharactersTab settings={settings} update={update} />}
        {tab === 'tips' && <TipsTab settings={settings} update={update} />}
        {tab === 'about' && <AboutTab />}
      </main>
    </div>
  )
}

export interface TabProps {
  settings: Settings
  update(patch: SettingsPatch): Promise<void>
}

const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Low – fastest replies' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High – more careful' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max – slowest, most thorough' }
]

function GeneralTab({ settings, update }: TabProps) {
  const [hotkeyStatus, setHotkeyStatus] = useState<{ ok: boolean; message: string } | null>(null)
  return (
    <>
      <h1>General</h1>
      <p className="lede">How your assistant starts and how you call it up.</p>
      <div className="card">
        <Row
          label="Global hotkey"
          hint={
            <>
              Opens or closes the chat from any app. <StatusText status={hotkeyStatus} />
            </>
          }
        >
          <HotkeyRecorder
            value={settings.hotkey}
            onChange={async (accelerator) => {
              const check = await window.api.checkHotkey(accelerator)
              setHotkeyStatus(check)
              if (check.ok) await update({ hotkey: accelerator })
            }}
          />
        </Row>
        <Row label="Launch at login" hint="Start the assistant when you log in (packaged app only).">
          <Switch checked={settings.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
        </Row>
        <Row label="Check for updates automatically" hint="Looks for new versions on GitHub every few hours.">
          <Switch checked={settings.autoUpdate} onChange={(v) => void update({ autoUpdate: v })} />
        </Row>
        {window.api.platform === 'darwin' && (
          <Row label="Show in Dock" hint="Off keeps the assistant in the menu bar only.">
            <Switch checked={settings.showDockIcon} onChange={(v) => void update({ showDockIcon: v })} />
          </Row>
        )}
        <Row label="Thinking effort (Claude)" hint="How much Claude thinks before answering.">
          <select
            className="field"
            style={{ width: 230 }}
            value={settings.effort}
            onChange={(e) => void update({ effort: e.target.value as Effort })}
          >
            {EFFORTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </>
  )
}

function TipsTab({ settings, update }: TabProps) {
  const tips = settings.tips
  const set = (patch: Partial<Settings['tips']>) => void update({ tips: { ...tips, ...patch } })
  return (
    <>
      <h1>Tips</h1>
      <p className="lede">Your character can pop up now and then with a greeting, a reminder, or a helpful tip.</p>
      <div className="card">
        <Row label="Show tips">
          <Switch checked={tips.enabled} onChange={(v) => set({ enabled: v })} />
        </Row>
        <Row label="Do not disturb" hint="Pause all tips for now.">
          <Switch checked={tips.doNotDisturb} onChange={(v) => set({ doNotDisturb: v })} />
        </Row>
        <Row label="Minimum time between tips" hint="In minutes.">
          <input
            className="field"
            type="number"
            min={5}
            max={480}
            style={{ width: 90 }}
            value={tips.minMinutesBetween}
            onChange={(e) => set({ minMinutesBetween: Math.max(5, Number(e.target.value) || 30) })}
          />
        </Row>
      </div>
      <div className="card">
        <Row label="Daily greeting" hint="Say hello the first time you're active each day.">
          <Switch checked={tips.greeting} onChange={(v) => set({ greeting: v })} />
        </Row>
        <Row label="Break reminders" hint="Suggest a break after a long stretch of activity.">
          <Switch checked={tips.breakReminder} onChange={(v) => set({ breakReminder: v })} />
        </Row>
        {tips.breakReminder && (
          <Row label="Remind me after" hint="Minutes of continuous activity.">
            <input
              className="field"
              type="number"
              min={15}
              max={240}
              style={{ width: 90 }}
              value={tips.breakAfterMinutes}
              onChange={(e) => set({ breakAfterMinutes: Math.max(15, Number(e.target.value) || 60) })}
            />
          </Row>
        )}
        <Row label="Random tips" hint="Occasional computer and productivity tips.">
          <Switch checked={tips.randomTips} onChange={(v) => set({ randomTips: v })} />
        </Row>
        <Row
          label="Clipboard helper"
          hint="When you copy an error message, code, or a long text, offer to explain or summarize it. Nothing is sent anywhere unless you click Yes."
        >
          <Switch checked={tips.clipboard} onChange={(v) => set({ clipboard: v })} />
        </Row>
      </div>
    </>
  )
}

function AboutTab() {
  return (
    <>
      <h1>About</h1>
      <p className="lede">
        OS Assistant {__APP_VERSION__}. A desktop character you can chat with, powered by Claude, local Ollama models, or
        any OpenAI-compatible service. It can open your apps, files and websites, and use tools from MCP servers.
      </p>
      <div className="card">
        <Row label="Your data">
          <span className="muted">Chats, settings and character packs are stored on this computer only.</span>
        </Row>
        <Row label="API keys">
          <span className="muted">Encrypted with your system keychain.</span>
        </Row>
      </div>
      <UpdatesCard />
    </>
  )
}

function UpdatesCard() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    void window.api.getUpdateStatus().then(setStatus)
    return window.api.onUpdateStatus(setStatus)
  }, [])

  const text = describeUpdate(status)
  const busy = status.state === 'checking' || status.state === 'downloading'
  return (
    <div className="card">
      <Row label="Updates" hint={text}>
        {status.state === 'ready' ? (
          <button className="btn primary" onClick={() => window.api.installUpdate()}>
            Restart to update
          </button>
        ) : (status.state === 'available' && status.manual) || status.state === 'error' ? (
          <button className="btn primary" onClick={() => window.api.openReleasesPage()}>
            Open download page
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || status.state === 'unsupported'}
            onClick={() => void window.api.checkForUpdates().then(setStatus)}
          >
            {busy ? 'Checking…' : 'Check now'}
          </button>
        )}
      </Row>
    </div>
  )
}

function describeUpdate(s: UpdateStatus): string {
  switch (s.state) {
    case 'unsupported':
      return s.message ?? 'Updates are not available in this build.'
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return "You're on the latest version."
    case 'available':
      return s.manual
        ? `Version ${s.version} is available. Download it from the releases page and replace the app.`
        : `Version ${s.version} is available.`
    case 'downloading':
      return `Downloading version ${s.version ?? ''}… ${s.percent ?? 0}%`
    case 'ready':
      return `Version ${s.version} is ready. Restart to finish updating.`
    case 'error':
      return s.message ?? 'Checking for updates failed.'
    default:
      return 'New versions are checked for automatically.'
  }
}
