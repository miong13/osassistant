// Reading answers aloud with the system's voices (Web Speech API; works offline on macOS and Windows).

/** Markdown to something pleasant to hear: no symbols, code blocks summarized, links as their text. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  const voices = speechSynthesis.getVoices()
  if (voices.length) return Promise.resolve(voices)
  // Voices load asynchronously the first time.
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1000)
  })
}

let current: SpeechSynthesisUtterance | null = null

export function isSpeaking(): boolean {
  return current !== null
}

export async function speak(
  markdown: string,
  opts: { voiceName?: string; rate?: number; onWord?(): void; onEnd?(): void } = {}
): Promise<void> {
  stopSpeaking()
  const text = toSpeakable(markdown)
  if (!text) return
  const u = new SpeechSynthesisUtterance(text)
  const voice = opts.voiceName ? (await listVoices()).find((v) => v.name === opts.voiceName) : undefined
  if (voice) u.voice = voice
  u.rate = Math.min(2, Math.max(0.5, opts.rate ?? 1))
  u.onboundary = () => opts.onWord?.()
  const finish = () => {
    if (current === u) current = null
    opts.onEnd?.()
  }
  u.onend = finish
  u.onerror = finish
  current = u
  speechSynthesis.speak(u)
}

export function stopSpeaking(): void {
  current = null
  speechSynthesis.cancel()
}
