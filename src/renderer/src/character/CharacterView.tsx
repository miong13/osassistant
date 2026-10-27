import { motion, type TargetAndTransition } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { CharacterInfo, CharacterState, StateAsset } from '../../../shared/types'

/** If a pack doesn't have a state, try these next (idle is always last). */
const FALLBACKS: Record<CharacterState, CharacterState[]> = {
  idle: [],
  greet: ['talk'],
  listen: [],
  think: [],
  talk: [],
  tip: ['greet', 'talk'],
  sleep: [],
  error: ['think']
}

export function resolveAsset(character: CharacterInfo, state: CharacterState): StateAsset {
  for (const s of [state, ...FALLBACKS[state]]) {
    const asset = character.states[s]
    if (asset) return asset
  }
  return character.states.idle
}

/** Extra whole-body motion on top of each pack's own animation. */
const MOTION: Partial<Record<CharacterState, TargetAndTransition>> = {
  tip: { y: [0, -10, 0, -5, 0], transition: { duration: 0.9, repeat: Infinity, repeatDelay: 2.2 } },
  error: { x: [0, -5, 5, -4, 4, 0], transition: { duration: 0.45 } },
  listen: { rotate: -3, transition: { type: 'spring', stiffness: 200, damping: 15 } },
  greet: { scale: [1, 1.06, 1], transition: { duration: 0.5 } }
}
const REST: TargetAndTransition = { x: 0, y: 0, rotate: 0, scale: 1, transition: { duration: 0.3 } }

export function CharacterView({ character, state }: { character: CharacterInfo; state: CharacterState }) {
  const asset = resolveAsset(character, state)
  return (
    <motion.div className="character-motion" animate={MOTION[state] ?? REST}>
      {asset.type === 'image' ? (
        <img src={asset.src} alt={character.name} draggable={false} />
      ) : (
        <Sprite asset={asset} />
      )}
    </motion.div>
  )
}

function Sprite({ asset }: { asset: Extract<StateAsset, { type: 'sprite' }> }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    setFrame(0)
    const t = setInterval(() => setFrame((f) => (f + 1) % asset.frames), 1000 / asset.fps)
    return () => clearInterval(t)
  }, [asset])
  return (
    <div
      className="sprite"
      style={{
        backgroundImage: `url("${asset.src}")`,
        backgroundSize: `${asset.frames * 100}% 100%`,
        backgroundPosition: `${asset.frames > 1 ? (frame / (asset.frames - 1)) * 100 : 0}% 0`
      }}
    />
  )
}
