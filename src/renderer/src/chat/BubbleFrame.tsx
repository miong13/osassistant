import type { Rect } from '../../../shared/types'

/** A speech-bubble panel with a little tail pointing at the character. */
export function BubbleFrame(props: {
  rect: Rect
  side: 'left' | 'right'
  tailY: number
  className?: string
  children: React.ReactNode
}) {
  const { rect, side } = props
  const tailY = Math.max(20, Math.min(rect.height - 28, props.tailY))
  const tailStyle: React.CSSProperties =
    side === 'left'
      ? { left: rect.width - 9, top: tailY, borderLeft: 'none', borderBottom: 'none' }
      : { left: -7, top: tailY, borderRight: 'none', borderTop: 'none' }
  return (
    <div
      data-interactive
      style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <div className={`bubble ${props.className ?? ''}`} style={{ inset: 0 }}>
        {props.children}
      </div>
      <div className="bubble-tail" style={tailStyle} />
    </div>
  )
}
