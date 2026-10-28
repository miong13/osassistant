import { describe, expect, it } from 'vitest'
import { withDefaults } from '../src/main/store/settings'
import { canTranscribe, defaultTranscribeModel, transcribe } from '../src/main/transcribe'
import { toSpeakable } from '../src/renderer/src/lib/speech'
import type { ProviderConfig } from '../src/shared/types'

const provider = (baseUrl: string, kind: ProviderConfig['kind'] = 'openai-compatible'): ProviderConfig => ({
  id: 'p',
  kind,
  label: 'P',
  baseUrl,
  enabled: true
})

describe('voice input', () => {
  it('offers services that have a transcription endpoint', () => {
    expect(canTranscribe(provider('https://api.openai.com/v1'))).toBe(true)
    expect(canTranscribe(provider('https://api.groq.com/openai/v1'))).toBe(true)
    expect(canTranscribe(provider('https://openrouter.ai/api/v1'))).toBe(false)
    expect(canTranscribe(provider('https://generativelanguage.googleapis.com/v1beta/openai/'))).toBe(false)
    expect(canTranscribe(provider('http://localhost:11434', 'ollama'))).toBe(false)
  })

  it('picks a sensible default model per service', () => {
    expect(defaultTranscribeModel('https://api.groq.com/openai/v1')).toBe('whisper-large-v3-turbo')
    expect(defaultTranscribeModel('https://api.openai.com/v1')).toBe('whisper-1')
  })

  it('checks the recording before sending it anywhere', async () => {
    const base = { config: provider('https://api.openai.com/v1'), apiKey: 'k', model: '' }
    await expect(transcribe({ ...base, audio: 'AAAA', mimeType: 'video/mp4' })).rejects.toThrow(/Unsupported audio/)
    await expect(transcribe({ ...base, audio: 'not base64!', mimeType: 'audio/webm' })).rejects.toThrow(/Invalid audio/)
    const huge = Buffer.alloc(11 * 1024 * 1024).toString('base64')
    await expect(transcribe({ ...base, audio: huge, mimeType: 'audio/webm;codecs=opus' })).rejects.toThrow(/too long/)
  })

  it('has voice settings for older settings files', () => {
    expect(withDefaults({}).voice).toMatchObject({ readAloud: false, rate: 1, transcribeProviderId: '' })
    expect(withDefaults({ voice: { readAloud: true } as never }).voice.rate).toBe(1)
  })
})

describe('toSpeakable', () => {
  it('reads Markdown without the symbols', () => {
    expect(toSpeakable('## Steps\n\n- **Open** the [settings](https://x.y)\n- Run `npm test`')).toBe(
      'Steps\nOpen the settings\nRun npm test'
    )
  })

  it("doesn't read code blocks or URLs out", () => {
    expect(toSpeakable('Try this:\n```js\nconst a = 1\n```\nSee https://example.com/long/path')).toBe(
      'Try this:\n (code block) \nSee link'
    )
  })
})
