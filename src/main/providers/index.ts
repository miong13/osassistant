import type { ProviderConfig } from '../../shared/types'
import { AnthropicProvider } from './anthropic'
import { OllamaProvider } from './ollama'
import { OpenAICompatibleProvider } from './openaiCompatible'
import type { ChatProvider } from './types'

/** Build a provider client from its settings. Register new provider kinds here. */
export function createProvider(config: ProviderConfig, apiKey: string | undefined): ChatProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(apiKey)
    case 'ollama':
      return new OllamaProvider(config.baseUrl || 'http://localhost:11434')
    case 'openai-compatible':
      if (!config.baseUrl) throw new Error(`${config.label} needs a base URL. Set it in Settings → AI Providers.`)
      return new OpenAICompatibleProvider(config.baseUrl, apiKey, config.extraModels)
  }
}

/**
 * How much chat history (in characters, about 4 per token) to send to a provider. The rest of the
 * context is left for the system prompt, tool definitions and the reply.
 */
export function historyBudget(config: ProviderConfig): number {
  if (config.kind === 'anthropic') return 400_000
  if (config.kind === 'ollama') return 16_000
  // Local servers like LM Studio often run with a small context window.
  return isLocalUrl(config.baseUrl) ? 16_000 : 160_000
}

function isLocalUrl(url: string | undefined): boolean {
  try {
    const host = new URL(url ?? '').hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local')
  } catch {
    return false
  }
}

export type { ChatProvider } from './types'
