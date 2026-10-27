import { describe, expect, it } from 'vitest'
import { TipEngine, classifyClipboard } from '../src/main/tips/engine'
import { DEFAULT_SETTINGS } from '../src/main/store/settings'
import type { Tip, TipSettings } from '../src/shared/types'

describe('classifyClipboard', () => {
  it('spots error messages', () => {
    expect(classifyClipboard("TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (a.js:1:1)")?.id).toBe('clipboard-error')
  })
  it('spots code', () => {
    expect(classifyClipboard('function add(a, b) {\n  return a + b;\n}\n')?.id).toBe('clipboard-code')
  })
  it('offers to summarize long text', () => {
    expect(classifyClipboard('word '.repeat(200))?.id).toBe('clipboard-long')
  })
  it('ignores short text', () => {
    expect(classifyClipboard('hello')).toBeNull()
  })
})

function engine(opts: { tips?: Partial<TipSettings>; idle?: number; canShow?: boolean } = {}) {
  let now = new Date('2026-10-27T09:00:00').getTime()
  let clipboardText = ''
  const shown: Tip[] = []
  const e = new TipEngine({
    getSettings: () => ({ ...DEFAULT_SETTINGS.tips, ...opts.tips }),
    getCharacterTips: () => ['Character tip'],
    getIdleSeconds: () => opts.idle ?? 0,
    readClipboard: () => clipboardText,
    canShow: () => opts.canShow ?? true,
    show: (t) => shown.push(t),
    now: () => now,
    random: () => 0
  })
  return {
    e,
    shown,
    advance: (min: number) => (now += min * 60_000),
    setClipboard: (t: string) => (clipboardText = t)
  }
}

describe('TipEngine', () => {
  it('greets once per day, then respects the minimum gap', () => {
    const { e, shown, advance } = engine()
    expect(e.tick()?.id).toBe('greeting')
    advance(10)
    expect(e.tick()).toBeNull()
    expect(shown).toHaveLength(1)
  })

  it('reminds about breaks after long activity', () => {
    const { e, advance } = engine({ tips: { greeting: false, randomTips: false, breakAfterMinutes: 60 } })
    advance(61)
    expect(e.tick()?.id).toBe('break')
  })

  it('stays quiet in do-not-disturb, when away, or when the chat is open', () => {
    expect(engine({ tips: { doNotDisturb: true } }).e.tick()).toBeNull()
    expect(engine({ idle: 120 }).e.tick()).toBeNull()
    expect(engine({ canShow: false }).e.tick()).toBeNull()
  })

  it('clipboard: ignores what was there before, reacts to new copies', () => {
    const { e, setClipboard } = engine({ tips: { clipboard: true } })
    setClipboard('Error: ENOENT: no such file or directory, open x')
    expect(e.pollClipboard()).toBeNull()
    setClipboard('Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad')
    expect(e.pollClipboard()?.id).toBe('clipboard-error')
  })

  it('clipboard: does nothing when disabled', () => {
    const { e, setClipboard } = engine({ tips: { clipboard: false } })
    e.pollClipboard()
    setClipboard('Error: something failed badly here')
    expect(e.pollClipboard()).toBeNull()
  })
})
