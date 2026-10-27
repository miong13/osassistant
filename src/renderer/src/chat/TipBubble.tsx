import type { Rect, Tip } from '../../../shared/types'
import { BubbleFrame } from './BubbleFrame'

export function TipBubble(props: {
  rect: Rect
  side: 'left' | 'right'
  tailY: number
  tip: Tip
  onAccept(): void
  onDismiss(): void
}) {
  return (
    <BubbleFrame rect={props.rect} side={props.side} tailY={props.tailY} className="tip">
      <div className="tip-text">{props.tip.text}</div>
      <div className="tip-actions">
        <button className="btn small" onClick={props.onDismiss}>
          {props.tip.prompt ? 'No thanks' : 'Got it'}
        </button>
        <button className="btn small primary" onClick={props.onAccept}>
          {props.tip.prompt ? 'Yes, please' : 'Open chat'}
        </button>
      </div>
    </BubbleFrame>
  )
}
