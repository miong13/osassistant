import { useEffect, useRef, useState } from 'react'
import type { QuickActionsRequest } from '../../../shared/api'
import { QUICK_ACTIONS } from '../../../shared/quickActions'
import type { CharacterInfo, Rect, Settings } from '../../../shared/types'
import { IconBack, IconClose, IconGear, IconHistory, IconMic, IconPaperclip, IconPlus, IconScreen, IconSend, IconStop } from '../lib/icons'
import { type DraftImage, fromBase64, prepareImage, toBase64 } from './images'
import { BubbleFrame } from './BubbleFrame'
import { HistoryPanel } from './HistoryPanel'
import { MessageList } from './MessageList'
import { ModelPicker } from './ModelPicker'
import type { useChat } from './useChat'

const MAX_IMAGES = 4

export function ChatBubble(props: {
  rect: Rect
  side: 'left' | 'right'
  tailY: number
  character: CharacterInfo
  settings: Settings
  chat: ReturnType<typeof useChat>
  focusToken: number
  quickActions: QuickActionsRequest | null
  onCloseQuickActions(): void
  speaking: boolean
  onSpeak(text: string): void
  onTyping(): void
  onClose(): void
}) {
  const { chat, character } = props
  const [showHistory, setShowHistory] = useState(false)
  const [draft, setDraft] = useState('')
  /** True while the composer is editing the last message instead of writing a new one. */
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const [images, setImages] = useState<DraftImage[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)
  const canAttach = !editing && !props.quickActions

  const addImages = async (files: Blob[]) => {
    setAttachError(null)
    const room = MAX_IMAGES - images.length
    if (files.length > room) setAttachError(`You can attach up to ${MAX_IMAGES} images.`)
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        const img = await prepareImage(file)
        setImages((cur) => (cur.length < MAX_IMAGES ? [...cur, img] : cur))
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err))
      }
    }
    input.current?.focus()
  }

  const takeScreenshot = async () => {
    if (images.length >= MAX_IMAGES) return setAttachError(`You can attach up to ${MAX_IMAGES} images.`)
    setAttachError(null)
    setCapturing(true)
    const shot = await window.api.captureScreen()
    setCapturing(false)
    if ('error' in shot) setAttachError(shot.error)
    else setImages((cur) => [...cur, fromBase64(shot)])
    input.current?.focus()
  }

  // ---- voice input: record, then turn speech into text with the chosen service
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)

  const startRecording = async () => {
    setAttachError(null)
    if (!props.settings.voice.transcribeProviderId) {
      setAttachError(
        window.api.platform === 'darwin'
          ? "Voice input isn't set up: choose a speech-to-text service in Settings → General. Or use your Mac's dictation: press the Fn (🌐) key twice."
          : "Voice input isn't set up: choose a speech-to-text service in Settings → General. Or press Win+H to dictate."
      )
      return
    }
    const mic = await window.api.requestMicrophone()
    if (!mic.ok) return setAttachError(mic.message ?? "Can't use the microphone.")
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return setAttachError("Couldn't use the microphone.")
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    const listening = setInterval(props.onTyping, 400) // the character looks like it's listening
    const autoStop = setTimeout(() => rec.state === 'recording' && rec.stop(), 120_000)
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.onstop = async () => {
      clearInterval(listening)
      clearTimeout(autoStop)
      stream.getTracks().forEach((t) => t.stop())
      setRecording(false)
      const blob = new Blob(chunks, { type: rec.mimeType })
      if (blob.size < 2000) return // too short to be speech
      setTranscribing(true)
      try {
        const text = await window.api.transcribe(await toBase64(blob), rec.mimeType)
        if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text))
      } catch (err) {
        setAttachError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      } finally {
        setTranscribing(false)
        input.current?.focus()
      }
    }
    recorder.current = rec
    rec.start()
    setRecording(true)
  }
  const stopRecording = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }
  // Stop recording if the bubble goes away.
  useEffect(() => () => stopRecording(), [])

  // Dropping a file anywhere on the bubble attaches it (and stops Electron from opening the file as a page).
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (files.length && canAttach) void addImages(files)
      else if (e.dataTransfer?.files.length) setAttachError('Only images can be attached.')
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  })

  useEffect(() => {
    if (!showHistory) input.current?.focus()
  }, [props.focusToken, showHistory, chat.state.conversationId])

  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden'
  }, [draft])

  const quick = props.quickActions
  /** Start a new chat with an action on the copied text. */
  const runQuickAction = async (id: string, extra?: string) => {
    if (chat.state.busy) return
    const prompt = await window.api.quickActionPrompt(id, extra)
    if (!prompt) return
    props.onCloseQuickActions()
    await chat.open(null)
    await chat.send(prompt)
  }

  const submit = () => {
    if (quick?.length && draft.trim()) {
      void runQuickAction('ask', draft.trim())
      setDraft('')
      return
    }
    if ((!draft.trim() && !images.length) || chat.state.busy) return
    if (quick) props.onCloseQuickActions()
    void (editing ? chat.editLast(draft) : chat.send(draft, images.map(({ mediaType, data }) => ({ mediaType, data }))))
    setDraft('')
    setEditing(false)
    setImages([])
    setAttachError(null)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
  }

  // Editing belongs to the chat it started in.
  useEffect(() => {
    setEditing(false)
  }, [chat.state.conversationId])

  return (
    <BubbleFrame rect={props.rect} side={props.side} tailY={props.tailY}>
      <div className="bubble-header">
        {showHistory ? (
          <>
            <button className="icon-btn" title="Back" onClick={() => setShowHistory(false)}>
              <IconBack />
            </button>
            <span className="bubble-title" style={{ flex: 1 }}>
              Chats
            </span>
          </>
        ) : (
          <>
            <span className="bubble-title">{character.name}</span>
            <ModelPicker settings={props.settings} />
            <button className="icon-btn" title="New chat" onClick={() => void chat.open(null)}>
              <IconPlus />
            </button>
            <button className="icon-btn" title="Chat history" onClick={() => setShowHistory(true)}>
              <IconHistory />
            </button>
          </>
        )}
        <button className="icon-btn" title="Settings" onClick={() => window.api.openSettings()}>
          <IconGear />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
          <IconClose />
        </button>
      </div>

      {showHistory ? (
        <HistoryPanel
          conversations={chat.state.conversations}
          currentId={chat.state.conversationId}
          onSearch={(q) => void chat.refreshConversations(q || undefined)}
          onOpen={(id) => {
            void chat.open(id)
            setShowHistory(false)
          }}
          onDelete={(id) => void chat.remove(id)}
        />
      ) : (
        <>
          {quick ? (
            <QuickActionsPanel
              request={quick}
              hotkey={props.settings.selectionHotkey}
              busy={chat.state.busy}
              onAction={(id) => void runQuickAction(id, id === 'translate' ? userLanguage() : undefined)}
              onClose={props.onCloseQuickActions}
            />
          ) : (
          <MessageList
            state={chat.state}
            character={character}
            onApprove={chat.approve}
            onDismissError={chat.dismissError}
            onSuggestion={(text) => void chat.send(text)}
            onRetry={() => void chat.retry()}
            speaking={props.speaking}
            onSpeak={props.onSpeak}
            onEdit={(text) => {
              setDraft(text)
              setEditing(true)
              input.current?.focus()
            }}
          />
          )}
          {editing && (
            <div className="edit-banner">
              <span>Editing your last message. Sending replaces it and its answer.</span>
              <button className="btn small" onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          )}
          {(images.length > 0 || attachError) && (
            <div className="draft-images">
              {images.map((img, i) => (
                <div key={i} className="draft-image">
                  <img src={img.url} alt="" />
                  <button title="Remove" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                    <IconClose />
                  </button>
                </div>
              ))}
              {attachError && <span className="error-text attach-error">{attachError}</span>}
            </div>
          )}
          <div className="composer">
            <div className="composer-tools">
              <button
                className={`icon-btn${recording ? ' recording' : ''}`}
                title={recording ? 'Stop and insert text' : transcribing ? 'Turning speech into text…' : 'Talk instead of typing'}
                disabled={transcribing}
                onClick={() => (recording ? stopRecording() : void startRecording())}
              >
                <IconMic />
              </button>
              {canAttach && (
                <>
                <button className="icon-btn" title="Attach an image" onClick={() => filePicker.current?.click()}>
                  <IconPaperclip />
                </button>
                <button
                  className="icon-btn"
                  title="Attach a screenshot of your screen"
                  disabled={capturing}
                  onClick={() => void takeScreenshot()}
                >
                  <IconScreen />
                </button>
                <input
                  ref={filePicker}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  multiple
                  hidden
                  onChange={(e) => {
                    void addImages([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
                </>
              )}
            </div>
            <textarea
              ref={input}
              rows={1}
              value={draft}
              placeholder={
                recording
                  ? 'Listening… click the mic again when you’re done'
                  : transcribing
                    ? 'Turning speech into text…'
                    : quick?.length
                      ? 'Ask something about the copied text…'
                      : `Ask ${character.name} anything…`
              }
              onChange={(e) => {
                setDraft(e.target.value)
                props.onTyping()
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
                if (files.length && canAttach) {
                  e.preventDefault()
                  void addImages(files)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                } else if (e.key === 'Escape') {
                  if (quick) props.onCloseQuickActions()
                  else if (editing) cancelEdit()
                  else props.onClose()
                }
              }}
            />
            {chat.state.busy ? (
              <button className="send-btn" title="Stop" onClick={chat.stop}>
                <IconStop />
              </button>
            ) : (
              <button className="send-btn" title={editing ? 'Save and resend (Enter)' : 'Send (Enter)'} disabled={!draft.trim() && !images.length} onClick={submit}>
                <IconSend />
              </button>
            )}
          </div>
        </>
      )}
    </BubbleFrame>
  )
}

function QuickActionsPanel(props: {
  request: QuickActionsRequest
  hotkey: string
  busy: boolean
  onAction(id: string): void
  onClose(): void
}) {
  const { request } = props
  const keys = props.hotkey.replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ')
  if (!request.length)
    return (
      <div className="quick-actions">
        <div className="quick-head">
          <strong>Nothing copied yet</strong>
          <button className="icon-btn" title="Close" onClick={props.onClose}>
            <IconClose />
          </button>
        </div>
        <p className="muted">
          Select some text in any app and copy it ({window.api.platform === 'darwin' ? '⌘C' : 'Ctrl+C'}), then press{' '}
          <span className="kbd-inline">{keys}</span> again.
        </p>
      </div>
    )
  return (
    <div className="quick-actions">
      <div className="quick-head">
        <strong>Copied text</strong>
        <span className="muted">{request.length.toLocaleString()} characters</span>
        <button className="icon-btn" title="Back to chat (Esc)" onClick={props.onClose}>
          <IconClose />
        </button>
      </div>
      <div className="quick-preview">
        {request.preview}
        {request.length > request.preview.length && '…'}
      </div>
      {request.truncated && <p className="muted">Only the first 20,000 characters will be used.</p>}
      {request.looksSecret && (
        <p className="warn-text">This looks like it may contain a password or key. It will be sent to your AI provider.</p>
      )}
      <div className="suggestions">
        {QUICK_ACTIONS.map((a) => (
          <button key={a.id} disabled={props.busy} onClick={() => props.onAction(a.id)}>
            {a.id === 'translate' ? `Translate to ${userLanguage()}` : a.label}
          </button>
        ))}
      </div>
      <p className="muted quick-hint">Or type a question about it below.</p>
    </div>
  )
}

/** The user's language name in English, e.g. "Spanish", for "Translate to …". */
function userLanguage(): string {
  try {
    const code = navigator.language.split('-')[0]
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? 'English'
  } catch {
    return 'English'
  }
}
