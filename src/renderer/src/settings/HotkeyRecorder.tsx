import { useState } from 'react'

const isMac = window.api.platform === 'darwin'

/** Turn a key event into an Electron accelerator string, or null if it isn't a usable shortcut. */
export function toAccelerator(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, mac = isMac): string | null {
  let key: string | null = null
  const c = e.code
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Digit\d$/.test(c)) key = c.slice(5)
  else if (/^F\d{1,2}$/.test(c)) key = c
  else if (c === 'Space') key = 'Space'
  else if (c.startsWith('Arrow')) key = c.slice(5)
  else if (c === 'Enter') key = 'Enter'
  else if (c === 'Backquote') key = '`'
  else if (c === 'Slash') key = '/'
  else if (c === 'Period') key = '.'
  else if (c === 'Comma') key = ','
  else if (c === 'Semicolon') key = ';'
  if (!key) return null
  const mods: string[] = []
  if (e.metaKey) mods.push(mac ? 'Command' : 'Super')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (!mods.length && !/^F\d/.test(key)) return null
  return [...mods, key].join('+')
}

export function prettyAccelerator(a: string): string {
  if (!isMac) return a.replace(/\+/g, ' + ')
  return a
    .replace(/Command\+?|CmdOrCtrl\+?/g, '⌘')
    .replace(/Control\+?/g, '⌃')
    .replace(/Alt\+?|Option\+?/g, '⌥')
    .replace(/Shift\+?/g, '⇧')
}

export function HotkeyRecorder(props: { value: string; onChange(accelerator: string): void }) {
  const [recording, setRecording] = useState(false)
  return (
    <button
      className={`kbd ${recording ? 'recording' : ''}`}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return
        e.preventDefault()
        if (e.key === 'Escape') return setRecording(false)
        const acc = toAccelerator(e.nativeEvent)
        if (acc) {
          setRecording(false)
          props.onChange(acc)
        }
      }}
    >
      {recording ? 'Press keys…' : prettyAccelerator(props.value)}
    </button>
  )
}
