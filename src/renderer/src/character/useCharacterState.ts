import { useEffect, useState } from 'react'
import type { BubbleMode, CharacterState } from '../../../shared/types'

const SLEEP_AFTER_MS = 5 * 60_000
const TALK_HOLD_MS = 700
const GREET_MS = 1600
const ERROR_MS = 2500
const LISTEN_HOLD_MS = 1500

export interface CharacterSignals {
  mode: BubbleMode
  busy: boolean
  thinking: boolean
  lastDeltaAt: number
  lastTypedAt: number
  error: string | null
  hasApproval: boolean
  /** Bumps whenever the user interacts (clicks, types), to wake from sleep. */
  lastInteractionAt: number
}

/** Map what the app is doing to an animation state. */
export function pickState(s: CharacterSignals, openedAt: number, errorAt: number, now: number): CharacterState {
  if (s.error && now - errorAt < ERROR_MS) return 'error'
  if (s.mode === 'tip') return 'tip'
  if (s.lastDeltaAt && now - s.lastDeltaAt < TALK_HOLD_MS) return 'talk'
  if (s.busy || s.thinking || s.hasApproval) return 'think'
  if (s.mode === 'open' && now - openedAt < GREET_MS) return 'greet'
  if (s.mode === 'open' && now - s.lastTypedAt < LISTEN_HOLD_MS) return 'listen'
  if (s.mode === 'closed' && now - s.lastInteractionAt > SLEEP_AFTER_MS) return 'sleep'
  return 'idle'
}

export function useCharacterState(signals: CharacterSignals): CharacterState {
  const [now, setNow] = useState(Date.now())
  const [openedAt, setOpenedAt] = useState(0)
  const [errorAt, setErrorAt] = useState(0)

  useEffect(() => {
    if (signals.mode === 'open') setOpenedAt(Date.now())
  }, [signals.mode])

  useEffect(() => {
    if (signals.error) setErrorAt(Date.now())
  }, [signals.error])

  // Re-evaluate often enough for talk/listen timeouts to settle back to idle.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])

  return pickState(signals, openedAt, errorAt, Math.max(now, signals.lastDeltaAt, signals.lastTypedAt))
}
