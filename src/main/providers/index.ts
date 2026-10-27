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

export type { ChatProvider } from './types'
