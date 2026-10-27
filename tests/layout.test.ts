import { describe, expect, it } from 'vitest'
import { clampToArea, computeLayout } from '../src/main/layout'

const area = { x: 0, y: 25, width: 1440, height: 875 }
const char = (x: number, y: number) => ({ x, y, width: 140, height: 140 })

describe('computeLayout', () => {
  it('closed: window just wraps the character', () => {
    const { bounds, layout } = computeLayout(char(1000, 600), 'closed', area)
    expect(bounds).toEqual({ x: 992, y: 592, width: 156, height: 156 })
    expect(layout.bubble).toBeNull()
  })

  it('opens the bubble on the left when the character is near the right edge', () => {
    const { bounds, layout } = computeLayout(char(1260, 700), 'open', area)
    expect(layout.bubbleSide).toBe('left')
    expect(layout.bubble!.x + layout.bubble!.width).toBeLessThanOrEqual(layout.character.x)
    // character keeps its screen position
    expect(bounds.x + layout.character.x).toBe(1260)
    expect(bounds.y + layout.character.y).toBe(700)
  })

  it('opens on the right when there is no room on the left', () => {
    const { layout } = computeLayout(char(20, 400), 'open', area)
    expect(layout.bubbleSide).toBe('right')
  })

  it('keeps the bubble on screen when the character is near the top', () => {
    const { bounds, layout } = computeLayout(char(800, 30), 'open', area)
    expect(bounds.y + layout.bubble!.y).toBeGreaterThanOrEqual(area.y)
  })

  it('clampToArea keeps the character inside the work area', () => {
    expect(clampToArea({ x: -50, y: 2000 }, { width: 140, height: 140 }, area)).toEqual({ x: 0, y: 760 })
  })
})
