import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickActionsRequest } from '../../../shared/api'
import type { CharacterInfo, Layout, Settings, Tip } from '../../../shared/types'
import { ChatBubble } from '../chat/ChatBubble'
import { TipBubble } from '../chat/TipBubble'
import { useChat } from '../chat/useChat'
import { answerText, splitTurns } from '../chat/turns'
import { speak, stopSpeaking } from '../lib/speech'
import { CharacterView } from './CharacterView'
import { useCharacterState } from './useCharacterState'

const DRAG_THRESHOLD = 4

export function CharacterApp() {
  const [layout, setLayout] = useState<Layout | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [characters, setCharacters] = useState<CharacterInfo[]>([])
  const [tip, setTip] = useState<Tip | null>(null)
  const [lastTypedAt, setLastTypedAt] = useState(0)
  const [lastInteractionAt, setLastInteractionAt] = useState(Date.now())
  const [focusToken, setFocusToken] = useState(0)
  const [quickActions, setQuickActions] = useState<QuickActionsRequest | null>(null)
  const [speaking, setSpeaking] = useState(false)
  /** Last time a word was spoken, so the character's mouth moves while reading aloud. */
  const [spokeAt, setSpokeAt] = useState(0)
  const wasBusy = useRef(false)
  const chat = useChat()
  const pendingPrompt = useRef<string | null>(null)

  useClickThrough()

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
    void window.api.getLayout().then((l) => l && setLayout((cur) => cur ?? l))
    void window.api.listCharacters().then((r) => setCharacters(r.characters))
    const offs = [
      window.api.onLayout(setLayout),
      window.api.onSettings((s) => {
        setSettings(s)
        void window.api.listCharacters().then((r) => setCharacters(r.characters))
      }),
      window.api.onTip(setTip),
      window.api.onNewChat(() => void chat.open(null)),
      window.api.onQuickActions(setQuickActions),
      window.api.onOpenBubble(({ focus, prompt }) => {
        setLastInteractionAt(Date.now())
        if (focus) setFocusToken((n) => n + 1)
        if (prompt) pendingPrompt.current = prompt
      })
    ]
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Quick actions belong to one opening of the bubble; closing it also stops reading aloud.
  useEffect(() => {
    if (layout?.mode !== 'open') {
      setQuickActions(null)
      stopSpeaking()
      setSpeaking(false)
    }
  }, [layout?.mode])

  const readAloud = useCallback(
    (text: string) => {
      setSpeaking(true)
      void speak(text, {
        voiceName: settings?.voice.voiceName,
        rate: settings?.voice.rate,
        onWord: () => setSpokeAt(Date.now()),
        onEnd: () => setSpeaking(false)
      })
    },
    [settings?.voice.voiceName, settings?.voice.rate]
  )
  const toggleSpeak = useCallback(
    (text: string) => {
      if (speaking) {
        stopSpeaking()
        setSpeaking(false)
      } else readAloud(text)
    },
    [speaking, readAloud]
  )

  // A new question stops reading; a finished answer is read aloud if that's turned on.
  useEffect(() => {
    const busy = chat.state.busy
    if (busy && !wasBusy.current) {
      stopSpeaking()
      setSpeaking(false)
    }
    if (!busy && wasBusy.current && settings?.voice.readAloud && !chat.state.error) {
      const turns = splitTurns(chat.state.messages)
      const answer = answerText(turns[turns.length - 1])
      if (answer) readAloud(answer)
    }
    wasBusy.current = busy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.state.busy])

  // A tip the user accepted starts a fresh chat with its prompt.
  useEffect(() => {
    const prompt = pendingPrompt.current
    if (prompt && layout?.mode === 'open') {
      pendingPrompt.current = null
      void chat.open(null).then(() => chat.send(prompt))
    }
  }, [layout, chat])

  const character = characters.find((c) => c.id === settings?.characterId) ?? characters[0]
  const state = useCharacterState({
    mode: layout?.mode ?? 'closed',
    busy: chat.state.busy,
    thinking: chat.state.thinking,
    lastDeltaAt: Math.max(chat.state.lastDeltaAt, spokeAt),
    lastTypedAt,
    error: chat.state.error,
    hasApproval: chat.state.approvals.length > 0,
    lastInteractionAt
  })

  const toggleBubble = useCallback(() => {
    setLastInteractionAt(Date.now())
    if (layout?.mode === 'open') void window.api.setBubble('closed')
    else void window.api.setBubble('open')
  }, [layout])

  const drag = useDrag(toggleBubble)

  if (!layout || !character) return null
  const tailY = layout.bubble ? layout.character.y + layout.character.height * 0.4 - layout.bubble.y : 0

  return (
    <div className="stage">
      {layout.bubble && layout.mode === 'open' && settings && (
        <ChatBubble
          rect={layout.bubble}
          side={layout.bubbleSide}
          tailY={tailY}
          character={character}
          settings={settings}
          chat={chat}
          focusToken={focusToken}
          quickActions={quickActions}
          speaking={speaking}
          onSpeak={toggleSpeak}
          onCloseQuickActions={() => setQuickActions(null)}
          onTyping={() => {
            setLastTypedAt(Date.now())
            setLastInteractionAt(Date.now())
          }}
          onClose={() => void window.api.setBubble('closed')}
        />
      )}
      {layout.bubble && layout.mode === 'tip' && tip && (
        <TipBubble
          rect={layout.bubble}
          side={layout.bubbleSide}
          tailY={tailY}
          tip={tip}
          onAccept={() => window.api.acceptTip(tip)}
          onDismiss={() => window.api.dismissTip()}
        />
      )}
      <div
        className="character"
        data-interactive
        title={`${character.name} – click to chat, drag to move`}
        style={{
          left: layout.character.x,
          top: layout.character.y,
          width: layout.character.width,
          height: layout.character.height
        }}
        {...drag}
      >
        <CharacterView character={character} state={state} />
      </div>
    </div>
  )
}

/**
 * The window is transparent and ignores the mouse except over elements marked
 * data-interactive, so clicks on empty areas go through to the apps underneath.
 */
function useClickThrough() {
  useEffect(() => {
    let ignoring = true
    let dragging = false
    const set = (ignore: boolean) => {
      if (ignore !== ignoring) {
        ignoring = ignore
        window.api.setIgnoreMouse(ignore)
      }
    }
    const onMove = (e: MouseEvent) => {
      if (dragging) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      set(!el?.closest('[data-interactive]'))
    }
    const onDown = () => (dragging = true)
    const onUp = () => (dragging = false)
    const onLeave = () => !dragging && set(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [])
}

/** Drag the character to move the window; a click without movement toggles the chat. */
function useDrag(onClick: () => void) {
  const start = useRef<{ x: number; y: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      start.current = { x: e.screenX, y: e.screenY, lastX: e.screenX, lastY: e.screenY, moved: false }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current
      if (!s) return
      if (!s.moved && Math.hypot(e.screenX - s.x, e.screenY - s.y) < DRAG_THRESHOLD) return
      s.moved = true
      const dx = e.screenX - s.lastX
      const dy = e.screenY - s.lastY
      if (dx || dy) window.api.dragBy(dx, dy)
      s.lastX = e.screenX
      s.lastY = e.screenY
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = start.current
      start.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
      if (!s) return
      if (s.moved) window.api.dragEnd()
      else onClick()
    }
  }
}
