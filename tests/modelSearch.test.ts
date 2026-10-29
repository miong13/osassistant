import { describe, expect, it } from 'vitest'
import { filterModelGroups, type ModelGroup } from '../src/renderer/src/chat/modelSearch'
import type { ProviderView } from '../src/shared/types'

const provider = (id: string, label: string): ProviderView => ({ id, label, kind: 'openai-compatible', enabled: true, hasApiKey: true })
const groups: ModelGroup[] = [
  {
    provider: provider('anthropic', 'Claude (Anthropic)'),
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
    ]
  },
  {
    provider: provider('openrouter', 'OpenRouter'),
    models: [
      { id: 'meta-llama/llama-4-70b', label: 'meta-llama/llama-4-70b' },
      { id: 'anthropic/claude-haiku-5-5', label: 'anthropic/claude-haiku-5-5' }
    ]
  }
]
const ids = (gs: ModelGroup[]) => gs.flatMap((g) => g.models.map((m) => `${g.provider.id}:${m.id}`))

describe('filterModelGroups', () => {
  it('shows everything for an empty search', () => {
    expect(filterModelGroups(groups, '  ')).toBe(groups)
  })

  it('matches every word, in any order and case', () => {
    expect(ids(filterModelGroups(groups, 'HAIKU claude'))).toEqual([
      'anthropic:claude-haiku-5-5',
      'openrouter:anthropic/claude-haiku-5-5'
    ])
  })

  it('matches the provider name too, and drops empty groups', () => {
    const out = filterModelGroups(groups, 'openrouter llama')
    expect(ids(out)).toEqual(['openrouter:meta-llama/llama-4-70b'])
    expect(out).toHaveLength(1)
  })

  it('returns nothing when nothing matches', () => {
    expect(filterModelGroups(groups, 'gpt')).toEqual([])
  })
})
