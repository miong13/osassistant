import type { BubbleMode, Layout, Rect } from '../shared/types'

export const BUBBLE_SIZE: Record<Exclude<BubbleMode, 'closed'>, { width: number; height: number }> = {
  open: { width: 390, height: 560 },
  tip: { width: 270, height: 150 }
}
const GAP = 6
const PAD = 8

/**
 * Work out the window bounds (screen coords) and where the character and bubble sit
 * inside the window. The character stays put; the bubble goes on whichever side has room.
 */
export function computeLayout(
  character: Rect,
  mode: BubbleMode,
  workArea: Rect
): { bounds: Rect; layout: Layout } {
  if (mode === 'closed') {
    return {
      bounds: {
        x: character.x - PAD,
        y: character.y - PAD,
        width: character.width + PAD * 2,
        height: character.height + PAD * 2
      },
      layout: {
        mode,
        character: { x: PAD, y: PAD, width: character.width, height: character.height },
        bubble: null,
        bubbleSide: 'left'
      }
    }
  }

  const size = BUBBLE_SIZE[mode]
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  const spaceRight = right - (character.x + character.width)
  const spaceLeft = character.x - workArea.x
  const need = size.width + GAP
  const side: 'left' | 'right' =
    spaceLeft >= need ? 'left' : spaceRight >= need ? 'right' : spaceLeft >= spaceRight ? 'left' : 'right'

  let bx = side === 'right' ? character.x + character.width + GAP : character.x - GAP - size.width
  // Bubble's bottom lines up with the character's lower half, then is kept on screen.
  let by = character.y + character.height * 0.7 - size.height
  bx = clamp(bx, workArea.x, right - size.width)
  by = clamp(by, workArea.y, bottom - size.height)
  const bubble: Rect = { x: bx, y: by, width: size.width, height: size.height }

  const minX = Math.min(character.x, bubble.x) - PAD
  const minY = Math.min(character.y, bubble.y) - PAD
  const maxX = Math.max(character.x + character.width, bubble.x + bubble.width) + PAD
  const maxY = Math.max(character.y + character.height, bubble.y + bubble.height) + PAD
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }

  return {
    bounds: roundRect(bounds),
    layout: {
      mode,
      character: roundRect({ ...character, x: character.x - minX, y: character.y - minY }),
      bubble: roundRect({ ...bubble, x: bubble.x - minX, y: bubble.y - minY }),
      bubbleSide: side
    }
  }
}

/** Keep the character fully inside the work area. */
export function clampToArea(pos: { x: number; y: number }, size: { width: number; height: number }, area: Rect) {
  return {
    x: Math.round(clamp(pos.x, area.x, area.x + area.width - size.width)),
    y: Math.round(clamp(pos.y, area.y, area.y + area.height - size.height))
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}
