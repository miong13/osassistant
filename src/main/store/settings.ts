import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '../../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Alt+Space',
  showDockIcon: false,
  launchAtLogin: false,
  autoUpdate: true,
  characterId: 'sticky',
  activeProviderId: 'anthropic',
  activeModel: 'claude-opus-5-5',
  effort: 'low',
  providers: [
    { id: 'anthropic', kind: 'anthropic', label: 'Claude (Anthropic)', enabled: true },
    {
      id: 'ollama',
      kind: 'ollama',
      label: 'Ollama (local)',
      baseUrl: 'http://localhost:11434',
      enabled: true
    }
  ],
  mcpServers: [],
  toolPermissions: {},
  tips: {
    enabled: true,
    doNotDisturb: false,
    minMinutesBetween: 30,
    greeting: true,
    breakReminder: true,
    breakAfterMinutes: 60,
    clipboard: false,
    randomTips: true
  },
  characterPositions: {}
}

/** Fill in any fields missing from an older or hand-edited settings file. */
export function withDefaults(partial: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    tips: { ...DEFAULT_SETTINGS.tips, ...(partial.tips ?? {}) },
    providers: partial.providers?.length ? partial.providers : DEFAULT_SETTINGS.providers,
    mcpServers: partial.mcpServers ?? [],
    toolPermissions: partial.toolPermissions ?? {},
    characterPositions: partial.characterPositions ?? {}
  }
}

export class SettingsStore extends EventEmitter {
  private data: Settings

  constructor(private file: string) {
    super()
    this.data = this.load()
  }

  private load(): Settings {
    try {
      if (existsSync(this.file)) return withDefaults(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (err) {
      console.error('Could not read settings, using defaults:', err)
    }
    return withDefaults({})
  }

  get(): Settings {
    return this.data
  }

  update(patch: Partial<Settings>): Settings {
    this.data = withDefaults({ ...this.data, ...patch })
    this.save()
    this.emit('change', this.data)
    return this.data
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}
