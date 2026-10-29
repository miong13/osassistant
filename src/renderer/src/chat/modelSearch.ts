import type { ModelInfo, ProviderView } from '../../../shared/types'

export interface ModelGroup {
  provider: ProviderView
  models: ModelInfo[]
}

/** Words in the query must all appear in the model's name, id or provider (any order, any case). */
export function filterModelGroups(groups: ModelGroup[], query: string): ModelGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return groups
  return groups
    .map((g) => ({
      provider: g.provider,
      models: g.models.filter((m) => {
        const haystack = `${m.label} ${m.id} ${g.provider.label}`.toLowerCase()
        return words.every((w) => haystack.includes(w))
      })
    }))
    .filter((g) => g.models.length > 0)
}

export const modelKey = (providerId: string, modelId: string) => `${providerId}::${modelId}`
