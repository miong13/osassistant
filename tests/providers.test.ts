import { describe, expect, it } from 'vitest'
import { chatModelFilter } from '../src/main/providers/openaiCompatible'

const usableIds = (url: string, ids: string[]) => ids.map(chatModelFilter(url)!).filter(Boolean)

describe('chatModelFilter', () => {
  it('keeps only chat-completions models on OpenCode', () => {
    const ids = ['glm-5.3', 'kimi-k3', 'qwen3.8-max', 'claude-opus-5-5', 'gpt-6-sol', 'big-pickle', 'glm-5.3-flash-free']
    for (const url of ['https://opencode.ai/zen/v1', 'https://opencode.ai/zen/go/v1']) {
      expect(usableIds(url, ids)).toEqual(['glm-5.3', 'kimi-k3', 'qwen3.8-max'])
    }
  })

  it('keeps Gemini chat models and drops the "models/" prefix', () => {
    const ids = [
      'models/gemini-3.8-flash',
      'models/gemini-3.1-pro',
      'models/gemini-embedding-001',
      'models/gemini-2.5-flash-image',
      'models/gemini-2.5-flash-preview-tts',
      'models/imagen-4.0-generate-001',
      'models/gemma-3-27b-it',
      'gemini-3.5-flash-lite'
    ]
    expect(usableIds('https://generativelanguage.googleapis.com/v1beta/openai/', ids)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.1-pro',
      'gemini-3.5-flash-lite'
    ])
  })

  it('keeps every model on other services', () => {
    expect(chatModelFilter('https://openrouter.ai/api/v1')).toBeNull()
    expect(chatModelFilter('not a url')).toBeNull()
  })
})
