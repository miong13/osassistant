import OpenAI, { toFile } from 'openai'
import type { ProviderConfig } from '../shared/types'

/** Speech-to-text model to use when the user hasn't picked one, by service. */
export function defaultTranscribeModel(baseUrl: string | undefined): string {
  const host = hostOf(baseUrl)
  if (host === 'api.groq.com') return 'whisper-large-v3-turbo'
  return 'whisper-1'
}

/** Services known to offer OpenAI's /audio/transcriptions endpoint. */
export function canTranscribe(config: ProviderConfig): boolean {
  if (config.kind !== 'openai-compatible') return false
  const host = hostOf(config.baseUrl)
  return host === 'api.openai.com' || host === 'api.groq.com' || host === 'localhost' || host === '127.0.0.1'
}

const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav'
}
/** About 2 minutes of compressed speech is well under this. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024

/** Turn recorded speech into text with an OpenAI-compatible service. */
export async function transcribe(opts: {
  config: ProviderConfig
  apiKey: string | undefined
  model: string
  audio: unknown
  mimeType: unknown
}): Promise<string> {
  const type = String(opts.mimeType ?? '').split(';')[0]
  const ext = AUDIO_TYPES[type]
  if (!ext) throw new Error('Unsupported audio format.')
  if (typeof opts.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(opts.audio)) throw new Error('Invalid audio.')
  const bytes = Buffer.from(opts.audio, 'base64')
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('That recording is too long.')
  if (!opts.config.baseUrl) throw new Error('The voice input provider has no base URL.')
  const client = new OpenAI({ baseURL: opts.config.baseUrl, apiKey: opts.apiKey || 'not-needed' })
  const result = await client.audio.transcriptions.create({
    file: await toFile(bytes, `speech.${ext}`, { type }),
    model: opts.model || defaultTranscribeModel(opts.config.baseUrl)
  })
  return result.text.trim()
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname
  } catch {
    return ''
  }
}
