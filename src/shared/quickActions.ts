// Things you can do with copied text from the selection hotkey.

export interface QuickAction {
  id: string
  label: string
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'explain', label: 'Explain' },
  { id: 'summarize', label: 'Summarize' },
  { id: 'translate', label: 'Translate' },
  { id: 'rewrite', label: 'Rewrite' },
  { id: 'fix', label: 'Fix grammar' },
  { id: 'reply', label: 'Draft a reply' }
]

/** The instruction for an action. `extra` is the target language (translate) or the user's question (ask). */
export function quickActionInstruction(id: string, extra = ''): string | null {
  switch (id) {
    case 'explain':
      return 'Explain this text simply.'
    case 'summarize':
      return 'Summarize this in a few bullet points.'
    case 'translate': {
      const lang = extra || 'English'
      return `Translate this into ${lang}. If it is already in ${lang}, translate it into English instead. Reply with just the translation.`
    }
    case 'rewrite':
      return 'Rewrite this to be clearer and more polished, keeping its meaning and tone. Reply with just the new text.'
    case 'fix':
      return 'Fix the spelling and grammar of this text. Reply with just the corrected text.'
    case 'reply':
      return 'Draft a short, friendly reply to this message.'
    case 'ask':
      return extra || null
    default:
      return null
  }
}
