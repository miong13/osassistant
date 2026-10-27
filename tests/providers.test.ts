import { describe, expect, it } from 'vitest'
import { chatModelFilter } from '../src/main/providers/openaiCompatible'

describe('chatModelFilter', () => {
  it('keeps only chat-completions models on OpenCode', () => {
    const ids = ['glm-5.3', 'kimi-k3', 'qwen3.8-max', 'claude-opus-5-5', 'gpt-6-sol', 'big-pickle', 'glm-5.3-flash-free']
    for (const url of ['https://opencode.ai/zen/v1', 'https://opencode.ai/zen/go/v1']) {
      const usable = chatModelFilter(url)
      expect(ids.filter((id) => usable!(id))).toEqual(['glm-5.3', 'kimi-k3', 'qwen3.8-max'])
    }
  })

  it('keeps every model on other services', () => {
    expect(chatModelFilter('https://openrouter.ai/api/v1')).toBeNull()
    expect(chatModelFilter('not a url')).toBeNull()
  })
})
